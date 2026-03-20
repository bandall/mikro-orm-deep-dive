# pluglink-backend 적용 액션 플랜

> mikro-orm-test 프로젝트에서 104개 테스트로 검증한 결과를 바탕으로,
> 기존 pluglink-backend에 적용해야 할 작업 목록.

## 발견된 근본 원인: TsMorphMetadataProvider + 패키지 엔티티

### 문제

`TsMorphMetadataProvider`를 사용할 때, `BaseEntity`를 빌드된 npm 패키지(`@plug-link/commons`)에서 import하면 **dirty checking이 조용히 실패**한다.

- TsMorph은 TypeScript **소스 파일**을 파싱하여 `@PrimaryKey()`, `@Property()` 데코레이터 정보를 추출
- 빌드된 패키지의 `.d.ts`에는 데코레이터 정보가 없고, `.js`에는 `__decorate` 런타임 호출만 존재
- → `BaseEntity`의 `id`, `createdAt`, `updatedAt` 등의 메타데이터가 누락
- → `ChangeSetComputer`가 변경을 감지하지 못함 → UPDATE SQL 미생성

### 검증

| 조건 | dirty checking |
|------|---------------|
| `BaseEntity`/`BaseRepository`를 `@plug-link/commons`에서 import | **실패** — UPDATE 없음 |
| `BaseEntity`/`BaseRepository`를 로컬 TypeScript 소스로 변경 | **성공** — UPDATE 정상 |
| `@Transactional()`/`TransactionalExplorer`를 `@plug-link/commons`에서 import | **성공** — 메타데이터와 무관 |

→ **엔티티 메타데이터만 영향을 받음**. 트랜잭션/DI 관련 코드는 패키지에서 import해도 무방.

### 해결 방안

| 방법 | 장점 | 단점 |
|------|------|------|
| **A. 엔티티를 로컬 소스로 유지** | 즉시 해결, 간단 | 서비스 간 BaseEntity 중복 |
| **B. 패키지에 TypeScript 소스 포함** | 중복 없음 | TsMorph 소스 경로 설정 필요, 패키지 크기 증가 |
| **C. reflect-metadata 기반 메타데이터** | 빌드 형태 무관 | MikroORM 설정 변경 필요 |

**권장**: 단기적으로 **A**, 장기적으로 **B** 또는 **C**.

---

## 현재 상태 요약

| 항목 | 현재 | 목표 |
|------|------|------|
| `allowGlobalContext` | 미설정 (기본값) | `false` |
| `BaseRepository.save()` | `em.persist(entity)` — 상태 판별 없음 | 상태별 분기 (managed/detached/new) |
| `BaseRepository.delete()` | soft delete만 (`isDeleted: true`) | soft delete + hard delete + batch delete |
| `TransactionalExplorer` | 없음 | 도입 |
| `@Transactional()` 사용 | 12개 파일 | em 주입 방식 정비 |
| `em.merge()` 사용 | 없음 (안전) | — |
| `nativeDelete` 사용 | managements, roamings | Identity Map 주의사항 인지 |

---

## 1. `allowGlobalContext: false` 설정

### 왜?

현재 미설정이므로 글로벌 EM을 직접 사용해도 에러가 나지 않는다. RequestContext나 `@Transactional()` 없이 `this.em.find()`를 호출하면 **모든 요청이 같은 Identity Map을 공유**하는 치명적 버그가 발생할 수 있다.

### 작업

모든 서비스의 `database.module.ts`에 추가:

```typescript
MikroOrmModule.forRootAsync({
  useFactory: (config) => ({
    ...config.getAll().database,
    allowGlobalContext: false,  // ← 추가
    registerRequestContext: true,
    // ...
  }),
})
```

**대상 파일** (6개):
- `roamings/src/database/database.module.ts`
- `chargers/src/database/database.module.ts`
- `managements/src/database/database.module.ts`
- `users/src/database/database.module.ts`
- `payments/src/database/database.module.ts`
- `apps/src/database/database.module.ts`

### 주의

`registerRequestContext: true`가 이미 설정되어 있으므로 HTTP 요청 내에서는 문제없다. 하지만 **cron, SQS consumer 등 HTTP 밖**에서 EM을 사용하는 코드가 있다면 `RequestContext.create()` 또는 `em.fork()`로 감싸야 한다.

점검 대상:
- `roamings/src/scheduling/` — 스케줄러/워커 (cron 기반)
- SQS consumer 코드

---

## 2. `BaseRepository.save()` 개선

### 현재 문제

```typescript
// 현재 — 상태 판별 없이 무조건 persist
@Transactional()
async save(entity: T): Promise<void> {
  this.em.persist(entity);
}
```

| 상황 | 기대 | 실제 |
|------|------|------|
| 새 엔티티 | INSERT | ✅ INSERT |
| managed 엔티티 | UPDATE (dirty checking) | ❌ persist 중복 호출 (무해하지만 불필요) |
| detached 엔티티 | UPDATE | ❌ INSERT 시도 → PK 충돌 에러 |

### 목표

```typescript
@Transactional()
async save(entity: T): Promise<T> {
  // ⚠️ this.em은 EntityRepository 생성자에서 할당된 raw property (global EM).
  // getContext(false)로 현재 트랜잭션 컨텍스트의 fork EM을 가져와야
  // entity.__em === em 비교가 정상 동작한다.
  const em = (this.em as any).getContext(false) as typeof this.em;
  const wrapped = helper(entity);

  // managed → dirty checking에 맡김
  if (wrapped.__managed && wrapped.__em === em) {
    return entity;
  }

  // new (PK 없음)
  if (!wrapped.hasPrimaryKey()) {
    em.persist(entity);
    return entity;
  }

  // detached (DB에서 로드된 적 있음) → JPA-style merge
  if (wrapped.__originalEntityData) {
    const managed = await em.findOne(this.entityName, wrapped.getPrimaryKey() as any);
    if (!managed) { em.persist(entity); return entity; }
    wrap(managed).assign(entity as any);
    return managed;
  }

  // new (수동 PK)
  em.persist(entity);
  return entity;
}
```

### 근거

- `em.merge()`는 MikroORM에서 `__originalEntityData`를 현재 값으로 덮어쓰므로 dirty checking이 불가능. Spring Hibernate의 `merge()`와 다름.
- Detached 엔티티는 JPA-style로 처리: `findOne()`으로 DB에서 managed 엔티티를 읽고, `wrap().assign()`으로 값을 복사한 뒤 dirty checking으로 변경된 컬럼만 UPDATE.
- 이전 구현의 `em.upsert()`는 전체 컬럼 덮어쓰기 + `GENERATED ALWAYS` 컬럼 비호환 문제가 있었음.
- 테스트 12-1~12-4, 13-1~13-2에서 검증 완료.

---

## 3. `BaseRepository` 삭제 메서드 보강

### 현재

```typescript
async delete(entity: T): Promise<void> {
  wrap(entity).assign({ isDeleted: true } as never);
  await this.em.flush();
}
```

soft delete만 지원. hard delete, batch delete 없음.

### 추가할 메서드

```typescript
// --- Soft Delete (기존) ---
async softDelete(entity: T): Promise<void> {
  wrap(entity).assign({ isDeleted: true } as never);
  await this.em.flush();
}

async softDeleteById(id: Primary<T>): Promise<void> {
  const entity = await this.findOneOrFail(id as FilterQuery<T>);
  wrap(entity).assign({ isDeleted: true } as never);
  await this.em.flush();
}

// --- Hard Delete ---
async hardDelete(entity: T): Promise<void> {
  this.em.remove(entity);
  await this.em.flush();
}

async hardDeleteById(id: Primary<T>): Promise<void> {
  const entity = await this.findOneOrFail(id as FilterQuery<T>);
  this.em.remove(entity);
  await this.em.flush();
}

// --- Batch Delete ---
async softDeleteAll(entities: T[]): Promise<void> {
  for (const entity of entities) {
    wrap(entity).assign({ isDeleted: true } as never);
  }
  await this.em.flush();
}

async hardDeleteAllByIds(ids: Primary<T>[]): Promise<number> {
  return this.nativeDelete({ id: { $in: ids } } as any);
}
```

### 설계 포인트

- `delete()` → `softDelete()`로 **이름 변경** (의도 명확화). 기존 `delete()` 호출부 일괄 변경 필요.
- hard delete 메서드에 `@Transactional()` 붙이지 않음 — caller의 EM 컨텍스트에서 실행. 이유: `@Transactional()`이 새 fork를 만들면 외부 엔티티의 remove가 무시됨. Spring은 `merge()`로 해결하지만 MikroORM `merge()`는 동작이 다름.
- `hardDeleteAllByIds()`는 `nativeDelete`로 단일 쿼리. Identity Map과 동기화 안 됨.
- 테스트 13-4, 13-8~13-9에서 검증 완료.

---

## 4. `TransactionalExplorer` 도입

### 왜?

`@Transactional()`은 내부적으로 `this.em`에 접근한다. 서비스에서 `em`을 생성자로 주입받지 않으면 데코레이터가 동작하지 않는다.

현재 managements의 서비스들은 `em`을 직접 주입받아 사용 중이므로 문제없지만, 향후 서비스가 늘어나면 누락될 수 있다.

### 구현

```typescript
// commons/src/database/mikro-orm/transactional.decorator.ts
export const TRANSACTIONAL_KEY = Symbol('TRANSACTIONAL');

export function Transactional(options?: TransactionOptions): MethodDecorator {
  return (target, key, descriptor) => {
    SetMetadata(TRANSACTIONAL_KEY, true)(target.constructor);
    return MikroTransactional(options)(target, key, descriptor);
  };
}
```

```typescript
// commons/src/database/mikro-orm/transactional-explorer.service.ts
@Injectable()
export class TransactionalExplorer implements OnModuleInit {
  constructor(
    private discoveryService: DiscoveryService,
    private reflector: Reflector,
    private em: EntityManager,
  ) {}

  onModuleInit(): void {
    for (const wrapper of this.discoveryService.getProviders()) {
      if (!wrapper.instance || (wrapper.instance as any).em) continue;
      const meta = this.reflector.get(TRANSACTIONAL_KEY, wrapper.instance.constructor);
      if (!meta) continue;
      Object.defineProperty(wrapper.instance, 'em', {
        value: this.em,
        writable: false,
      });
    }
  }
}
```

### 효과

- `@Transactional()` 사용 서비스에서 `em`을 생성자에 명시하지 않아도 자동 주입
- ESLint 규칙 추가 가능: `@Transactional()` 사용 클래스에 `em` 프로퍼티가 없으면 경고
- 테스트 11-1~11-5에서 검증 완료

---

## 5. `@Transactional()` + try-catch 패턴 점검

### 핵심 차이 (Spring vs MikroORM)

```
Spring:  inner @Transactional throw → catch해도 rollback (rollback-only 마킹)
MikroORM: inner @Transactional throw → catch하면 commit (마킹 메커니즘 없음)
```

### 현재 프로젝트 점검 결과

현재 try-catch가 있는 곳:

| 파일 | catch 내용 | 위험도 |
|------|-----------|--------|
| `projects.service.ts:93` | SNS 외부 호출 실패 → 로깅 | ✅ 안전 (DB TX 밖) |
| `contracts.service.ts:328` | SNS 외부 호출 실패 → 로깅 | ✅ 안전 (flush 이후) |
| `schedule-orchestrator.service.ts:39` | job 생성 실패 → 로깅 후 다음 진행 | ✅ 안전 (각 job이 독립 TX) |
| `schedule-orchestrator.service.ts:53` | task dispatch 실패 → 로깅 후 다음 진행 | ✅ 안전 (각 job이 독립 TX) |

**현재는 위험한 패턴이 없다.** 하지만 향후 개발 시 주의:

```typescript
// ⚠️ 이런 패턴 금지 — MikroORM에서는 inner 데이터가 commit됨
@Transactional()
async riskyMethod() {
  await this.createOrder();        // flush 발생
  try {
    await this.chargePayment();    // @Transactional, 내부에서 throw
  } catch {
    // Spring이면 전체 rollback
    // MikroORM에선 order가 commit됨!
  }
}
```

### 가이드라인

1. `@Transactional()` 안에서 다른 `@Transactional()` 메서드를 try-catch로 감싸지 않는다
2. 부분 실패를 허용해야 한다면, 별도 fork EM에서 실행한다
3. 외부 API 호출(SNS, HTTP)은 flush 이후에 배치한다 (현재 패턴이 이미 올바름)

---

## 6. `nativeDelete` / `nativeUpdate` Identity Map 주의

### 현재 사용처

**managements — nativeDelete** (hard delete):
- `projects.repository.ts` — task, history, image 삭제
- `projects.service.ts` — 프로젝트 전체 삭제 (cascade 대신 수동)
- `partners.repository.ts` — 파트너 관련 엔티티 삭제

**roamings — nativeUpdate** (원자적 카운터):
- `job.repository.ts` — `successTasks + 1`, `failTasks + 1`

### 주의사항

`nativeDelete` / `nativeUpdate`는 Identity Map을 거치지 않으므로:

```
nativeDelete 후 → 같은 EM에서 find → Identity Map에 캐시된 삭제된 엔티티 반환 가능
nativeUpdate 후 → 같은 EM에서 find → 업데이트 전 값이 반환될 수 있음
```

### 현재 위험도

| 사용처 | 같은 EM에서 재조회? | 위험도 |
|--------|-------------------|--------|
| `projects.service.ts` deleteProject | `em.transactional` 안에서 연속 nativeDelete | ✅ 안전 (재조회 없음) |
| `projects.service.ts` deleteTask | 동일 | ✅ 안전 |
| `partners.repository.ts` | @Transactional 안에서 nativeDelete 후 새 엔티티 persist | ✅ 안전 (삭제된 엔티티 재조회 안 함) |
| `job.repository.ts` increment | 카운터 증가 후 같은 job 조회 가능성 | ⚠️ 주의 필요 |

### 권장

`nativeUpdate` 이후 같은 엔티티를 조회해야 한다면 `em.refresh(entity)` 호출. 또는 새 fork에서 조회.

---

## 7. Lazy Loading 인식

### Spring과의 차이

```
Spring:  author.getBooks() → Hibernate 프록시가 자동 SELECT
MikroORM: author.books.getItems() → Error: Collection not initialized
```

### 현재 프로젝트 점검

`registerRequestContext: true`로 HTTP 요청마다 fork EM이 생성되므로, 요청 내에서 `populate` 없이 Collection에 접근하면 에러가 발생한다.

### 가이드라인

```typescript
// ❌ populate 없이 Collection 접근 — 런타임 에러
const partner = await em.findOne(PartnerEntity, id);
partner.bankAccounts.getItems();  // Error!

// ✅ populate으로 명시적 로드
const partner = await em.findOne(PartnerEntity, id, {
  populate: ['bankAccounts'],
});
partner.bankAccounts.getItems();  // OK

// ✅ 또는 나중에 명시적 init
await partner.bankAccounts.init();

// ManyToOne — PK는 접근 가능, 다른 필드는 불가
const task = await em.findOne(ProjectTaskEntity, id);
task.project.id;    // ✅ FK이므로 접근 가능
task.project.name;  // ❌ undefined
```

---

## 8. commons 배포 순서

위 변경사항 중 commons에 들어가는 것:

1. `BaseRepository` 개선 (save 상태 판별, 삭제 메서드 추가)
2. `TransactionalExplorer` + 커스텀 `@Transactional()` 데코레이터
3. (선택) 커스텀 ESLint 규칙

### 배포 단계

```
1. commons에서 BaseRepository, TransactionalExplorer 구현
2. commons 버전 bump + GitHub Packages 배포
3. 각 서비스에서 commons 업데이트
4. 각 서비스 database.module.ts에 allowGlobalContext: false 추가
5. 각 서비스 database.module.ts에 TransactionalExplorer 등록
6. 기존 delete() → softDelete() 호출부 일괄 변경
7. 테스트 실행 + 검증
```

---

## 우선순위

| 순서 | 작업 | 영향도 | 위험도 |
|------|------|--------|--------|
| 1 | `allowGlobalContext: false` | 높음 — 잠재적 Identity Map 공유 버그 방지 | 중 — cron/worker 코드 점검 필요 |
| 2 | `BaseRepository.save()` 개선 | 중 — detached 엔티티 시나리오 대응 | 낮 — 기존 동작 유지 |
| 3 | 삭제 메서드 보강 | 중 — hard delete, batch delete 지원 | 낮 — 신규 메서드 추가 |
| 4 | `TransactionalExplorer` | 낮 (현재 문제 없음) — 향후 안전장치 | 낮 |
| 5 | `@Transactional()` + catch 가이드라인 | 낮 (현재 위험 패턴 없음) — 문서화 | — |

---

[← mikro-orm-test 문서 목차](./README.md)
