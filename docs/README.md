# MikroORM v7 — NestJS 실전 가이드

> 120개 테스트로 검증한 실제 동작 기반의 학습 문서

## Part 1. 핵심 개념


| #                               | 주제              | 핵심 질문                                       |
| ------------------------------- | --------------- | ------------------------------------------- |
| [01](./01-entity-manager.md)    | EntityManager   | EM은 무엇이고, fork()는 왜 필요한가?                   |
| [02](./02-entity-states.md)     | 엔티티 상태 머신       | New, Managed, Detached, Removed는 어떻게 전이되는가? |
| [03](./03-persist-and-flush.md) | persist & flush | persist와 flush는 왜 분리되어 있는가?                 |


## Part 2. 트랜잭션


| #                                 | 주제                     | 핵심 질문                              |
| --------------------------------- | ---------------------- | ---------------------------------- |
| [04](./04-transactional.md)       | @Transactional() 데코레이터 | 데코레이터 하나로 트랜잭션이 어떻게 관리되는가?         |
| [05](./05-readonly-cqrs.md)       | Readonly 트랜잭션 & CQRS   | 읽기 전용 트랜잭션은 ORM 레벨인가, DB 레벨인가?     |
| [06](./06-pessimistic-locking.md) | 비관적 잠금                 | FOR UPDATE/FOR SHARE는 언제, 어떻게 쓰는가? |


## Part 3. Identity Map & Dirty Checking


| #                            | 주제             | 핵심 질문                          |
| ---------------------------- | -------------- | ------------------------------ |
| [07](./07-identity-map.md)   | Identity Map   | 같은 PK를 두 번 조회하면 어떻게 되는가?       |
| [08](./08-dirty-checking.md) | Dirty Checking | UPDATE SQL은 언제, 어떤 기준으로 생성되는가? |


## Part 4. 관계 & 고급 패턴


| #                             | 주제    | 핵심 질문                                    |
| ----------------------------- | ----- | ---------------------------------------- |
| [09](./09-relations.md)       | 연관관계  | Cascade와 orphanRemoval은 어떻게 동작하는가?       |
| [10](./10-bulk-operations.md) | 벌크 연산 | insertMany와 nativeUpdate는 EM을 어떻게 우회하는가? |


## Part 5. JPA 호환 레이어


| #                                    | 주제                    | 핵심 질문                                      |
| ------------------------------------ | --------------------- | ------------------------------------------ |
| [11](./11-transactional-explorer.md) | TransactionalExplorer | em을 매번 주입하지 않고도 @Transactional()을 쓸 수 있는가? |
| [12](./12-base-repository.md)        | BaseRepository        | JPA의 save()처럼 INSERT/UPDATE를 자동 판단할 수 있는가? |


## Part 6. 실전 레시피


| #                                | 주제           | 핵심 질문                              |
| -------------------------------- | ------------ | ---------------------------------- |
| [13](./13-nestjs-integration.md) | NestJS 통합 설정 | MikroORM + NestJS 프로젝트를 어떻게 구성하는가? |
| [14](./14-troubleshooting.md)    | 트러블슈팅 & FAQ  | 실전에서 자주 만나는 문제와 해결법은?              |


## 부록


| #                                   | 주제                           |
| ----------------------------------- | ---------------------------- |
| [A](./appendix-a-jpa-cheatsheet.md) | Spring JPA <-> MikroORM 치트시트 |
| [B](./appendix-b-test-results.md)   | 테스트 결과 요약 (120개)             |


