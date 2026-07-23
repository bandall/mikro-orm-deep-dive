# 16. EM fork-split — commons 근본 픽스 실행 계획 + pluglink-backend 현황 (2026-06-25)

> [15. EM fork-split](./15-em-fork-split.md) 분석을 실제 라이브 테스트로 재현·확인하고, commons 근본 픽스(§15.7 옵션 C) 착수를 위한 실행 계획과 현 레포 현황을 정리한다. 일반 액션플랜은 [99-pluglink-action-plan §2](./99-pluglink-action-plan.md) 참조.

## 16.1 발견 경위 (라이브 재현)

roamings(PostgreSQL) 배터리 키 발급 경로(PLU-1741)에서 발생. 단위/통합 테스트는 전부 통과했으나 **로컬 실 서버 + SQS 메시지** 테스트로만 드러남:

- `BatteryKeyRegisterHandler`(@EnsureRequestContext) 가 `keyRepo.findByChargers` 로 기존 키 행을 **EM_req 에서 먼저 로드**(`__em=EM_req`) → `issueKeys` → `MeBatteryKeyWriterService.persistResults`(@Transactional, child fork) 안에서 `keyRepo.saveAll(기존행)` → Case1 가드(`__em===ctxEm`) 깨짐 → Case3 `em.upsert` → PG `GENERATED ALWAYS as IDENTITY` id INSERT 거부.
- 증상: `DriverException: cannot insert a non-DEFAULT value into column "id"`. 기존 행 UPDATE 경로(재발급/MAINTAINED/renew) 전부 실패 + TX 전체 롤백.
- **doc 15 의 토폴로지와 동일**. (단 doc 15 repro 는 MySQL → upsert routing 만 보이고 IDENTITY 에러는 안 남.)

usage 픽스(§15.6 A 변형)로 봉합: `persistBatch` 에서 `keys.filter(k => !k.id)` 로 **신규(PK 없음)만 saveAll(persist→INSERT), 기존 행은 dirty-flush**. roamings 커밋 `52708d2d`. 라이브 재검증 완료(RENEWED UPDATE / MAINTAINED no-op / 드리프트 self-heal UPDATE).

## 16.2 pluglink-backend 현황 — fork-split 전수 감사 (2026-06-25)

`.save(`/`.saveAll(` 호출 ~42개 전수 점검 결과:

| 위험도 | 건수 | 비고 |
|--------|------|------|
| **High** | **0** | 현 체크아웃에 실제 에러 유발 사이트 없음 |
| Med | 0 | |
| Low | 16 | 아래 |

**DB 드라이버가 위험도를 가름:**
- **roamings = PostgreSQL** → fork-split 이 실제 IDENTITY 에러로 터지는 **유일한 서비스**.
- chargers/auths/payments/users/managements/apps = **MySQL**(AUTO_INCREMENT) → 메커니즘은 동일 발생하나 explicit-id INSERT 허용 → **silent upsert 로 degrade**(크래시 無, 동일 PK 재기록이라 정합성 문제도 無).

**진성 PG 위험 2곳 — 둘 다 이미 막힘:**
1. `roamings/trades/inbound/inbound-trade.service`(PLU-1670) — doc 15 의 원본 케이스. `recordPending`=신규 `create()→save`(Case2), `markResult`=loaded 는 dirty-flush(save 없음). 주석에 메커니즘 명시.
2. `roamings/me/battery/services/me-battery-key-writer.service`(PLU-1741) — PK 필터 dirty-flush(`52708d2d`).

**Low 분류(안전 이유):**
- roamings `charger-device-replace.handler` / `status-notification.handler`(applyStatusUpdate) / `card-writer.service` — find+save 가 **같은 @Transactional fork** 안(외부 pre-load 없음) → Case1 dirty-flush. (배터리가 유일하게 깨진 건 핸들러가 외부에서 먼저 load 했기 때문.)
- users/apps 의 loaded-save 사이트(HTTP, @Transactional 없음) — MySQL silent upsert, 동일 PK.
- 제외: NEW-only `create()→save` 다수, DynamoDB 리포(MikroORM 아님), same-fork.

→ **현재 배포 안전**. commons 근본 픽스는 "전 서비스 면역" 방어이지 긴급 불 끄기 아님.

## 16.3 인터넷 조사 — 알려진 이슈 & 권장

- `em.upsert` 는 v7 부터 **managed 여부와 무관하게 항상 upsert 발행**(v6 은 managed 면 assign). → commons Case3 가 실제 upsert 로 나가는 직접 원인. ([#7399](https://github.com/mikro-orm/mikro-orm/issues/7399), [#7400 fix](https://github.com/mikro-orm/mikro-orm/commit/5bc0e923e92e6e5424e38c7488c4909303761c89))
- **GENERATED ALWAYS IDENTITY PK 엔 upsert 가 구조적으로 부적합** — INSERT 절에 id 가 실리고 MikroORM 은 `OVERRIDING SYSTEM VALUE` 미발행. app-side PK 는 `defaultRaw: gen_random_uuid()` 로 우회 가능하나 GENERATED ALWAYS 엔 우회 없음. ([discussion #4532](https://github.com/mikro-orm/mikro-orm/discussions/4532), [#4242](https://github.com/mikro-orm/mikro-orm/issues/4242))
- **fork `clear:false` + managed 재사용 + dirty-flush 는 MikroORM 의 의도된 설계** — 공식 [Transactions 문서](https://mikro-orm.io/docs/transactions)가 "outer load → @Transactional 안 mutate → 커밋이 flush" 를 직접 예시(`user.isActive=true`, save 없음). → **usage dirty-flush 픽스는 관용적**.

결론: upsert 는 IDENTITY 업데이트에 부적합, managed 는 dirty-flush 가 정석. 우리 방향이 공식 권장과 정합.

## 16.4 commons 근본 픽스 (§15.7 옵션 C) — 구현 검토

`BaseRepository.save()` / `saveAll()` 의 Case1 가드를 **EM 포인터 → UoW 멤버십**으로:

```typescript
// 기존 (fork-split 에서 false negative)
if (wrapped.__managed && wrapped.__em === em) return entity;

// 수정 — "이 인스턴스가 현재 em 의 identity map 에 있나"
const inThisUow =
  wrapped.hasPrimaryKey() &&
  em.getUnitOfWork().getById(this.entityName, wrapped.getPrimaryKey()) === entity;
if (wrapped.__managed && inThisUow) return entity;
```

근거(v7.0.4 소스 확인): ① `TransactionManager.js:132` fork `clear: options.clear ?? false`(부모 map 상속) ② `TransactionManager.js:155` `mergeEntitiesToParent` `helper(entity).__em = parent` ③ `UnitOfWork.js:126` `wrapped.__em ??= this.#em`(이미 있으면 안 바꿈) → 한 인스턴스가 여러 UoW 에 동시 존재하나 `__em` 은 부모 하나만 가리킴 → 포인터 비교 false negative. UoW 멤버십은 "현재 map 존재" = dirty-flush 가능 조건과 정확히 일치.

**검토 결과:**
- ✅ fork-split 정확히 해결(managed-in-fork → no-op → dirty-flush UPDATE). 공식 설계와 정합.
- ⚠️ **Case3(`em.upsert`)는 유지** → 진짜 detached 엔티티를 IDENTITY 테이블에 save 하면 여전히 깨짐. 단 감사상 사용처 0 → 잠복으로 남기고 주석 명시. (Case3 까지 손대면 scope·회귀 ↑.)
- save/saveAll 공통 → `private isManagedHere()` helper 추출.
- ⚠️ **옵션 C 는 mikro-orm-test 에 아직 미테스트** — doc 15.7 은 분석/제안만(`getById` grep 0건). 아래 회귀로 직접 검증 필요.

## 16.5 테스트 계획 (commons 회귀)

**위치**: pluglink-commons 레포. **PostgreSQL 테스트 컨테이너 필요**(실제 IDENTITY 에러 발현 — 이 레포의 doc 15 repro 는 MySQL 이라 routing 만 보임). ← 첫 인프라 스텝.

**하니스**: doc 15 repro 패턴(`test/jpa-compat/15-em-fork-split-repro.spec.ts`) 재사용 — `Test.createTestingModule` + `MikroOrmModule.forRootAsync(registerRequestContext:true, allowGlobalContext:false)` + `@EnsureRequestContext` 컨슈머 + `@Transactional` 서비스 + **GENERATED ALWAYS IDENTITY 엔티티(PG)**.

**4 케이스 (가드 old↔new 토글로 teeth 검증):**

| # | 시나리오 | OLD 가드 | NEW 가드 |
|---|----------|----------|----------|
| 1 | fork-split managed (외부 load → @Transactional save) | upsert → **PG IDENTITY 에러** | plain UPDATE ✅ |
| 2 | 진짜 detached (다른 em load, B 에서 save) | upsert | upsert (보존) |
| 3 | 정상 managed (같은 em load+save) | no-op → dirty UPDATE | 동일 |
| 4 | 신규 (PK 없음) | persist INSERT | 동일 |

- **teeth**: 케이스1 을 OLD=FAIL(IDENTITY)/NEW=PASS(UPDATE) 로 토글 확인 → 픽스 유효성 증명.
- **cross-service 회귀**: commons 공유라 픽스+publish 후 각 서비스 dep bump + 테스트 재실행(save/saveAll ~42 사용처, 대부분 MySQL — new/managed/detached 동작 불변 확인). 감사상 위험 0 이라 통과 기대.

## 16.6 우선순위

- **긴급도: 중-하**. roamings 진성 위험 2곳 이미 봉합, MySQL 서비스는 무해. 근본 픽스는 신규 코드의 잠복 방지 + 전 서비스 면역용.
- 신규 코드 관행(픽스 전까지): **loaded 엔티티는 dirty-flush, `save()`는 신규 INSERT 에만**. (inbound-trade 에 주석 선례.)
