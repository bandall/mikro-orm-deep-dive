# 부록 A. Spring JPA ↔ MikroORM 치트시트

## A.1 핵심 개념 매핑

| Spring JPA | MikroORM | 비고 |
|-----------|----------|------|
| `EntityManager` | `EntityManager` | 거의 동일한 역할 |
| `EntityManagerFactory` | `MikroORM` | ORM 인스턴스 |
| `@PersistenceContext` | `constructor(private em: EntityManager)` | NestJS DI |
| `Persistence Context` | `Identity Map` + `Unit of Work` | 동일 개념 |
| `1차 캐시` | `Identity Map` | PK → 엔티티 매핑 |
| `Dirty Checking` | `Dirty Checking` | `__originalEntityData` 스냅샷 비교 |
| `flush()` | `em.flush()` | 변경 사항 DB 반영 |

## A.2 엔티티 상태

| 상태 | Spring JPA | MikroORM |
|------|-----------|----------|
| New | `new Entity()` | `em.create(Entity, data)` |
| Managed | `em.persist(entity)` | `em.persist(entity)` + `flush()` |
| Detached | `em.detach(entity)` | 다른 EM의 fork에서는 자동 detached |
| Removed | `em.remove(entity)` | `em.remove(entity)` |

## A.3 CRUD 연산

| 작업 | Spring JPA | MikroORM |
|------|-----------|----------|
| INSERT | `repo.save(newEntity)` | `em.persist(entity)` + `em.flush()` |
| SELECT | `repo.findById(id)` | `em.findOne(Entity, id)` |
| UPDATE | `repo.save(existingEntity)` | `entity.name = 'X'` + `em.flush()` |
| DELETE | `repo.delete(entity)` | `em.remove(entity)` + `em.flush()` |
| UPSERT | `repo.save(detached)` | `em.upsert(Entity, data)` |
| 벌크 INSERT | `repo.saveAll(list)` | `em.insertMany(Entity, dataList)` |
| 원자적 UPDATE | `@Query("UPDATE ...")` | `em.nativeUpdate(Entity, where, set)` |
| 벌크 DELETE | `repo.deleteAllById(ids)` | `em.nativeDelete(Entity, where)` |

## A.4 트랜잭션

| 기능 | Spring JPA | MikroORM |
|------|-----------|----------|
| 선언적 트랜잭션 | `@Transactional` | `@Transactional()` (커스텀 래퍼) |
| 프로그래밍 트랜잭션 | `TransactionTemplate` | `em.transactional(async (txEm) => {})` |
| 전파 (REQUIRED) | `@Transactional(propagation = REQUIRED)` | 기본 동작 (외부 TX 참여) |
| ReadOnly | `@Transactional(readOnly = true)` | `{ readOnly: true }` |
| Isolation Level | `@Transactional(isolation = ...)` | `{ isolationLevel: IsolationLevel.X }` |
| Rollback | 예외 시 자동 | 예외 시 자동 |
| **Rollback-only** | **inner throw → catch해도 rollback** | **catch하면 commit됨 (마킹 없음)** |

## A.5 관계

| 관계 | Spring JPA | MikroORM |
|------|-----------|----------|
| @OneToMany | `@OneToMany(mappedBy = "author")` | `@OneToMany(() => Book, b => b.author)` |
| @ManyToOne | `@ManyToOne @JoinColumn` | `@ManyToOne(() => Author)` |
| Cascade ALL | `cascade = CascadeType.ALL` | `cascade: [Cascade.PERSIST, Cascade.REMOVE]` |
| orphanRemoval | `orphanRemoval = true` | `orphanRemoval: true` |
| Eager Loading | `fetch = FetchType.EAGER` | `{ populate: ['books'] }` |
| Lazy Loading | `fetch = FetchType.LAZY` (기본) | 기본 (Collection 미초기화) |
| **Lazy 자동 로딩** | **프록시가 프로퍼티 접근 시 자동 SELECT** | **자동 로딩 없음 — `init()` 또는 `populate` 필수** |
| ManyToOne PK | FK이므로 자동 접근 | FK이므로 자동 접근 (동일) |
| ManyToOne 다른 필드 | 프록시가 자동 SELECT | **undefined (populate 필요)** |

## A.6 잠금

| 잠금 | Spring JPA | MikroORM |
|------|-----------|----------|
| 낙관적 잠금 | `@Version` | `@Property({ version: true })` |
| FOR UPDATE | `@Lock(PESSIMISTIC_WRITE)` | `{ lockMode: LockMode.PESSIMISTIC_WRITE }` |
| FOR SHARE | `@Lock(PESSIMISTIC_READ)` | `{ lockMode: LockMode.PESSIMISTIC_READ }` |
| NOWAIT | `@QueryHints(NOWAIT)` | `LockMode.PESSIMISTIC_WRITE_OR_FAIL` |
| SKIP LOCKED | `@QueryHints(SKIP_LOCKED)` | `LockMode.PESSIMISTIC_PARTIAL_WRITE` |

## A.7 쿼리

| 기능 | Spring JPA | MikroORM |
|------|-----------|----------|
| PK 조회 | `repo.findById(id)` | `em.findOne(Entity, id)` |
| 조건 조회 | `repo.findByName(name)` | `em.find(Entity, { name })` |
| 전체 조회 | `repo.findAll()` | `em.find(Entity, {})` |
| 카운트 | `repo.count()` | `em.count(Entity, {})` |
| 존재 확인 | `repo.existsById(id)` | `em.count(Entity, id) > 0` |
| JPQL/DQL | `@Query("SELECT ...")` | `em.createQueryBuilder(Entity)` |
| 네이티브 SQL | `@Query(nativeQuery = true)` | `em.getKnex()` / `em.execute()` |

## A.8 컨텍스트 격리

| 개념 | Spring JPA | MikroORM |
|------|-----------|----------|
| 요청별 격리 | `@PersistenceContext` (Thread-bound) | `RequestContext` / `em.fork()` |
| 새 컨텍스트 | `EntityManagerFactory.createEntityManager()` | `orm.em.fork()` |
| 컨텍스트 범위 | ThreadLocal (요청 스레드) | fork()된 EM 인스턴스 |

## A.9 MikroORM에만 있는 기능

| 기능 | 설명 |
|------|------|
| `em.fork()` | EM을 복제하여 독립된 Identity Map 생성 |
| `helper()` | 엔티티의 내부 상태(`__managed`, `__em` 등) 조회 |
| `disableIdentityMap` | Identity Map 없이 순수 읽기 |
| `disableTransactions` | 트랜잭션 없이 autocommit 모드 |
| `FlushMode.COMMIT` | 명시적 flush/commit 전까지 자동 flush 비활성화 |
| `raw()` | nativeUpdate에서 SQL 표현식 직접 사용 |
| `TransactionalExplorer` | 커스텀 em 자동 주입 패턴 |

---

[← 이전: 14. 트러블슈팅](./14-troubleshooting.md) | [다음: 부록 B. 테스트 결과 →](./appendix-b-test-results.md)
