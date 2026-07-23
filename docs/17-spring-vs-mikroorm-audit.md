# 17. Spring JPA vs MikroORM 전수 감사 — pluglink-backend 현황과 해결책

> 작성일: 2026-07-21. 조사 방식: deep-dive 문서(01~16, 부록 A/B) 인용 + mikro-orm-test 샌드박스 실증(이번에 실행한 스펙 15/16/17/18 = 34개 전부 통과, 스펙 18은 신규 작성) + roamings·managements·users 3개 서비스 read-only 전수 스캔.
> 모든 주장은 [문서], [스펙], `file:line` 중 하나 이상으로 뒷받침한다. 추측인 곳은 "불확실"로 명시.

---

## 1. 요약

### 한 문장 요약

**Spring JPA에서 몸에 밴 "save() 하면 id가 생기고, 트랜잭션 안에서 방금 쓴 걸 다시 읽을 수 있다"는 두 가지 직관이 MikroORM + commons `BaseRepository.save()`에서는 조건부로만 성립하며, 그 조건(바깥 @Transactional 유무·EM fork 소속)이 코드에 보이지 않아 테스트를 통과하고 프로덕션에서 터진다.**

### 최상위 리스크 5개

| # | 리스크 | Spring과의 차이 | 실증 | 상태 |
|---|--------|----------------|------|------|
| 1 | **`save(new)` 직후 `entity.id` = undefined** (바깥 @Transactional 안에서) | Spring IDENTITY는 `save()` 즉시 INSERT → id 확보. MikroORM commons save Case2는 `persist`만 하고 flush 없음. 바깥 TX가 없으면 자체 TX 종료 flush로 id가 생겨 **비대칭**(테스트에선 통과, 프로덕션에서만 실패) | [스펙17 C-1/C-3], [스펙15-officials] | **프로덕션 장애 발생**(2026-07-21, managements 5종) |
| 2 | **EM fork-split → save()가 upsert로 오폭** | Spring은 스레드당 1개 영속성 컨텍스트라 "소속 어긋남" 자체가 없음. MikroORM은 @Transactional마다 fork + `mergeEntitiesToParent`가 `__em`을 부모로 박아 Case1 가드가 깨짐 → Case3 upsert → PG IDENTITY 에러 | [doc 15/16], [스펙15-1], [스펙18-1] | roamings 2곳 봉합, commons 근본 픽스 미적용(잠복) |
| 3 | **inner @Transactional 예외를 catch하면 commit** | Spring은 rollback-only 마킹 → `UnexpectedRollbackException`. MikroORM은 마킹 메커니즘 없음 → outer가 catch하면 inner가 flush한 데이터까지 commit | [doc 04 §4.5], [테스트 12-2] | 기존 점검(doc99 §5)에서 managements try-catch 4곳 전부 안전(외부 API 실패 로깅) 판정. 이번 스캔 축엔 미포함 — 가이드라인(§5.2-3)으로 신규 유입 차단 |
| 4 | **em.merge()는 JPA merge가 아니다** | Hibernate merge = DB SELECT → managed 복사본. MikroORM merge = 스냅샷을 현재 값으로 덮어씀 → dirty checking 불능(UPDATE 소실) | [doc 02 §2.5, 12 §12.4] | 3개 서비스 사용 0건(§3) — 금지 규칙으로 못박을 것 |
| 5 | **Lazy 자동 로딩 없음 + nativeUpdate는 Identity Map·훅 우회** | Hibernate 프록시는 접근 시 자동 SELECT / MikroORM은 `Collection not initialized` 에러, ManyToOne 필드 undefined. nativeUpdate 후 같은 EM 재조회는 stale, `onUpdate`(updatedAt) 훅 미작동 | [doc 09 §9.4, 07 §7.4], [테스트 7-8, 9-1], [스펙18-1 updatedAt=null] | 사용처별 주의(§3) |

### 해결 방향 (요약)

- **commons 레벨(근본)**: `BaseRepository.save()` 2줄 수술 — ① Case2/4(신규)에 `await em.flush()` 추가(Spring IDENTITY parity), ② Case1 가드를 `__em` 포인터 → **UoW 멤버십**으로(fork-split 면역). 두 수정 모두 이 감사에서 신규 스펙 18로 실증 완료(8/8 PASS — 원자성·기존 동작 보존·users 패턴 치유 포함). 이 한 번의 수정이 §4의 P1(managements 5종)·P2(users 6곳)·P3 상당수를 동시에 봉합한다. → §5.1
- **서비스 레벨(관행)**: 신규 INSERT 후 id가 필요하면 관계 대입 또는 flush 선행, loaded 엔티티는 dirty-flush(save 금지), `@Transactional` + try-catch 조합 금지. → §5.2

---

## 2. 차이 매트릭스 — 10축

표기: [docN] = `mikro-orm-test/docs/N-*.md`, [T n-n] = 부록 B 테스트, [S17/S18] = 이 감사에서 실행/작성한 스펙.

### 축 1. id 생성 & persist/flush 타이밍

| | Spring JPA (Hibernate) | MikroORM v7 |
|---|---|---|
| IDENTITY 신규 저장 | `persist()` 즉시 INSERT 실행 → **id 즉시 확보** (write-behind 예외) | `persist()`는 UoW 등록만, SQL 없음. **flush 시점에 INSERT → id 할당** [doc03 §3.1] |
| "persist 즉시 INSERT" 설정 | 필요 없음(IDENTITY 자체가 그렇게 동작) | **존재하지 않음.** `FlushMode.ALWAYS`조차 "쿼리 발생 시"에만 flush — persist 시점 트리거는 없음 [S17 A-1 실측] |
| 근사 수단 | — | `em.persist + em.flush()`(UoW 전체 flush) 또는 `em.insert()`(targeted 단건 즉시 INSERT — 단, 반환 엔티티가 **unmanaged**라 이후 dirty checking 불가) |

**함정**: `task.id`처럼 "값 접근"은 auto-flush의 개입 지점이 아니다. `FlushMode.AUTO`는 **쿼리** 전에만, 그것도 **persist로 등록된 pending + 타입 overlap**일 때만 flush한다 [doc03 §3.4], [S17 A-3: 값 접근은 구제 불가 실측, A-4: 무관 타입 쿼리는 flush 안 함].

### 축 2. save() 시맨틱

| | Spring `JpaRepository.save()` | commons `BaseRepository.save()` (`base.repository.ts:7-31`) |
|---|---|---|
| 분기 | `isNew ? em.persist : em.merge` | Case1 managed(`__em` 포인터 일치) → no-op / Case2 PK 없음 → `persist`(**flush 없음**) / Case3 detached → `em.upsert` / Case4 수동 PK → `persist` |
| 신규 저장 후 id | **항상 있음** (IDENTITY 즉시 INSERT) | 바깥 @Transactional 있으면 **undefined**(REQUIRED join → flush는 바깥 커밋 때) / 없으면 자체 TX 종료 flush로 **있음** — **비대칭** [S17 C-1 vs C-3] |
| detached 저장 | merge = SELECT + 변경 컬럼만 UPDATE, 훅 정상 | upsert = `INSERT..ON DUPLICATE`(**전체 컬럼**, `onCreate/onUpdate` 훅 우회, **PG GENERATED ALWAYS에서 에러**) [doc15 §15.7, doc16 §16.3, MikroORM #7399] |
| saveAndFlush | 있음 | 없음 (flush 노출 안 됨 — 서비스는 `repo.getEntityManager().flush()` 또는 별도 헬퍼 사용) |

**함정(비대칭의 정체)**: `save()` 자체에 `@Transactional()`(REQUIRED)이 붙어 있어, 단독 호출 테스트에서는 자체 TX 종료 flush로 id가 채워진다. 바깥에 @Transactional이 있는 실제 서비스 경로에서만 join → flush 생략 → id undefined. **단위 테스트가 이 버그를 원리적으로 못 잡는다.**

### 축 3. flush 범위 & 더티체킹

| | Spring JPA | MikroORM |
|---|---|---|
| flush 범위 | 영속성 컨텍스트 전체 | **UoW 전체** — 동일. 신규 INSERT만이 아니라 **무관한 dirty 엔티티의 UPDATE도 함께** 나간다 [S17 C-4 실측] |
| 쿼리 전 auto-flush | `FlushModeType.AUTO`: dirty UPDATE 포함 전부 flush | `FlushMode.AUTO`: **persist로 등록된 변경 + 쿼리 타입 overlap일 때만**. dirty UPDATE는 auto-flush 대상 아님 [doc03 §3.4], [T 3-4] |
| UPDATE 문 | 기본 전체 컬럼(dynamic-update 옵션) | **변경된 필드만** SET [doc08 §8.2], [T 5-1] |
| 감지 실패 케이스 | — | `disableIdentityMap` 조회, `em.merge` 후, JSON 필드 내부 변경(참조 동일) [doc08 §8.6], **TsMorph + 빌드된 패키지의 부모 엔티티**(조용한 실패) [doc08 Case0] — pluglink는 BaseEntity를 각 서비스 로컬 소스로 유지해 회피 중 (`roamings/src/database/base.entity.ts:7-9` 주석) |

### 축 4. @Transactional

| | Spring | MikroORM (commons 래퍼) |
|---|---|---|
| 전파 | REQUIRED 기본, REQUIRES_NEW/NESTED 등 | 동일 세트 지원 [doc04 §4.3]. NESTED는 savepoint + 종료 시 flush [S17 D-1] |
| rollback | 예외 시 자동 | 동일 [T 2-2] |
| **rollback-only** | **inner throw → catch해도 rollback** (`UnexpectedRollbackException`) | **없음 — catch하면 정상 commit.** inner가 flush한 데이터도 살아남음 [doc04 §4.5], [T 12-2/12-3] (4케이스 중 Case B만 다름, A/C/D는 동일 [T 12-1~12-5]) |
| readOnly | Hibernate flush 억제 + 드라이버 힌트 | **DB 레벨** `SET TRANSACTION READ ONLY` — INSERT/UPDATE를 DB가 거부 [doc05 §5.1], [T 11-2/11-3] |
| EM 확보 | AOP 프록시가 ThreadLocal에서 자동 | **`this.em` 필수.** commons 래퍼가 `TRANSACTIONAL_KEY` 메타데이터를 남기고 `TransactionalExplorer`가 부팅 시 em을 런타임 부착 (`transactional.decorator.ts:11-16`, `transactional-explorer.service.ts:21-38`) |

**함정 2개**:
1. **감지 누락**: `@mikro-orm/*`에서 `Transactional`을 직접 import하면 `TRANSACTIONAL_KEY` 마킹이 없어 Explorer가 em을 안 붙여줌 → 런타임 에러 또는 (RC 폴백 시) 의도와 다른 동작. 실제 사례: roamings `sales.service` — commons로 교체하는 수정 커밋 `4b7997d2`.
2. **Explorer 미등록 서비스**: managements/roamings는 `database.module.ts` providers에 `TransactionalExplorer` 등록(각 `:41`, `:43`), **users는 미등록**(`users/src/database/database.module.ts` providers에 없음 — 직접 확인). users에서 @Transactional을 쓰는 클래스는 생성자 em 주입이 없으면 동작하지 않는다. §3 스캔 참조.

또한 3개 서비스 모두 `registerRequestContext: true`이며, `allowGlobalContext`는 roamings만 명시(`false`) — 단 **v7 기본값이 false**(`@mikro-orm/core/utils/Configuration.js:32` 확인)라 미명시(managements/users)도 동일하게 안전하다. (doc99 §1의 "미설정=위험"은 구식 서술.)

### 축 5. EntityManager fork / RequestContext / fork-split

| | Spring | MikroORM |
|---|---|---|
| 컨텍스트 격리 | ThreadLocal — 트랜잭션 동안 단일 영속성 컨텍스트 | 글로벌 EM은 **프록시**, `getContext()`로 현재 fork에 위임 [doc01 §1.4]. HTTP는 RequestContext 미들웨어가 fork, @Transactional은 **매번 새 fork**(기존 TX 없을 때) [doc04 Step4] |
| "소속" 개념 | 없음(컨텍스트 하나) | `entity.__em` 포인터. 커밋 시 `mergeEntitiesToParent`가 **부모(EM_req)로 재지정**, 다음 fork는 `clear:false`로 identity map 상속하되 `__em`은 안 바꿈(`??=`) [doc15 §15.2, v7 소스 3줄] |
| 결과 | — | 한 요청에서 @Transactional A가 만든 엔티티를 @Transactional B가 find하면 **캐시 인스턴스(__em=EM_req)** 반환 → save() Case1 포인터 가드 false negative → Case3 upsert [S15-1 실측], [S18-1 재실측] |

**flush는 튼튼하고 save() 가드만 깨진다**: flush는 "내 UoW에 등록됐고 값이 바뀌었나"(멤버십)만 보므로 fork-split 상태에서도 dirty-flush UPDATE는 정상 [doc15 §15.5], [S15-3]. 이것이 §5.1 픽스(가드를 멤버십으로)의 근거다.

### 축 6. Identity Map / merge / detached

| | Spring | MikroORM |
|---|---|---|
| 1차 캐시 | PK 조회 캐시 히트 | 동일 [T 13-1]. 비-PK 조회는 SELECT 후 병합 — **메모리 값 우선** [doc07 §7.6], [T 13-2] |
| detached 재부착 | `em.merge()` = SELECT → managed 복사본 → dirty checking 정상 | **`em.merge()`는 스냅샷을 현재 값으로 덮어써 dirty checking 불능**(UPDATE 소실) [doc02 §2.5, doc12 §12.4]. 대안: `em.upsert`(전체 덮어쓰기·훅 우회·PG IDENTITY 불가) 또는 findOne+assign(컬렉션 미초기화 크래시 주의 [doc15 §15.7]) |
| 벌크 후 재조회 | — | `nativeUpdate/nativeDelete`는 Identity Map 미동기화 → 같은 EM 재조회 시 **stale/유령 엔티티** [doc07 §7.4], [T 9-1/9-3] |

### 축 7. 관계 vs 스칼라 FK

| | Spring | MikroORM |
|---|---|---|
| FK 해소 | 관계 대입 → flush가 부모→자식 순서 자동 정렬 | **동일** — 관계 대입(`detail.task = task`)이면 flush 순서가 FK를 항상 정확히 해소 [doc03 §3.2], [S16 3/3], [S15-officials FIX A] |
| 스칼라 FK 복사 | id가 항상 있으므로(축1) `{ taskId: task.getId() }`도 안전 | **id 미확정 시 undefined가 그대로 박혀 NULL FK** — 예외도 없이 조용히 저장됨 [S15-officials BUG 실측] |
| cascade | 명시 필요 | 기본 `[Cascade.PERSIST]`, MERGE 항상 활성 [doc09 §9.2] |

**결론**: MikroORM에서 자식 생성 시 부모는 **엔티티 참조로 넘겨라**. 스칼라 FK 복사가 불가피하면(스키마가 관계 미정의) **flush 선행**이 필수.

### 축 8. Lazy/Eager & Reference 프록시

| | Spring Hibernate | MikroORM |
|---|---|---|
| Collection 접근 | 프록시가 자동 SELECT | **에러** `Collection not initialized` — `populate` 또는 `init()` 필수 [doc09 §9.4], [T 7-8/7-9] |
| ManyToOne 필드 | 프록시가 자동 SELECT | **PK만 접근 가능**(FK 값), 다른 필드는 undefined [T 7-11] |
| N+1 | 흔한 함정 | 자동 로딩이 없어서 N+1이 "몰래" 발생하지 않는 대신, 미로딩 접근이 즉시 에러/undefined로 드러남 |

### 축 9. 배치/벌크

| | Spring Hibernate | MikroORM |
|---|---|---|
| IDENTITY + 배치 INSERT | **JDBC batching 비활성**(id를 건별로 받아야 하므로) | **배치 유지** — persist N건 → flush 1회 = multi-VALUES INSERT 1문 [S17 C-5: 3건 1문 실측] |
| 조기 flush 비용 | IDENTITY면 원래 건별 | save마다 flush하면 INSERT N문으로 **배치 손실** [S17 C-5] + 무관 dirty UPDATE 조기 실행 [S17 C-4] |
| 벌크 API | `saveAll`, `@Modifying @Query` | `em.insertMany`(Identity Map 미등록), `nativeUpdate/nativeDelete`(캐시 미동기화·cascade 없음·훅 우회) [doc10] |

### 축 10. read-back-in-transaction (officials 부류)

| 패턴 | Spring | MikroORM |
|---|---|---|
| save(new) → **id 값으로** 자식 생성/조회 | 항상 동작(id 즉시) | **flush 선행 없으면 실패** — id 값 접근은 auto-flush 트리거가 아님 [S17 A-3], [S16 🔴] |
| save(new) → **같은 타입 쿼리**로 read-back | 동작 | 동작(AUTO auto-flush, 쿼리 후 id도 할당됨) [S17 A-2] — 단 **조건부**(타입 overlap + persist 등록)라 의존하지 말 것 |
| save(new) → **엔티티 참조 조건** 쿼리 (`findOne(Detail, { task })`) | 동작 | **동작** — 쿼리 전 auto-flush가 먼저 돌고 where의 PK 추출은 flush 후 [S17 B-1] |
| 권장 | — | read-back 전 **명시 flush** (users identify 패턴, §3.3 레퍼런스) |

---

## 3. 현황 전수 — roamings · managements · users

> 스캔 범위: 각 서비스 `src/` 전체. 분류: **[버그]** 실제 오동작(장애 확정 포함) / **[위험]** 조건 갖춰지면 오동작(잠복) / **[안전]** 패턴은 해당하나 근거상 무해.

### 3.1 managements (MySQL, commons ^0.32) — 버그 5 / 위험 3 / 안전 10군

스캔 규모: 소스 294파일 / `BaseRepository.save()` 호출 **5곳** / `em.flush()` 59곳 / `nativeUpdate` 30곳 / `nativeDelete` 8곳 / `em.transactional` 1곳 / `em.merge` **0곳** / `@Transactional` 31곳(commons 29 + legacy 직접 2).

**핵심 발견: MikroORM `save()` 호출 5곳 전부가 확정 장애 패턴이다** (save 직후 undefined PK를 스칼라 FK로 복사, 바깥 @Transactional 존재). 나머지 write는 전부 `em.create + flush` 후 id를 쓰는 안전 패턴 — 즉 이 5곳만 주변 코드와 다른 "Spring 습관" 코드였다.

#### [버그] — 확정 장애 5종 (2026-07-21 프로덕션)

공통 메커니즘: `create()` 자체가 `@Transactional()` → 내부 `save()`(REQUIRED)는 join만, flush 없음 → `taskRecord.id === undefined` 시점에 `{ projectTaskId: taskRecord.id }` 평가 → NULL FK INSERT → 메서드 말미 같은 TX read-back(`getXByProjectTaskId`)이 못 찾아 NotFoundException → 전체 롤백. PK는 `managements/src/database/base.entity.ts:15` `@PrimaryKey({ type: 'bigint', autoincrement: true })`. 재현: [S15-officials 🔴], [S17 C-1/A-3].

| # | 위치 | 바깥 TX | read-back |
|---|------|---------|-----------|
| 1 | `managements/src/apis/projects/tasks/officials/officials.service.ts:84-86` | `:67 @Transactional()` | `:103` |
| 2 | `managements/src/apis/projects/tasks/inspections/inspections.service.ts:84-86` | `:67` | `:103` |
| 3 | `managements/src/apis/projects/tasks/contracts/contracts.service.ts:91-94` | `:74` | `:111` |
| 4 | `managements/src/apis/projects/tasks/constructions/constructions.service.ts:95-97` | `:78` | `:115` |
| 5 | `managements/src/apis/projects/tasks/opens/opens.service.ts:110-112` | `:87` | `:129` |

대표 사례 (officials):

```typescript
// officials.service.ts:84-103 (바깥 @Transactional :67)
await this.projectTaskRepository.save(taskRecord);           // :84 — REQUIRED join → flush 없음 → id undefined

await this.officialsRepository.createOfficial({ projectTaskId: taskRecord.id });  // :86 — undefined → NULL FK
// ...
return this.getOfficialByProjectTaskId(taskRecord.id);       // :103 — 같은 TX read-back 실패 → 전체 롤백
```

부가 확인: 히스토리 기록(`projectTaskId: taskRecord.id`, officials `:90` 등)은 자식 레포 내부 `em.flush()` **이후** 평가돼 id가 채워짐 — FK 복사 지점(위 5곳)만 undefined를 캡처한다. 이 뒤섞임이 "부분적으로 되는 것처럼 보이는" 혼란의 원인.

#### [위험]

| 위치 | 패턴 | 근거 |
|------|------|------|
| `managements/src/apis/partners/partners.repository.ts:3` (`:173`, `:243`에서 사용) | @Transactional을 `@mikro-orm/decorators/legacy`에서 직접 import | EntityRepository는 em 내장이라 **현재는 정상 동작**하나, 이 import를 서비스로 복사하면 Explorer 감지 누락으로 em 미부착(roamings sales.service 유형, 커밋 `4b7997d2`에서 수정된 사례) 재발 |
| `managements/src/apis/charger-stocks/charger-stocks.service.ts:96-98, 157-170` | MySQL flush 후 DynamoDB(Matt) write — 비원자적 dual-write | ORM 차이는 아니나 DDB 실패 시 재고↔Matt 갭(충전기 접속 불가). 참고용 |
| `managements/src/apis/projects/projects.service.ts:31-39` 외 task 서비스 4곳 생성자 주석 | "em 주입 유지" 주석이 실제 코드와 불일치(주입 없음, Explorer가 주입 중) | 사문 주석 — 후속 수정 시 혼선 소지 (낮음) |

#### [안전] — 대조군 레퍼런스

- **flush 선행 후 id 사용 (5종 버그의 올바른 대조군)**: `projects.repository.ts:62-68, 148-154, 309-317`, `contracts.repository.ts:58-75`(flush `:63` 후 `record.id`를 자식 FK로), `constructions.repository.ts:205-212`, `partners.repository.ts:32-56`(flush `:49` 후 `partner.id`), `crm.repository.ts:110-118, 216-222, 258-265` — 전부 `em.create + em.flush()` 후 id 사용.
- **fork-split 회피 레퍼런스**: `opens.service.ts:349, 379` — TX 밖에서 로드된 task를 저장하지 않고 TX 안에서 `findOneOrFail` **재조회 후 assign**.
- **TX 내 read-back 안전 사례**: `crm.service.ts:88, 366` — 레포가 flush 선행이라 read-back 성공.
- **nativeUpdate/nativeDelete**: `projects.repository.ts:323-415`(soft-delete cascade), `partners.repository.ts:177-179, 248`(full-replace) — 같은 EM 재조회 없음(조건부 안전). `projects.repository.ts:132-201`의 하드 delete 헬퍼는 호출자 없는 데드코드.
- **em.transactional 직접**: `charger-stocks.repository.ts:107-122` — PESSIMISTIC_WRITE + 자체 TX + 내부 flush, 중첩 없음.
- `RequestContext.create`: `channel-talk-webhook.listener.ts:25` — 같은 컨텍스트에서 load+mutate+flush, fork-split 없음.
- `em.merge` 사용 0건. TransactionalExplorer는 `database.module.ts:41` 정상 등록.

### 3.2 roamings (PostgreSQL + GENERATED ALWAYS IDENTITY, commons 0.31.0) — 버그 1 / 위험 4 / 안전 다수

규모: `save/saveAll` 13곳(파일 9), `@Transactional` 13곳(**전부 commons import, legacy 직접 import 0** — 4b7997d2 유형 재발 없음), `em.merge` 0, 명시 `flush()` 1(outbox), `em.transactional` 직접 4, `@EnsureRequestContext` 컨슈머 4.

- **[버그] `scheduling/services/jobs/job-persistence.service.ts:131,139`** — `createJobs`가 `persistScheduled`(:47)/`persistManual`(:70)의 `@Transactional` 안에서 `save(job)`(Case2 persist-only, flush 없음) 직후 `results.push({ jobId: job.id })` → **`job.id === undefined`**. `persistScheduled` 반환은 버려져 무해하나, **`triggerNow`(job.service.ts:60) → scheduler-admin 응답 `TriggerDefinitionResponseDto.jobs[].jobId`가 항상 undefined**로 직렬화(admin 응답 결함, Task 발행은 DB 재조회라 실행흐름 무영향).
- **[위험] `external-api/services/external-api-log.service.ts:43-44`** — `save(log); return {id: log.id}` → `complete(logId)`가 `nativeUpdate({id:logId})`. 바깥 TX 있으면 id=undefined→complete no-op + 로그가 비즈니스 TX에 말려듦. 방어=`:17` 주석뿐(가드 없는 관례 의존). 현 호출부 전부 TX 밖이라 미발현.
- **[위험(경미)] `events/services/event-log.service.ts:25-26`** — 동일 save-후-id 관례. 유일 호출부(EventsSqsConsumer resolveNewEventLog)가 TX 밖(@EnsureRequestContext)이라 save 자체 TX flush로 id 확보 — 안전하나 관례 의존.
- **[위험(잠재)] `me/cards/services/card-writer.service.ts:84`** — upsert `@Transactional` 안 로드행 `save(existing)`. 단발=Case1 no-op 안전, **같은 signature 2회+면 fork-split→Case3 upsert→PG IDENTITY 에러**(inbound-trade 기전). 현 호출부 HTTP 단건이라 미발현. dirty-flush로 봉합 권장.
- **[위험(경미)] `me/cards/services/card-batch-writer.service.ts:77→107`** — `em.transactional` 안 SELECT(`getExistingCardMap`)에 txEm 미전달(READ COMMITTED·UNIQUE로 실질 무해).
- **[안전·성숙] fork-split 이미 봉합**: `trades/inbound/services/inbound-trade.service.ts:81-88`(markResult=dirty-flush, 주석 명시), `me/battery/services/battery-encrypt-key-writer.service.ts:136-140`(신규 PK필터 후 dirty-flush), `outbox-events/repositories/outbox-event-log.repository.ts:54-56`(persist→flush→id 정석). outbox referenceId는 save-id 미사용(mePaidId 자연키) — 이중결제 방어선 유지.
- 총평: 코드베이스가 fork-split/flush-부재를 **이미 인지**하고 dirty-flush·raw RETURNING·`em.clear`로 우회하는 성숙 단계. 미인지 잔존은 job-persistence 1건.

### 3.3 users (MySQL, commons ^0.32) — 버그 0 / 위험 6 call-site / 안전 다수

스캔 규모: 비-spec TS 168파일 / `.save()` 16곳(MikroORM 13 + DynamoDB 3) / flush 헬퍼 ~30곳 / `@Transactional` 16곳(전부 commons import) / `createAndFlush` 계열 구현 4개 / `em.merge`·`nativeUpdate`·`nativeDelete`·`insertMany`·`saveAll` **전부 0건**. SQS 컨슈머(events/points)는 DynamoDB만 사용 → 비-HTTP fork-split 해당 없음.

#### [위험] 6 call-site — @Transactional 누락 + save(로드 엔티티) → 자체 TX fork에서 Case3 upsert

전부 `users/src/apis/internal/users/users.service.ts`. 공통 원인: **메서드 레벨 `@Transactional` 누락** → RC(request EM)에서 로드한 엔티티에 `save()`가 자체 TX fork를 떠 `__em` 불일치 → Case1 포인터 가드 false negative → Case3 upsert. MySQL이라 크래시 없는 **silent degrade**(전체 컬럼 재기록 — 동시 쓰기 시 stale clobber + `onCreate/onUpdate` 훅 우회). **이 패턴은 스펙 18-7로 런타임 재현 완료**(`INSERT..ON DUPLICATE` + updatedAt null 실측), 18-8로 commons 픽스가 **코드 수정 없이 치유**됨도 실증.

| 위치 | 메서드 | 비고 |
|------|--------|------|
| `users.service.ts:243` | `upsertCredential` (POST /internal/users/credentials 직결) | 기존 credential 매칭 branch만 해당. `linkRecoverCredential`(`:712`) 경유 시엔 바깥 TX(`:659`) 안 → Case1 no-op — **이중 컨텍스트** |
| `users.service.ts:526` | `updateCredentialEventId` | 루프 건별 save → 건별 fork upsert + 다건 비원자 |
| `users.service.ts:560` | `withdraw` | populate 로드 user 상태변경 후 save. withdraw 전체(`:551-562`)가 flush 4회+save 2회+DDB로 비원자 |
| `users.service.ts:878` | `upsertTerminatedUser` (withdraw 경유) | 기존 행 branch만 해당 |
| `users.service.ts:887` | `restoreUser` — v1 `recover`→`reactivate`(`:747`) 경유 시 | v2 `restoreWithLinkInTransaction`(`:659` TX) 경유는 안전. 주석 `:657`이 의도적 방치임을 명시(알려진 부채) |
| `users.service.ts:860` | `markAdminAccessCodeUsed` | 로드 후 `usedAt` 대입 → save |

#### [안전 레퍼런스] identify 흐름 — §2 축7/축10의 정답 코드 (PLU-1216에서 수정된 기준)

`users/src/apis/internal/users/users.service.ts` — 전체가 `@Transactional()`(`:270` identifyInTransaction) 안, **create → save(persist만) → 관계 대입 → 명시 flush → id 사용/read-back** 순서:

```typescript
await this.usersRepository.save(user);        // :358 — persist만, id 아직 undefined

preference.user = user;                        // :380-381 — 자식 3종 전부 관계 대입
credential.user = user;                        // :408-409    (스칼라 FK 복사 아님)
identification.user = user;                    // :430-431

// :330-339 — "신규 유저(B-2)는 save 가 persist 만 하므로 flush 전까지 autoincrement id 가 없다."
await this.usersRepository.flush();            // :334 — 여기서 INSERT + id 확정
const newUser = isNewUser ? { id: user.id, name: user.name } : null;  // :338
return { result: await this.findById(user.id), newUser };             // :339 — read-back 성공
```

`users.repository.ts:26-32` flush 헬퍼 주석이 차이를 문서화: "Spring/JPA IDENTITY 는 save 시 즉시 INSERT 되어 id 가 잡히나 MikroORM 은 flush 지연." 이 흐름의 정합성은 [S16 3/3] 실증(관계 대입 + flush 후 read-back 정상 / flush 없으면 실패).

#### [안전] — 기타

- `createAndFlush` 헬퍼 4구현: `user-authorize-methods.repository.ts:67-77`(create→persist→flush→반환 시 id 확정), `cars.repository.ts:14-18, 29-41`(+`em.getReference`로 cold-state user 오인 회피, PLU-1412), `locations.repository.ts:14-18, 28-40` — 확산 적용 가능한 표준.
- `users.service.ts:451-483`(updateContact)·`:495-507`(updateAppVersion) — TX + dirty-flush 정석. `:573-597`(completeWithdraw) — 무TX지만 save 미사용·단일 flush(자체 TX changeset)라 upsert 경로 없음.
- `auth-methods.service.ts:331-335, 423-452` — TX 내 save→flush 후 `entity.id` 사용(Redis 키/DTO) — flush 선행이라 확정.
- 스칼라 FK 복사 점검: 방금 save된 미flush 신규 엔티티의 id 복사는 **0건** (`users.service.ts:713`은 기존 로드 엔티티, `auth-methods.service.ts:323`은 HTTP 응답 객체).

### 3.4 서비스별 요약 카운트

| 서비스 | DB | 버그 | 위험 | save/saveAll 호출 | em.merge | @Transactional import 위반 | 특기 |
|--------|----|------|------|-------------------|----------|---------------------------|------|
| managements | MySQL | **5** (프로덕션 장애 확정) | 3 | 5 — **5곳 전부 버그** | 0 | legacy 직접 1파일(레포라 현재 무해) | 나머지 write는 전부 `em.create+flush` 안전 패턴 |
| roamings | **PG** | **1** (triggerNow 응답 jobId undefined) | 4 | 13 | 0 | 0 | fork-split 봉합 2곳 보유, 가장 성숙 |
| users | MySQL | 0 | **6 call-site** (silent upsert) | 13(ORM) | 0 | 0 | identify = 전사 레퍼런스, Explorer 미등록 |

공통 관찰: 세 서비스 모두 `em.merge` 0건 — 문제는 전부 **`save()` 시맨틱 주변**(flush 누락·fork 소속)에 집중. 잘 되는 코드(flush 선행·관계 대입·dirty-flush)와 깨지는 코드(save 후 id·로드 엔티티 save)가 서비스마다 공존한다 — 개인 지식이 아니라 **commons 레벨 시맨틱**으로 풀어야 하는 이유.

---

## 4. 우선순위 문제

| 우선순위 | 문제 | 위치 | 재현 | 조치 |
|---|---|---|---|---|
| **P1** | 업무생성 5종 `create()` — save후 미할당 id를 스칼라 FK 복사 → NULL FK → read-back 실패 → 전체 롤백. **준공/개시 등 생성 전면 불가** | managements officials/opens/contracts/constructions/inspections `create()` | ✅ 프로덕션 장애(2026-07-21) + 샌드박스 스펙 15 | 즉시: `createAndFlush` 국소 fix / 근본: commons `save()` 패치(§5.1) |
| **P2** | `triggerNow` admin 응답 `jobs[].jobId` 항상 undefined | roamings `job-persistence.service.ts:131,139` | ✅ (실행흐름 무영향, 응답만) | `createAndFlush` 또는 `em.insert` |
| **P2** | `@Transactional` 누락 → save 자체 TX fork-split → Case3 upsert silent degrade(전컬럼 재기록 + 훅 우회, 동시쓰기 시 clobber) | users `users.service.ts` 6곳 | ✅ 패턴 런타임 재현(스펙 18-7: upsert + updatedAt null) | 메서드에 `@Transactional` 부여 or save 제거(dirty-flush). commons 픽스가 무수정 치유(스펙 18-8) |
| **P3** | save-후-id 관례 의존(가드 없음) | roamings `external-api-log.service.ts:43`, `event-log.service.ts:25` | △ 현재 호출부는 안전 | 호출부 TX-밖 가드 명문화 or `createAndFlush` |
| **P3** | fork-split 잠재(같은 signature 2회+) | roamings `card-writer.service.ts:84` | △ 미발현 | dirty-flush 전환 |
| **P3** | TX 밖 read (batch) | roamings `card/charger-batch-writer` | ✖ 정합성 무해 | txEm 전달(선택) |

**근본 해결의 지레점**: commons `BaseRepository.save/saveAll` 통합 수정(§5.1)이 **결함 A(flush 누락)로 P1을, 결함 B(fork-split 멤버십 오판)로 P2 users·P3 상당수를** 동시에 봉합한다. 단 영향범위가 전 서비스라 회귀 검증(스펙 18) 후 배포.

---

## 5. 해결책

### 5.1 commons 레벨 — `BaseRepository.save()/saveAll()` 통합 수정안 (스펙 18로 실증)

두 가지 독립 결함을 한 번에 수술한다:

- **결함 A (flush 누락 비대칭)**: Case2/4 신규 저장이 persist만 → 바깥 TX join 시 id undefined → officials 부류 장애.
- **결함 B (fork-split 오판)**: Case1 가드가 `__em` 포인터 비교 → fork-split에서 false negative → Case3 upsert → PG IDENTITY 에러.

```typescript
// pluglink-commons/src/database/mikro-orm/base.repository.ts
export class BaseRepository<T extends object> extends EntityRepository<T> {
  /** "이 인스턴스가 현재 em의 UoW(identity map)에 있는가" — __em 포인터 대신 멤버십으로 판정 */
  private isManagedHere(em: EntityManager, entity: T): boolean {
    const wrapped = helper(entity);
    return (
      wrapped.__managed &&
      wrapped.hasPrimaryKey() &&
      em.getUnitOfWork().getById(this.entityName as string, wrapped.getPrimaryKey() as any) === entity
    );
  }

  @Transactional()
  async save(entity: T): Promise<T> {
    const em = (this.em as any).getContext(false) as typeof this.em;
    const wrapped = helper(entity);

    // Case 1': managed (UoW 멤버십) — dirty checking에 맡김
    //  - fork-split(__em=EM_req ≠ ctxEm)이어도 fork(clear:false)로 UoW에 등록돼 있으므로 여기서 잡힌다
    if (this.isManagedHere(em, entity)) return entity;

    // Case 2': New — persist + 즉시 flush (Spring IDENTITY parity: save 직후 entity.id 사용 가능)
    if (!wrapped.hasPrimaryKey()) {
      em.persist(entity);
      await em.flush();
      return entity;
    }

    // Case 3: 진짜 detached — 기존 동작(upsert) 보존. PG IDENTITY 테이블엔 여전히 부적합하므로
    //         detached 저장 자체를 코드리뷰에서 차단할 것 (감사상 사용처 0건).
    if (wrapped.__originalEntityData) {
      return (await em.upsert(this.entityName, entity as any)) as T;
    }

    // Case 4': New(수동 PK) — persist + flush
    em.persist(entity);
    await em.flush();
    return entity;
  }

  @Transactional()
  async saveAll(entities: T[]): Promise<T[]> {
    const em = (this.em as any).getContext(false) as typeof this.em;
    const results: T[] = [];
    let needsFlush = false;
    for (const entity of entities) {
      const wrapped = helper(entity);
      if (this.isManagedHere(em, entity)) { results.push(entity); continue; }
      if (!wrapped.hasPrimaryKey()) { em.persist(entity); needsFlush = true; results.push(entity); continue; }
      if (wrapped.__originalEntityData) { results.push((await em.upsert(this.entityName, entity as any)) as T); continue; }
      em.persist(entity); needsFlush = true; results.push(entity);
    }
    if (needsFlush) await em.flush(); // 루프 밖 1회 → multi-VALUES 배치 INSERT 유지 [S17 C-5]
    return results;
  }
}
```

#### 실증 결과 (신규 스펙 `test/jpa-compat/18-commons-fix-verification.spec.ts`, MySQL 3307, 8/8 PASS)

| # | 시나리오 | 현행(OLD) | 수정안(FIXED) |
|---|----------|-----------|---------------|
| 18-1 | fork-split(@EnsureRequestContext → @Transactional×2)에서 loaded 엔티티 save | **`INSERT..ON DUPLICATE`(upsert)** + `updatedAt`(onUpdate 훅) **null** — PG였다면 IDENTITY 에러 | — |
| 18-2 | 동일 시나리오 | — | upsert 없음, **plain UPDATE** + `updatedAt` 정상 SET |
| 18-3 | 바깥 @Transactional 안 save(new) | id undefined [S17 C-1] | **id 즉시 할당** (Spring parity) |
| 18-4 | 진짜 detached(독립 fork에서 로드, UoW 밖) | upsert | **upsert 유지** (기존 동작 보존) |
| 18-5 | 같은 fork find→save | no-op → dirty UPDATE 1회 | **동일** (UPDATE 1회, INSERT/upsert 없음) |
| 18-6 | 조기 flush 후 바깥 TX throw | — | **전체 롤백** (원자성 유지 — flush는 같은 TX 커넥션) [S17 C-6 동일] |
| 18-7 | **users 패턴**: RC(HTTP)에서 로드·수정 → 바깥 TX 없이 repo.save() 1회 | **upsert** + 훅 우회(updatedAt null) — users.service.ts 6개 사이트의 정적 판정을 런타임 실측으로 확정 | — |
| 18-8 | 동일 시나리오 | — | 멤버십 히트 → **plain UPDATE** + 훅 정상 (commons 픽스가 users 6곳을 코드 수정 없이 치유) |

#### 트레이드오프 (수용 근거)

| 비용 | 실측 | 판단 |
|------|------|------|
| flush는 UoW 전체를 밀어냄 → 무관 dirty 엔티티 UPDATE 조기 실행 | [S17 C-4] | 같은 TX 안이라 정합성 영향 없음. 실행 시점만 앞당겨짐 |
| 루프 save 시 배치 INSERT 손실 (1문 → N문) | [S17 C-5] | **Spring IDENTITY도 동일 비용.** 대량 INSERT는 saveAll(플러시 1회) 또는 `em.insertMany` 사용 |
| NESTED propagation 대안은? | [S17 D-1~D-3] | savepoint 라운드트립 추가 + 외부 pending까지 같이 flush(격리 이점 없음) → flush 한 줄 추가가 우세 |

#### 배포 주의 (CLAUDE.md commons 규칙)

commons 변경이므로 **pluglink-backend 전 서비스**의 save/saveAll 사용처 재확인 + 버전 bump 후 서비스별 테스트 재실행이 필요하다. doc16 §16.5의 PG 테스트 컨테이너 회귀(IDENTITY 에러 실발현 확인)를 commons 레포에 추가하는 것을 권장. 스펙 18은 MySQL이라 upsert routing까지만 증명한다(PG 에러 발현은 doc16 §16.1 라이브 재현으로 이미 확인됨).

### 5.2 서비스 레벨 가이드라인 (commons 픽스 배포 전/후 공통)

1. **신규 엔티티 + id 필요** → 자식에는 **관계 대입**(`child.task = task`)을 쓰고, 스칼라 id가 꼭 필요하면(외부 발행 referenceId 등) save 후 **명시 flush** 선행. (올바른 레퍼런스: users identify — §3.3)
2. **로드된(managed) 엔티티 수정** → `save()` 호출 금지, 필드만 바꾸고 @Transactional 커밋의 dirty-flush에 맡긴다. (roamings inbound-trade `markResult` 주석 선례)
3. **@Transactional 안에서 다른 @Transactional 메서드를 try-catch로 감싸지 않는다** — MikroORM엔 rollback-only가 없어 부분 데이터가 commit된다 [T 12-2]. 부분 실패 허용이 필요하면 외부 API 호출을 flush 뒤로 빼거나 별도 fork에서 실행 [doc99 §5].
4. **`em.merge()` 사용 금지** (dirty checking 파괴). detached를 다룰 일 자체를 만들지 말 것 — 같은 컨텍스트에서 다시 로드해서 수정.
5. **`nativeUpdate/nativeDelete` 후 같은 EM에서 해당 행을 재조회하지 않는다** (stale). 재조회가 필요하면 `em.refresh()` 또는 새 fork. `updatedAt` 등 onUpdate 훅 값은 직접 채운다 [doc15 §15.6 B].
6. **@Transactional은 반드시 `@plug-link/commons`에서 import** — `@mikro-orm/*` 직접 import는 TransactionalExplorer 감지 누락(ESLint `no-restricted-imports`로 차단 권장 [doc11 §11.5]).
7. **Collection/관계 접근 전 populate 또는 init** — 자동 로딩 없음 [T 7-8].
8. **컨슈머/스케줄러(비-HTTP)에서 엔티티를 로드한 뒤 @Transactional 메서드에 넘겨 save하지 않는다**(fork-split). 트랜잭션 안에서 다시 로드하거나 dirty-flush.

### 5.3 코드리뷰 체크리스트

```
□ save(...) 직후 .id / PK를 읽는가? → 관계 대입으로 대체 or flush 선행 확인
  (commons 픽스 배포 후에도: save가 아닌 em.persist 직접 호출 경로는 여전히 flush 필요)
□ { xxxId: entity.id } 스칼라 FK 복사 — entity가 이 트랜잭션에서 방금 생성됐는가?
□ 트랜잭션 안 write → 같은 행 read-back — 사이에 flush가 있는가?
□ find/findOne으로 로드한 엔티티에 save()를 호출하는가? → 제거(dirty-flush)
□ @Transactional 메서드 호출을 try-catch로 감싸는가? → rollback-only 없음, 재설계
□ em.merge 사용? → 금지
□ nativeUpdate/nativeDelete 후 같은 EM 재조회? updatedAt 수동 세팅했는가?
□ Transactional import 출처가 @plug-link/commons인가?
□ 새 @Transactional 클래스 — 해당 서비스에 TransactionalExplorer가 등록돼 있는가? (users 주의)
□ Collection 접근 전 populate/init 있는가?
```

---

## 6. 열린 질문 / 후속

1. **Case3(upsert)를 남길 것인가**: 진짜 detached 사용처는 감사상 0건. JPA-style merge(findOne+assign)로 재작성하는 안은 컬렉션 미초기화 크래시 + cross-EM 난점으로 비권장 [doc15 §15.7]. 현실적 선택지는 (a) upsert 유지 + 주석 경고(이번 안) vs (b) Case3 도달 시 명시 에러 throw(오용 조기 발견). PG 서비스가 늘어나면 (b) 검토.
2. **users의 TransactionalExplorer 미등록** — 의도(모든 서비스가 생성자 em 주입)인지 누락인지 확인 필요. commons 픽스와 무관하게 정리 권장.
3. **commons 픽스 배포 시점의 flush 부작용 검증**: save가 flush를 하게 되면, 기존 코드 중 "save 후 같은 TX에서 추가 변경 → 커밋 flush" 패턴의 SQL 횟수가 늘 수 있다(정합성 무해, 성능만). 서비스별 hot path(스케줄러 대량 save 루프)는 saveAll로 전환 확인.
4. **`em.insert()` targeted 단건의 공식 활용처**: unmanaged 반환이라 후속 dirty checking이 필요 없는 "기록성 INSERT"(로그/원장)에는 save보다 명시적일 수 있음 — 컨벤션으로 채택할지 결정 필요.
5. **PG 테스트 컨테이너 회귀를 commons CI에 추가** (doc16 §16.5) — 스펙 18은 MySQL이라 IDENTITY 에러 자체는 못 본다.

---

## 7. 작성/실행한 검증 스펙 목록과 결과

이 감사에서 실행한 스펙 (MySQL 8.0 @ localhost:3307, MikroORM v7.0.2, 2026-07-21):

| 스펙 파일 | 목적 | 결과 |
|-----------|------|------|
| `test/jpa-compat/15-em-fork-split-repro.spec.ts` (기존) | fork-split → save() upsert routing 재현 (4 tests) | 4/4 PASS |
| `test/jpa-compat/15-officials-save-flush-pitfall.spec.ts` (기존) | officials 장애 재현: save(new)+스칼라 FK 복사 → NULL FK → read-back 실패, FIX A(관계)/B(flush) (3 tests) | 3/3 PASS |
| `test/jpa-compat/16-relation-readback.spec.ts` (기존) | 관계 대입 FK 자동 해소 + "flush 없으면 id read-back 불가" (3 tests) | 3/3 PASS |
| `test/jpa-compat/17-early-flush-spring-parity.spec.ts` (기존) | FlushMode 4종·관계+AUTO·save flush 패치·NESTED·uuid PK 실측 (16 tests) | 16/16 PASS |
| **`test/jpa-compat/18-commons-fix-verification.spec.ts` (이번 감사에서 신규 작성)** | **§5.1 통합 수정안 실증: Case1=UoW 멤버십(doc16 §16.4의 "미테스트" 부분) + Case2=flush, 기존 동작 보존·원자성·users 패턴(RC 로드→무TX save) 재현/치유 포함 (8 tests)** | **8/8 PASS** |

배경 근거로 인용한 기존 behavior 테스트 106개는 [부록 B](./appendix-b-test-results.md) 참조.
