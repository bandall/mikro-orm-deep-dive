# MikroORM v7 — NestJS 실전 가이드

> 120개 테스트로 검증한 실제 동작 기반의 학습 문서

> **Note**: 이 문서는 Claude를 활용하여 작성되었습니다. 테스트로 검증했으나, 부정확한 내용이 포함되어 있을 수 있습니다.

## 소개

Spring JPA(Hibernate) 경험자를 위한 MikroORM v7 + NestJS 학습 프로젝트입니다.

"문서에 적힌 동작이 실제로 그런가?"를 확인하기 위해, **모든 설명을 테스트 코드로 검증**했습니다. 문서만 읽어도 되지만, 테스트를 직접 실행하면 더 확실하게 이해할 수 있습니다.

### 다루는 내용

- EntityManager, Identity Map, Dirty Checking 등 ORM 핵심 개념
- `@Transactional()` 전파, rollback, Spring과의 차이
- Cascade, orphanRemoval, Lazy/Eager Loading
- JPA-like `BaseRepository`, `TransactionalExplorer` 구현
- NestJS 통합 설정, RequestContext, 비-HTTP 컨텍스트 처리

### 대상 독자

- Spring JPA → MikroORM 전환을 고려하는 개발자
- MikroORM + NestJS 프로젝트를 처음 구성하는 개발자
- ORM 내부 동작을 정확히 이해하고 싶은 개발자

## 시작하기

```bash
# 의존성 설치
npm install

# MySQL 컨테이너 실행
docker compose up -d

# 테스트 실행 (120개)
npx vitest run
```

## 프로젝트 구조

```
├── docs/                    # 학습 문서 (14장 + 부록 2개)
├── src/
│   ├── behavior/            # ORM 동작 검증 모듈
│   │   ├── entities/        #   Author, Book 엔티티
│   │   ├── repositories/    #   커스텀 레포지토리
│   │   └── services/        #   Outer/Inner 서비스 (트랜잭션 전파 테스트용)
│   └── jpa-compat/          # JPA 호환 레이어
│       ├── base.repository.ts        # BaseRepository (save, delete, findById 등)
│       ├── transactional.decorator.ts # 커스텀 @Transactional()
│       ├── transactional.explorer.ts  # em 자동 주입
│       ├── entities/        #   User, Post 엔티티
│       ├── repositories/    #   커스텀 레포지토리
│       └── services/        #   UserService, OrderService
└── test/
    ├── behavior/            # 78개 — ORM 핵심 동작 테스트
    └── jpa-compat/          # 26개 — JPA 호환 레이어 테스트
```

## 목차

### Part 1. 핵심 개념

| # | 주제 | 핵심 질문 |
|---|------|----------|
| [01](./docs/01-entity-manager.md) | EntityManager | EM은 무엇이고, fork()는 왜 필요한가? |
| [02](./docs/02-entity-states.md) | 엔티티 상태 머신 | New, Managed, Detached, Removed는 어떻게 전이되는가? |
| [03](./docs/03-persist-and-flush.md) | persist & flush | persist와 flush는 왜 분리되어 있는가? |

### Part 2. 트랜잭션

| # | 주제 | 핵심 질문 |
|---|------|----------|
| [04](./docs/04-transactional.md) | @Transactional() 데코레이터 | 데코레이터 하나로 트랜잭션이 어떻게 관리되는가? |
| [05](./docs/05-readonly-cqrs.md) | Readonly 트랜잭션 & CQRS | 읽기 전용 트랜잭션은 ORM 레벨인가, DB 레벨인가? |
| [06](./docs/06-pessimistic-locking.md) | 비관적 잠금 | FOR UPDATE/FOR SHARE는 언제, 어떻게 쓰는가? |

### Part 3. Identity Map & Dirty Checking

| # | 주제 | 핵심 질문 |
|---|------|----------|
| [07](./docs/07-identity-map.md) | Identity Map | 같은 PK를 두 번 조회하면 어떻게 되는가? |
| [08](./docs/08-dirty-checking.md) | Dirty Checking | UPDATE SQL은 언제, 어떤 기준으로 생성되는가? |

### Part 4. 관계 & 고급 패턴

| # | 주제 | 핵심 질문 |
|---|------|----------|
| [09](./docs/09-relations.md) | 연관관계 | Cascade와 orphanRemoval은 어떻게 동작하는가? |
| [10](./docs/10-bulk-operations.md) | 벌크 연산 | insertMany와 nativeUpdate는 EM을 어떻게 우회하는가? |

### Part 5. JPA 호환 레이어

| # | 주제 | 핵심 질문 |
|---|------|----------|
| [11](./docs/11-transactional-explorer.md) | TransactionalExplorer | em을 매번 주입하지 않고도 @Transactional()을 쓸 수 있는가? |
| [12](./docs/12-base-repository.md) | BaseRepository | JPA의 save()처럼 INSERT/UPDATE를 자동 판단할 수 있는가? |

### Part 6. 실전 레시피

| # | 주제 | 핵심 질문 |
|---|------|----------|
| [13](./docs/13-nestjs-integration.md) | NestJS 통합 설정 | MikroORM + NestJS 프로젝트를 어떻게 구성하는가? |
| [14](./docs/14-troubleshooting.md) | 트러블슈팅 & FAQ | 실전에서 자주 만나는 문제와 해결법은? |

### 부록

| # | 주제 |
|---|------|
| [A](./docs/appendix-a-jpa-cheatsheet.md) | Spring JPA <-> MikroORM 치트시트 |
| [B](./docs/appendix-b-test-results.md) | 테스트 결과 요약 (120개) |

## 기술 스택

- **MikroORM** v7 + MySQL 드라이버
- **NestJS** v11
- **Vitest** — 테스트 프레임워크
- **Docker Compose** — MySQL 로컬 환경
