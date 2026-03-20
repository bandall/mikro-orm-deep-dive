# 부록 B. 테스트 결과 요약 (106개)

> 모든 문서의 "검증된 동작"은 아래 테스트로 확인되었다.

## B.1 behavior 테스트 (94개)

### 01-persist.spec.ts — persist & flush

| # | 테스트 | 결과 |
|---|--------|------|
| 1-1 | 새 엔티티 persist + flush → INSERT | ✅ |
| 1-2 | managed 엔티티에 persist + flush (변경 없음) → 쿼리 없음 | ✅ |
| 1-3 | 새 엔티티 persist 2번 + flush → INSERT 1회 (Set 중복 무해) | ✅ |
| 1-4 | PK 직접 할당한 새 엔티티 persist + flush → INSERT | ✅ |
| 1-5 | 이미 존재하는 PK로 새 인스턴스 persist + flush → 에러 | ✅ |
| 1-6 | em.create() + flush (persist 호출 없이) → persistOnCreate 동작 확인 | ✅ |

### 02-transactional.spec.ts — @Transactional()

| # | 테스트 | 결과 |
|---|--------|------|
| 2-1 | @Transactional 메서드에서 persist (flush 없음) → auto flush | ✅ |
| 2-2 | @Transactional 메서드에서 예외 → rollback | ✅ |
| 2-3 | Outer @Transactional → Inner @Transactional → 바깥 끝에서 commit | ✅ |
| 2-4 | Outer @Transactional → Inner @Transactional에서 예외 → 전체 rollback | ✅ |
| 2-5 | @Transactional 없이 글로벌 EM에서 persist → allowGlobalContext=false이면 에러 | ✅ |
| 2-6 | @Transactional 없이 글로벌 EM에서 수동 flush → allowGlobalContext=false이면 에러 | ✅ |

### 03-flush-mode.spec.ts — FlushMode

| # | 테스트 | 결과 |
|---|--------|------|
| 3-1 | persist(Author) → find(Author) (AUTO) → auto flush 후 조회 | ✅ |
| 3-2 | persist(Author) → find(Book) (AUTO) → flush 안 함 | ✅ |
| 3-3 | persist(Author) → find(Book) (ALWAYS) → flush 발동 | ✅ |
| 3-4 | dirty checking + 같은 타입 조건 조회 (AUTO) → auto flush 안 됨 (UPDATE는 대상 아님) | ✅ |
| 3-5 | FlushMode.COMMIT + persist → find → flush 안 함 | ✅ |

### 04-em-context.spec.ts — EM 컨텍스트

| # | 테스트 | 결과 |
|---|--------|------|
| 4-1 | RequestContext 안에서 글로벌 EM으로 find → fork EM 사용 | ✅ |
| 4-2 | RequestContext 없이 글로벌 EM 사용 → allowGlobalContext=false이면 에러 | ✅ |
| 4-3 | 두 개의 RequestContext에서 같은 엔티티 조회 → 서로 다른 인스턴스 | ✅ |
| 4-4 | RC 안에서 repo.getEntityManager() → 같은 프록시 반환 (내부적으로 fork EM 사용) | ✅ |
| 4-5 | DI 주입 EM vs repository EM (RC 내) → 같은 fork EM | ✅ |
| 4-6 | orm.em은 프록시 — fork()마다 별개, RC마다 다른 fork 반환 | ✅ |
| 4-7 | DI로 주입받은 EM도 같은 프록시 — NestJS 전역에 하나 | ✅ |
| 4-8 | em.clear() 후 동일 PK 조회 → DB에서 새로 로드 | ✅ |

### 05-dirty-checking.spec.ts — Dirty Checking

| # | 테스트 | 결과 |
|---|--------|------|
| 5-1 | 필드 변경 → flush → UPDATE | ✅ |
| 5-2 | 같은 값으로 할당 → flush → 쿼리 없음 | ✅ |
| 5-3 | 여러 필드 변경 → flush → UPDATE 1회 | ✅ |
| 5-4 | 필드 변경 → persist 없이 flush → UPDATE 실행 | ✅ |

### 06-save-pattern.spec.ts — save() 패턴

| # | 테스트 | 결과 |
|---|--------|------|
| 6-1 | 새 엔티티 → save() → INSERT | ✅ |
| 6-2 | 조회한 엔티티 필드 변경 → save() → UPDATE | ✅ |
| 6-3 | 조회한 엔티티 변경 없음 → save() → 쿼리 없음 | ✅ |
| 6-4 | 바깥 @Transactional 안에서 save() → 바깥 트랜잭션에 참여 | ✅ |
| 6-5 | 바깥 트랜잭션 없이 save() → 자체 트랜잭션으로 commit | ✅ |

### 07-relations.spec.ts — 연관관계

| # | 테스트 | 결과 |
|---|--------|------|
| 7-1 | 부모 + 자식 함께 persist → flush → 둘 다 INSERT | ✅ |
| 7-2 | 부모만 persist + cascade PERSIST → 자식도 INSERT | ✅ |
| 7-3 | 부모 조회 → 자식 컬렉션에서 제거 (orphanRemoval 동작 확인) | ✅ |
| 7-5 | 자식만 persist (부모 이미 managed) → 자식 INSERT | ✅ |
| 7-6 | 부모 remove + cascade REMOVE → 자식도 삭제 | ✅ |
| 7-7 | insertMany로 자식 벌크 삽입 → Identity Map에 안 올라감 | ✅ |
| 7-8 | populate 없이 Collection 접근 → 에러 (Spring과 다름: 자동 로딩 안 됨) | ✅ |
| 7-9 | Collection.init() → 명시적 Lazy Loading | ✅ |
| 7-10 | populate으로 Eager Loading → 즉시 사용 가능 | ✅ |
| 7-11 | ManyToOne Reference — PK만 접근 가능, 나머지 undefined | ✅ |

### 08-request-context.spec.ts — RequestContext

| # | 테스트 | 결과 |
|---|--------|------|
| 8-1 | RequestContext 안에서 persist + flush → 정상 | ✅ |
| 8-2 | RequestContext 안에서 persist (flush 없음) → DB 반영 안 됨 | ✅ |
| 8-3 | 글로벌 EM 직접 사용 → allowGlobalContext=false이면 에러 | ✅ |
| 8-4 | RequestContext + em.transactional → 정상 | ✅ |

### 09-e2e-request-context.spec.ts — E2E RequestContext

| # | 테스트 | 결과 |
|---|--------|------|
| 9-1 | POST 요청 → registerRequestContext가 자동 fork → INSERT 성공 | ✅ |
| 9-2 | GET 요청 → 자동 fork EM으로 SELECT 성공 | ✅ |
| 9-3 | 연속 요청 → 각 요청이 독립된 Identity Map 사용 | ✅ |
| 9-4 | 목록 조회가 이전 요청의 Identity Map에 영향받지 않음 | ✅ |
| 9-5 | 요청 간 데이터 격리 — POST commit 후 GET으로 즉시 조회 가능 | ✅ |

### 09-native-operations.spec.ts — 네이티브 연산

| # | 테스트 | 결과 |
|---|--------|------|
| 9-1 | nativeUpdate → Identity Map 캐시와 불일치 | ✅ |
| 9-2 | nativeUpdate + raw() 원자적 증가 | ✅ |
| 9-3 | nativeDelete → Identity Map에 남아있을 수 있음 | ✅ |
| 9-4 | @Transactional 안에서 nativeUpdate → 예외 시 rollback | ✅ |

### 10-insert-many.spec.ts — insertMany

| # | 테스트 | 결과 |
|---|--------|------|
| 10-1 | insertMany → DB INSERT, Identity Map 미등록 | ✅ |
| 10-2 | insertMany 후 find → DB에서 새로 Identity Map 등록 | ✅ |
| 10-3 | @Transactional 안에서 insertMany → 예외 시 rollback | ✅ |
| 10-4 | 500건 chunk insertMany → 모두 정상 INSERT | ✅ |

### 11-readonly-cqrs.spec.ts — Readonly & CQRS

| # | 테스트 | 결과 |
|---|--------|------|
| 11-1 | readOnly 트랜잭션 SELECT → 정상 | ✅ |
| 11-2 | readOnly 트랜잭션 INSERT → DB 거부 | ✅ |
| 11-3 | readOnly 트랜잭션 UPDATE → DB 거부 | ✅ |
| 11-4 | FlushMode.COMMIT 트랜잭션 → 쿼리 전 flush 안 됨 | ✅ |
| 11-5 | fork({ flushMode: COMMIT }) → 읽기 전용 EM | ✅ |
| 11-6 | disableIdentityMap → Identity Map 미등록 | ✅ |
| 11-7 | disableIdentityMap 수정 → flush해도 UPDATE 안 됨 | ✅ |
| 11-8 | disableTransactions → autocommit 모드 | ✅ |
| 11-9 | disableTransactions → 비원자적 실행 | ✅ |
| 11-10 | PESSIMISTIC_WRITE → FOR UPDATE | ✅ |
| 11-11 | PESSIMISTIC_READ → FOR SHARE | ✅ |
| 11-12 | 트랜잭션 밖 비관적 잠금 → 에러 | ✅ |
| 11-13 | CQRS — 읽기/쓰기 EM 분리 | ✅ |
| 11-14 | CQRS — 읽기 전용 트랜잭션 일관된 스냅샷 | ✅ |
| 11-15 | getConnection('read'/'write') API | ✅ |

### 12-rollback-only.spec.ts — Rollback-only (Spring과의 차이)

| # | 테스트 | 결과 |
|---|--------|------|
| 12-1 | Case A: Inner 예외 전파 → 전체 rollback (Spring과 동일) | ✅ |
| 12-2 | Case B: Inner 예외를 Outer에서 catch → commit 성공 (Spring은 rollback) | ✅ |
| 12-3 | Case B 변형: Inner 예외 catch 후 recovery 추가 → 전부 commit | ✅ |
| 12-4 | Case C: Inner 성공 후 Outer throw → 전체 rollback (Inner 데이터도 사라짐) | ✅ |
| 12-5 | Case D: Inner 성공 후 Outer 자체 catch → commit 성공 | ✅ |
| 12-6 | em.transactional에서 예외 catch → commit 성공 | ✅ |
| 12-7 | em.transactional 예외 미처리 → 전체 rollback (대조군) | ✅ |

### 13-identity-map-merge.spec.ts — Identity Map 병합 우선순위

| # | 테스트 | 결과 |
|---|--------|------|
| 13-1 | PK 조회 → Identity Map 캐시 히트 (같은 인스턴스) | ✅ |
| 13-2 | 메모리 변경 후 비-PK 조회 → Identity Map 값 우선 | ✅ |
| 13-3 | 비-PK 조회 — DB 조건과 메모리 값이 다를 때 메모리 값 유지 | ✅ |
| 13-4 | refresh: true → DB 값으로 강제 덮어쓰기 (메모리 변경 소실) | ✅ |
| 13-5 | 다른 EM에서 DB 변경 후 재조회 → stale 캐시, refresh로 해결 | ✅ |
| 13-6 | 비-PK 조회 시 flush 발생하지 않음 (병합만 수행) | ✅ |

### 14-nested-context.spec.ts — 중첩 컨텍스트

| # | 테스트 | 결과 |
|---|--------|------|
| 14-1 | 중첩 RC → 내부/외부 RC는 별도 fork (EM 인스턴스 다름) | ✅ |
| 14-2 | 중첩 RC — 내부 flush가 외부 변경사항에 영향 없음 | ✅ |
| 14-3 | 중첩 RC — 내부에서 생성한 엔티티가 외부 Identity Map에 없음 | ✅ |
| 14-4 | em.fork().transactional → 별도 Identity Map (원본 영향 없음) | ✅ |
| 14-5 | em.transactional → 같은 Identity Map 공유 (같은 인스턴스) | ✅ |

## B.2 jpa-compat 테스트 (26개)

### 11-transactional-explorer.spec.ts — TransactionalExplorer

| # | 테스트 | 결과 |
|---|--------|------|
| 11-1 | em 미주입 서비스 @Transactional() → 정상 동작 | ✅ |
| 11-2 | em 미주입 서비스 예외 → rollback | ✅ |
| 11-3 | 서비스 간 @Transactional() 전파 — 정상 | ✅ |
| 11-4 | 서비스 간 @Transactional() 전파 — Inner 예외 → 전체 rollback | ✅ |
| 11-5 | Explorer 주입 em 존재 확인 | ✅ |

### 12-base-repository.spec.ts — BaseRepository

| # | 테스트 | 결과 |
|---|--------|------|
| 12-1 | save(새 엔티티) → INSERT | ✅ |
| 12-2 | save(변경된 엔티티) → UPDATE | ✅ |
| 12-3 | save(변경 없는 엔티티) → 쿼리 없음 | ✅ |
| 12-4 | saveAll() → 벌크 INSERT | ✅ |
| 12-5 | findById() → 조회 성공 | ✅ |
| 12-6 | findById(없는 ID) → null | ✅ |
| 12-7 | findByIdOrFail(없는 ID) → 에러 | ✅ |
| 12-8 | existsById() → true/false | ✅ |
| 12-9 | deleteById() → 삭제 | ✅ |
| 12-10 | delete(entity) → 삭제 | ✅ |
| 12-11 | 커스텀 메서드 findByName() → 정상 | ✅ |
| 12-12 | @Transactional() 없이 repo 사용 → allowGlobalContext=false이면 에러 | ✅ |

### 13-advanced-scenarios.spec.ts — 고급 시나리오

| # | 테스트 | 결과 |
|---|--------|------|
| 13-1 | save(detached 엔티티) → JPA-style merge UPDATE | ✅ |
| 13-2 | save(detached 변경 없음) → 데이터 유지 | ✅ |
| 13-3 | deleteById + @Transactional throw → rollback | ✅ |
| 13-4 | save + delete 연속 호출 → 정상 처리 | ✅ |
| 13-5 | save(유저 + posts) → Cascade.PERSIST 함께 저장 | ✅ |
| 13-6 | helper() API 상태 확인 | ✅ |
| 13-7 | saveAll() 혼합 상태 — new + managed → 모두 정상 | ✅ |
| 13-8 | deleteAll() → 여러 엔티티를 flush 1번으로 삭제 | ✅ |
| 13-9 | deleteAllByIds() → 단일 DELETE WHERE id IN (...) 쿼리 | ✅ |
| 13-10 | NestJS DI 주입 repo로 @Transactional 서비스에서 save(managed) → upsert 없이 dirty checking | ✅ |
| 13-11 | save() 없이 필드 수정만 → dirty checking으로 UPDATE | ✅ |

## B.3 테스트 카테고리별 요약

| 카테고리 | 테스트 수 | 관련 문서 |
|---------|----------|----------|
| persist & flush | 6 | 03장 |
| @Transactional | 6 + 5 | 04장, 11장 |
| Rollback-only (Spring 차이) | 7 | 04장 |
| FlushMode | 5 + 2 | 03장, 05장 |
| EM 컨텍스트 & 프록시 | 8 | 01장, 07장, 13장 |
| Dirty Checking | 4 | 08장 |
| save() 패턴 | 5 | 03장, 12장 |
| 연관관계 | 10 | 09장 |
| RequestContext | 4 | 13장 |
| 네이티브 연산 | 4 | 10장 |
| insertMany | 4 | 10장 |
| Readonly & CQRS | 15 | 05장, 06장 |
| TransactionalExplorer | 5 | 11장 |
| BaseRepository | 12 | 12장 |
| 고급 시나리오 | 11 | 12장 |
| **합계** | **106** | |

---

[← 이전: 부록 A. JPA 치트시트](./appendix-a-jpa-cheatsheet.md) | [목차로 돌아가기 →](./README.md)
