# 18. readOnly 트랜잭션을 reader 로 — 전파·identity map·비동기 엣지

> 핵심 질문: `@Transactional({ readOnly: true })` 를 read replica 로 보내면, 전파·identity map·비동기 경계에서 쿼리는 어디로 가고 무엇이 깨지는가?

- 대상 구현: writer 연결의 `begin()` 을 감싸 readOnly 트랜잭션만 reader 에서 여는 드라이버 (`src/read-replica/read-replica.driver.ts`)
- 환경: MySQL 8.0 primary(server_id=1) → GTID 복제 → replica(server_id=2, `super_read_only`). MikroORM 7.0.2 (28-3 은 7.0.3 에서도 재현)
- 판정: 쿼리 안에서 `select @@server_id` 로 어느 인스턴스인지 본다. 데이터가 어디서 왔는지는 replica 적용을 멈춰(`stop replica sql_thread`) 두 인스턴스 값을 일부러 갈라서 확인한다
- 스펙: `test/read-replica/26~28` (29건)

```bash
./scripts/replica-up.sh                  # primary 3317 → replica 3318
RR_TEST=1 npx vitest run test/read-replica
```

## 18.1 동작 원리

MikroORM 은 readOnly 트랜잭션도 writer 연결에서 연다. 드라이버가 writer 연결의 `begin()` 을 감싸서, `readOnly` 이고 바깥 트랜잭션(`ctx`)이 없을 때만 reader 연결에서 `SET TRANSACTION READ ONLY` + `BEGIN` 한다.

- **라우팅은 "새 트랜잭션을 여는 순간" 한 번만 정해진다.** 이후 트랜잭션 안의 모든 쿼리(조회·flush·raw SQL·SAVEPOINT)는 그 연결을 따라간다.
- 트랜잭션 밖 쿼리는 `preferReadReplicas: false` 라 writer 로 간다.
- replica 를 설정하지 않으면 writer 에서 READ ONLY 트랜잭션이 열려 쓰기는 그래도 막힌다(1792).

## 18.2 먼저 — 전파 3종과 NESTED

| 전파 | 안쪽이 하는 일 | 안쪽 실패 시 | 안쪽 커밋 시점 |
|---|---|---|---|
| REQUIRED | 바깥 트랜잭션에 합류 | 바깥까지 롤백 (단, MikroORM 은 바깥이 catch 하면 커밋 — 04장 §4.5) | 바깥과 함께 |
| NESTED | 같은 연결에 `SAVEPOINT` | savepoint 까지만 롤백, 바깥 계속 | 바깥과 함께 (savepoint 만 해제) |
| REQUIRES_NEW | 새 연결로 별도 트랜잭션 | 안쪽만 롤백 | 즉시 독립 커밋 |

**기본값이 서로 다르다.** `@Transactional()` 데코레이터는 REQUIRED, `em.transactional(cb)` 는 **NESTED** 다. 옵션 없이 `em.transactional()` 을 바깥 트랜잭션 안에서 부르면 SAVEPOINT 로 동작한다. Spring 의 JPA 트랜잭션 매니저는 NESTED 를 지원하지 않아(`NestedTransactionNotSupportedException`) Spring 출신에게는 낯선 전파다.

## 18.3 전파 매트릭스 (26)

| # | 상황 | 결과 |
|---|---|---|
| 26-1 | 트랜잭션 밖 / readOnly / RW | primary / **replica** / primary |
| 26-2 | RW → readOnly(REQUIRED) | 합류 → primary, 안에서 쓰기 **성공** (참여 트랜잭션의 readOnly 는 무시) |
| 26-3 | readOnly → RW(REQUIRED) | 합류 → replica, 쓰기는 **DB 가 거부**(replica 1290 / READ ONLY 1792) |
| 26-4 | readOnly → readOnly | replica 합류 |
| 26-5 | readOnly → RW(REQUIRES_NEW) | primary 새 트랜잭션, 독립 커밋. 끝나면 바깥 replica 로 복귀 |
| 26-6 | 위에서 쓴 행을 바깥 readOnly 가 읽기 | **안 보임** (replica 지연 + 바깥 스냅샷) |
| 26-7 | RW → readOnly(REQUIRES_NEW) | replica 새 트랜잭션. 바깥이 쓴 **미커밋 행을 못 봄** |
| 26-8 | RW → readOnly(NESTED) | SAVEPOINT 는 바깥 연결(primary). **readOnly 무시, 쓰기 성공** |
| 26-9 | RW → `em.transactional(cb, { readOnly: true })` | 기본 전파가 NESTED 라 26-8 과 같음 |
| 26-10 | readOnly → `em.transactional()` | replica SAVEPOINT, 쓰기 거부 |
| 26-11 | readOnly → NOT_SUPPORTED | 트랜잭션 밖 → **primary, 쓰기도 됨** (탈출구) |
| 26-12 | 바깥 없음 + readOnly SUPPORTS | 트랜잭션이 안 열려 **primary** |
| 26-13 | readOnly MANDATORY | 바깥 없으면 예외, 있으면 합류 |
| 26-14 | RW 커밋 직후 같은 요청의 readOnly 조회 | 방금 `create` 한 엔티티도 PK 조회가 replica 로 가서 **null** (18.4) |

## 18.4 identity map 엣지 (27)

MikroORM 은 트랜잭션마다 요청 EM 을 `fork({ clear: false })` 하고, 커밋 뒤 엔티티를 요청 EM 으로 되돌린다(`mergeEntitiesToParent`). 그래서 **replica 에서 읽은 엔티티가 같은 요청의 쓰기 트랜잭션으로 넘어간다.**

| # | 상황 | 결과 |
|---|---|---|
| 27-1 | readOnly 로 읽음(replica age=10, primary=20) → 같은 요청 RW 에서 **PK** 재조회 후 +5 | 쿼리 없이 캐시(10)가 나와 primary 에 **15** 저장. **갱신 유실** |
| 27-2 | 같은 상황에서 `refresh: true` | primary 를 다시 읽어 25. 해결책 |
| 27-3 | 같은 상황에서 RW 의 **조건(비 PK)** 조회 | primary 를 읽고 관리 중인 엔티티를 최신값(20)으로 갱신 |
| 27-4 | primary 값(20)을 가진 채 readOnly 조회 | PK 조회는 캐시 20, `count({age:20})` 은 replica 기준 0. **한 트랜잭션 안에서 서로 어긋난 값** |
| 27-5 | readOnly 안에서 엔티티 필드를 고침 | 커밋 flush 가 replica 에 UPDATE → 메서드 전체 예외 |
| 27-6 | 요청 EM 에 flush 안 된 변경이 있는 채 **무관한** readOnly 조회 | fork 가 그 dirty 엔티티를 물려받아 커밋 flush → **조회 메서드가 실패** |
| 27-7 | readOnly 에서 읽은 엔티티를 트랜잭션 밖에서 populate | primary 로 감 |

PK 캐시가 언제 쓰이는가: `findOne` 은 identity map 에 있어도 `shouldRefresh` 가 참이면(부분 로딩 등) DB 를 친다. `em.create` 로 만든 엔티티는 nullable 컬럼이 비어 부분 로딩으로 취급돼 26-14 에서 replica 로 갔다. `find` 로 완전히 로딩된 엔티티는 27-1 처럼 캐시를 준다.

## 18.5 비동기·장애 (28)

| # | 상황 | 결과 |
|---|---|---|
| 28-1 | readOnly 안 `Promise.all` | 한 연결에서 순차 실행, 모두 replica |
| 28-2 | readOnly 안에서 시작해 커밋 뒤 실행된 쿼리(await 누락·setTimeout) | `Transaction is already committed` |
| 28-3 | 같은 상황의 쓰기(이벤트 리스너 흉내) | 같은 에러. **writer 로 가지 않는다** |
| 28-3b | 일반 RW 트랜잭션에서도 | 같은 에러. readOnly 고유 문제가 아니다 |
| 28-3c | 커밋 뒤 콜백이 `em.fork()` 사용 | primary 정상 |
| 28-3d | 커밋 뒤 콜백을 `RequestContext.create(orm.em, …)` 로 감쌈 | **여전히 실패.** 전역 EM 은 TransactionContext 를 RequestContext 보다 먼저 본다 |
| 28-4 | replica 접속 불가 | readOnly 는 실패, primary 우회 없음. 트랜잭션 밖 조회는 정상 |
| 28-5 | replica 미설정 | primary 에서 READ ONLY 트랜잭션, 쓰기 1792 |

AsyncLocalStorage 는 비동기 흐름이 계속 이어지므로, 트랜잭션 안에서 걸어 둔 비동기 작업은 끝난 트랜잭션을 붙잡는다. 트랜잭션 안에서 이벤트를 발행하고 리스너가 DB 를 쓰면 이 경로를 탄다.

## 18.6 유의할 점

1. **같은 요청에서 readOnly 조회 뒤 쓰기를 하면 갱신이 유실될 수 있다** (27-1). 쓰기 쪽에서 `refresh: true` 로 다시 읽거나, 그 조회는 readOnly 로 돌리지 않는다.
2. **요청 EM 에 flush 안 된 변경이 있으면 무관한 readOnly 조회가 실패한다** (27-6).
3. **readOnly 안에서 엔티티를 고치면 메서드가 예외로 끝난다** (27-5). 조회 중 정규화 같은 변경을 두지 않는다.
4. **readOnly 가 조용히 무시되는 자리가 있다** (26-8, 26-9). RW 안의 `em.transactional(…, { readOnly: true })` 와 readOnly NESTED 는 primary SAVEPOINT 라 쓰기가 성공한다.
5. **바깥 트랜잭션 없는 readOnly SUPPORTS 는 reader 로 가지 않는다** (26-12).
6. **REQUIRES_NEW 경계에서는 서로의 쓰기가 안 보인다** (26-6, 26-7). replica 지연과 스냅샷이 겹친다.
7. **트랜잭션 안에서 걸어 둔 비동기 작업은 커밋 뒤 실패한다** (28-3). `RequestContext.create` 로도 못 막고, `em.fork()` 로 새 EM 을 써야 한다.
8. **`em.fork()` 로 만든 EM 은 트랜잭션 밖이라 primary 로 간다.**
9. **방금 `create` 한 엔티티도 readOnly PK 조회는 replica 로 가서 null 이다** (26-14).

## 18.7 Spring 과 갈리는 곳

같은 primary/replica 에 Spring Boot 4.1(Hibernate 7.4, OSIV 꺼짐)을 붙여 같은 케이스를 돌려 봤다. 라우팅·전파는 대부분 같고 아래 네 곳만 다르다.

- **27-1**: Spring 은 트랜잭션마다 영속성 컨텍스트가 새로 열려 primary 값 20 을 읽고 25 를 저장한다. MikroORM 의 갱신 유실은 요청 EM 공유에서 온다.
- **27-5**: Spring 은 readOnly 세션이 dirty checking 을 하지 않아 변경을 조용히 버리고 정상 반환한다.
- **26-8**: Spring(JPA 트랜잭션 매니저)은 NESTED 에서 `NestedTransactionNotSupportedException`.
- **26-12**: Spring 은 라우팅 방식에 따라 갈린다. `AbstractRoutingDataSource`(`isCurrentTransactionReadOnly`) 는 replica, `LazyConnectionDataSourceProxy#setReadOnlyDataSource` 는 primary.
