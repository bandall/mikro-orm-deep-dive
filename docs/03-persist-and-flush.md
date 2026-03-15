# 03. persist & flush — 쓰기의 두 단계

> **핵심 질문**: persist와 flush는 왜 분리되어 있는가?

## 3.1 두 단계의 분리

MikroORM의 쓰기는 두 단계로 나뉜다:

```mermaid
sequenceDiagram
    participant Code as 애플리케이션 코드
    participant UoW as Unit of Work<br/>(메모리)
    participant DB as 데이터베이스

    Code->>UoW: em.persist(entity)
    Note over UoW: "추적 목록에 추가"<br/>SQL 아직 없음

    Code->>UoW: em.persist(entity2)
    Note over UoW: "추적 목록에 추가"<br/>SQL 아직 없음

    Code->>UoW: await em.flush()
    UoW->>UoW: 변경 감지 (Dirty Checking)
    UoW->>DB: BEGIN
    UoW->>DB: INSERT entity
    UoW->>DB: INSERT entity2
    UoW->>DB: COMMIT
    DB-->>UoW: OK
```

| 단계 | 메서드 | 하는 일 | SQL 실행 |
|------|--------|---------|---------|
| **추적** | `em.persist(entity)` | Unit of Work에 등록 | X |
| **실행** | `await em.flush()` | 변경 감지 → SQL 생성 → DB 전송 | O |

## 3.2 왜 분리했는가?

### 배치 최적화

```typescript
// ❌ 비효율 — INSERT 3번, 트랜잭션 3번
await em.persistAndFlush(user1);
await em.persistAndFlush(user2);
await em.persistAndFlush(user3);

// ✅ 효율 — INSERT 3번이지만 트랜잭션 1번
em.persist(user1);
em.persist(user2);
em.persist(user3);
await em.flush();  // BEGIN → INSERT × 3 → COMMIT
```

### 의존 관계 자동 정렬

```typescript
const author = em.create(Author, { name: 'Kim' });
const book = em.create(Book, { title: 'ORM Guide', author });
// author가 먼저 INSERT되어야 book의 FK가 유효

em.persist(author);
em.persist(book);
await em.flush();
// MikroORM이 자동으로 author → book 순서로 INSERT
```

## 3.3 em.create() vs new Entity()

MikroORM v7에서 `em.create()`는 **자동으로 persist**를 호출한다:

```typescript
// em.create() — persist 자동 호출
const user = em.create(User, { name: 'Alice' });
// → 이미 Unit of Work에 등록됨
await em.flush();  // INSERT 실행

// new Entity() — 수동 persist 필요
const user2 = new User();
user2.name = 'Bob';
em.persist(user2);  // 명시적으로 등록해야 함
await em.flush();
```

> **권장**: `em.create()`를 사용하라. 타입 안전성도 제공한다.

## 3.4 FlushMode — flush 타이밍 제어

```mermaid
graph TD
    subgraph "FlushMode.AUTO (기본값)"
        A1[persist] --> B1[find 호출]
        B1 --> C1{pending INSERT?}
        C1 -->|있음| D1[자동 flush → SELECT]
        C1 -->|없음| E1[바로 SELECT]
    end

    subgraph "FlushMode.COMMIT"
        A2[persist] --> B2[find 호출]
        B2 --> E2[바로 SELECT<br/>flush 안 함]
        E2 --> F2[트랜잭션 COMMIT 시<br/>flush]
    end

    subgraph "FlushMode.ALWAYS"
        A3[persist] --> B3[find 호출]
        B3 --> D3[항상 flush → SELECT]
    end
```

| 모드 | 자동 flush 시점 | 용도 |
|------|----------------|------|
| `AUTO` | SELECT 전에 pending INSERT가 있으면 | 기본값, 대부분의 경우 |
| `COMMIT` | 트랜잭션 COMMIT 시에만 | 읽기 전용 컨텍스트 |
| `ALWAYS` | 매 쿼리 전 항상 | dirty UPDATE도 자동 flush 필요할 때 |

### AUTO의 함정

**AUTO는 pending INSERT만 자동 flush한다. dirty UPDATE는 flush하지 않는다.**

```typescript
// FlushMode.AUTO에서의 동작

// Case 1: INSERT — 자동 flush됨 ✅
em.persist(em.create(Author, { name: 'New' }));
const found = await em.find(Author, {});
// → INSERT가 먼저 실행되고 SELECT → 'New' 포함됨

// Case 2: UPDATE — 자동 flush 안 됨 ⚠️
const author = await em.findOne(Author, 1);
author.name = 'Changed';
const result = await em.find(Author, { name: 'Changed' });
// → UPDATE 없이 SELECT → DB에서는 아직 'Changed'가 아님!
// → Identity Map에 있으므로 결과는 상황에 따라 다름
```

> **Spring JPA와의 차이**: JPA의 FlushMode.AUTO는 dirty UPDATE도 자동 flush한다.
> MikroORM은 다르다. 명시적으로 `flush()`를 호출하거나 `FlushMode.ALWAYS`를 사용해야 한다.

## 3.5 persist vs persistAndFlush

```
em.persist(entity)         →  추적만 (SQL 없음)
await em.flush()           →  모든 변경 사항 한 번에 실행

await em.persistAndFlush(entity)  →  persist + flush 한 번에
                                     (편리하지만 비효율적일 수 있음)
```

## 3.6 flush가 하는 일 (내부 동작)

```
flush() 호출
  │
  ├─ 1. Change Set 계산
  │     - New 엔티티 → INSERT
  │     - Dirty 엔티티 → UPDATE (변경된 필드만)
  │     - Removed 엔티티 → DELETE
  │
  ├─ 2. 실행 순서 정렬
  │     - FK 의존성 순서대로 정렬
  │     - INSERT: 부모 → 자식
  │     - DELETE: 자식 → 부모
  │
  ├─ 3. 트랜잭션 실행
  │     - BEGIN
  │     - SQL 실행 (INSERT, UPDATE, DELETE)
  │     - COMMIT
  │
  └─ 4. Identity Map 갱신
        - __originalEntityData 업데이트
        - Removed 엔티티 제거
```

## 3.7 검증된 동작 (테스트 기반)

| 테스트 | 검증 내용 |
|--------|----------|
| 1-1 | 새 엔티티 persist + flush → INSERT |
| 1-2 | managed 엔티티에 persist + flush (변경 없음) → 쿼리 없음 |
| 1-3 | 새 엔티티 persist 2번 + flush → INSERT 1회 (Set 중복 무해) |
| 1-6 | em.create() + flush (persist 호출 없이) → persistOnCreate 동작 확인 |
| 3-1 | FlushMode.AUTO — persist(Author) → find(Author) → auto flush 후 조회 |
| 3-4 | FlushMode.AUTO — dirty UPDATE는 auto flush 안 됨 |
| 3-5 | FlushMode.COMMIT — persist → find → flush 안 함 |

---

[← 이전: 02. 엔티티 상태 머신](./02-entity-states.md) | [다음: 04. @Transactional() →](./04-transactional.md)
