# 세션 맥락 — mikro-orm-fix (2026-07-21)

> ## ⭐ 최종 업데이트 (2026-07-22) — 아래 본문보다 이게 우선
> **설계 변경**: "무조건 flush"에서 **옵션 파라미터**로 전환.
> - `save(entity, opts?: { flush?: boolean })` / `saveAll(entities, opts?)` — **기본 `flush:false`(persist-only, 커밋 시 flush) = 프로덕션 현행과 동일 → 회귀 0**. id/부수효과 필요 시 `{ flush: true }`.
> - Case1: `__em` 포인터 → **UoW 멤버십**(`getUnitOfWork().getById(name, pk, getSchema()) === entity`). `isManaged()`/`getSchema()` 공개 API.
> - **Case3(detached upsert)·Case4(autoincrement PK 오용)**: 동작 보존 + **warn 로그**(throw 아님 → 회귀 0). (Case4는 throw→warn 다운그레이드 결정)
> - **핵심 근거**: 커밋된 프로덕션 commons `save()`가 원래 no-flush(`git show HEAD:...base.repository.ts` 확인). 결함 A 사이트는 이미 호출부 createAndFlush로 봉합됨 → 기본 no-flush는 프로덕션 대비 회귀 없음. **대규모 마이그레이션 불필요**({flush:true} 전환은 선택적 정리).
> - **검증**: 스펙 15~23 **66/66 PASS**(MySQL:3307 + PG:5433). spec 22=PG GENERATED ALWAYS teeth(5/5), 21=실 NestJS HTTP/SQS e2e(6/6, src/jpa-compat/e2e-final/), 23=옵션 flush 계약(6/6), 20=nested @Transactional(9/9). 실행: `npx vitest run test/jpa-compat/1[5-9]-*.spec.ts test/jpa-compat/2[0-3]-*.spec.ts --no-file-parallelism`.
> - **PR**: https://github.com/plug-link/pluglink-commons/pull/14 (브랜치 `fix/mikro-orm-base-repository-save-flush`, origin/main 기준 격리 워크트리로 커밋 — PLU-877 미접촉). 커밋 fbb8951.
> - **아티팩트**: https://claude.ai/code/artifact/e4c0954a-12d5-4739-8a60-6c5db0c2d4e3
> - **commons 검증**: prettier/eslint/tsc clean.
> - **후속(PENDING)**: 각 서비스 commons 버전 bump→통합테스트 · (선택)createAndFlush→save({flush:true}) 정리 · 내부 API(getContext/__originalEntityData) 업그레이드 체크리스트 고정 · users TransactionalExplorer 미등록.
> - ⚠️ commons 메인 워킹트리(plu-877 브랜치)에 우리 2파일 변경이 아직 uncommitted로 남아있음(fix 브랜치에 이미 커밋됨) — 사용자가 `git checkout`으로 정리 가능(선택).

---


> 컴팩션 후 이 파일을 읽어 맥락 복원. 목적: MikroORM `BaseRepository.save()` 회귀로 인한 프로덕션 장애 근본수정.

## 한 줄 요약
managements 업무생성(officials 등) 프로덕션 장애의 근본이 commons `BaseRepository.save()`의 **① nested @Transactional에서 신규 save가 flush 안 해 id 미할당(결함 A)** + **② fork-split `__em` 오판으로 upsert→PG IDENTITY(결함 B)**. commons에 **최소 수정(멤버십 판정 + 신규 flush)**을 적용해 stage까지 완료. 리뷰 2건(Codex+ChatGPT) 통과. PG 회귀·서비스 테스트·별도 브랜치 커밋이 남음.

## 근본원인 (확정: 코드+프로덕션 데이터+샌드박스 실증+리뷰)
- **결함 A**: `save(new)`가 이미 열린 `@Transactional`(REQUIRED join) 안에선 persist만·flush 안 함 → auto-increment `id=undefined` → 자식 스칼라 FK NULL → read-back 실패 → 전체 롤백. (managements officials/opens/contracts/constructions/inspections `create()` 5종)
- **결함 B**: `@Transactional` fork(clear:false)에서 로드 엔티티 `__em=부모`라 Case1 가드(`__em===em`) false-negative → detached(Case3) 오분류 → `em.upsert` → PG `GENERATED ALWAYS AS IDENTITY` INSERT 거부(+전컬럼 덮음·onUpdate 훅 우회). (roamings battery/inbound-trade 등에서 과거 발현, dirty-flush로 국소 봉합돼 있었음)
- Spring parity: MikroORM엔 "persist 즉시 INSERT" 설정 없음. IDENTITY의 즉시 INSERT는 Spring 부작용. em.flush(전체 UoW) 또는 em.insert(단건, unmanaged)로 근사.

## 확정 결정 — commons 최소 수정 (적용·stage 완료)
파일: `/Users/admin/Desktop/dev/pluglink-commons/src/database/mikro-orm/base.repository.ts` (staged, 미커밋)
- **Case 1**: `__em===em` 포인터 → `isManagedHere`(=`em.getUnitOfWork().getById(pk)===entity`, UoW 멤버십). fork-split 봉합.
- **Case 2**(신규 no-PK): `em.persist + await em.flush()` (id 즉시 확보, Spring IDENTITY parity).
- **Case 3(detached upsert)·Case 4(수동PK persist)**: **원본 유지**(되돌림).
- `saveAll`도 동형 + 신규만 있을 때 루프 밖 flush 1회.
- **왜 Case3/4 안 건드림**: fork-split은 이제 Case1이 잡아 Case3 도달 자체가 없어짐 → Case3 수정은 이득0. 내가 처음 넣었던 `findOne+assign`은 리뷰가 지적한 신규 위험 3개(persist-on-notfound IDENTITY 재발·assign 광범위덮어씀·Case4 악화)만 만들어 **되돌림**. 원본 유지 = 미감사 서비스 회귀 0.
- 검증: prettier/eslint/tsc(BUILD_OK) 통과. **PLU-877 브랜치 위**라 그 파일(sqs.consumer.ts/spec)은 미접촉·미stage.

## 리뷰 결과 (둘 다 통과, 3대 이슈는 되돌림으로 해소)
- Codex(task-mrua2uy4-kv1fgl, session 019f8361-bfcb-7190-a1c4-fad000607afe) + ChatGPT 리뷰 수렴:
  - isManagedHere(멤버십) 방향 **맞다**(안전 확인).
  - Case2 flush = 전체 UoW 조기 flush(같은 TX·롤백 안전, trade-off 수용).
  - 치명 3건은 전부 **Case3 findOne+assign / Case4 flush 때문** → 되돌려 제거.
  - 후속 권고: MikroORM 내부 API(`__managed`/`getById`) 의존 → **버전 pin + 회귀 테스트**, 복합PK/`as never` 주의.

## 실증 (mikro-orm-test 샌드박스, MySQL:3307, docker)
- `test/jpa-compat/15-officials-save-flush-pitfall.spec.ts` — 스칼라 FK 버그 재현 + createAndFlush/관계 fix (3)
- `16-relation-readback.spec.ts` — 관계 대입 + read-back(=flush 순서가 관건) (3)
- `17-early-flush-spring-parity.spec.ts` — Spring parity 조사 실증 (16)
- `18-commons-fix-verification.spec.ts` — commons 수정 shape(멤버십+Case2 flush+Case3 upsert 보존) (8)
- `19-service-patterns-commons-fix.spec.ts` — **commons 최종본 verbatim(제네릭 EntityRepository<T>) × 실사용 패턴** (6): A me/cards create(관계)/update(managed), B me/charger status saveAll(load+mutate), C me/battery all-new saveAll(Case2 배치), D managements officials nested @Transactional 스칼라 FK read-back(준공 탭 버그 OLD 재현 19-D1 → FIXED 치유 19-D2). saveAll·제네릭 경로·관계 create 를 18 에 이어 커버.
- `20-nested-transactional-commons-fix.spec.ts` — **@Transactional 중첩(depth-2/3) 원자성·정합** (9): H1 join 증명(depth-2/3 모두 begin 1·savepoint 0), H2 멤버십 라우팅(중첩 managed→dirty UPDATE·upsert 아님, 스칼라FK read-back 치유), H3 원자성(Case2 조기 flush·다중 save·saveAll 전부 외부 throw 시 롤백), H4 형제 @Transactional(각자 tx·begin 2) 대조도 FIXED 안전. **핵심 근거**: `@Transactional` 기본 propagation=REQUIRED→join(legacy Transactional.js) → 중첩은 같은 UoW·같은 DB tx 공유, Case2 flush는 commit 아님.
- `21-e2e-http-sqs-commons-fix.spec.ts` — **실 런타임 배선 e2e** (6): MikroOrmModule.forRoot(`registerRequestContext:true` HTTP 미들웨어) + TransactionalExplorer(em 자동주입) + supertest **진짜 HTTP** + `@EnsureRequestContext` **SQS** 컨슈머. 21-1 POST create(응답 body id=Spring parity), 21-2 POST nested+스칼라FK read-back(준공 치유), 21-3 PATCH in-tx managed→dirty UPDATE, 21-4 PATCH **outside-tx(users fork-split, 실 HTTP)→dirty UPDATE·upsert아님·onUpdate 작동**, 21-5 POST throw→500+롤백, 21-6 SQS 형제 @Transactional→dirty UPDATE. e2e 소스=`src/jpa-compat/e2e-final/`(final-base.repository=commons 최종본 verbatim + ledger 엔티티/repo/service/consumer/controller).
- `22-pg-identity-teeth.spec.ts` — **PostgreSQL `GENERATED ALWAYS AS IDENTITY` 실제 크래시 teeth** (5): doc 16.1 토폴로지(EM_req 로드→@Transactional save)를 OLD/FIXED 토글. 22-1 **OLD→em.upsert→PG `cannot insert a non-DEFAULT value into column "id"` CRASH+롤백**, 22-2 FIXED→plain UPDATE(on conflict 없음)+onUpdate, 22-3 OLD=INSERT(on conflict)/FIXED=UPDATE 대조, 22-4 FIXED Case2 new→id 즉시(PG), 22-5 **잔여리스크 문서화**: 진짜 detached+IDENTITY는 Case3 upsert 보존이라 FIXED도 여전히 CRASH(감사상 사용처 0). ← doc 16.5가 요구한 PG 인프라·teeth, **여기서 완결**.
- 15~22 함께 **60/60 PASS**. 실행: `npx vitest run test/jpa-compat/15-*.spec.ts ... 22-*.spec.ts --no-file-parallelism` (컨테이너 `docker compose up -d` — mysql:3307 + **postgres:5433**).
- ✅ **PG IDENTITY 에러 실발현 증명 완료**(spec 22). MySQL(15~21)=routing/원자성/훅, PG(22)=실제 거부. 유일 잔여=Case3 detached(의도적 미수정, 사용처 0).
- 인프라: `docker-compose.yml`에 postgres:16(5433) 추가, `@mikro-orm/postgresql@7.0.2` 설치(core와 동일 pin).
- ⚠️ **전체 스위트(`npx vitest run`)는 96 실패** — 24개 파일이 한 DB(`mikro_orm_test`)에 각자 `MikroORM.init`/schema.create 반복하며 상호 간섭하는 **기존 샌드박스 한계**(내 작업 무관, spec19 제외해도 동일 96). 반드시 관련 스펙만 지정해 돌릴 것.

## 관련 문서 (이 레포 docs/)
- `16-fork-split-commons-fix-plan.md` — 2026-06-25 근본픽스 계획. **옵션 C(멤버십)를 "미테스트"로 보류**했던 이력(§16.4:69). 이번에 실증·적용해 되살림.
- `17-spring-vs-mikroorm-audit.md` — Spring↔MikroORM 10축 매트릭스 + 3서비스(roamings·managements·users) 전수 스캔(버그/위험/안전) + P1~P3 + 해결책·리뷰체크리스트. (fable 작성, 내가 §3.2/3.3/§4 보강)
- `15-em-fork-split.md` — fork-split 상세.
- commons 쪽: `/Users/admin/Desktop/dev/pluglink-commons/docs/transactional-save-flush-pitfall.md` (staged) — 함정 문서.

## 프로덕션 배경
- 국소 fix(createAndFlush)는 **이미 반영됨**(managements). 이제 commons 정석 수정을 별도로 진행 중.
- managements officials 장애로 긴급도 **중-하 → P1 승격**.

## 상태
- ✅ 근본원인 확정 / 샌드박스 실증(34/34) / audit 문서 / commons 최소수정 적용·stage / 리뷰2 통과
- ⬜ PENDING:
  1. commons를 **별도 브랜치로 커밋**(현재 PLU-877 브랜치 위 — 섞이면 안 됨)
  2. commons에 **PG 테스트컨테이너 회귀 스펙**(OLD=IDENTITY 에러 / FIXED=UPDATE) + **MikroORM 버전 pin**
  3. commons 버전 bump → managements/users/roamings **서비스 테스트 재실행**
  4. **users TransactionalExplorer 미등록** 정리(별건, managements:41/roamings:43은 등록됨)
  5. P1 Linear 이슈(원인·범위·fix·재현·테스트갭)

## 핵심 주의
- 전역 EM 오염 아님: 머지 대상=요청/호출 스코프 EM_req(요청 끝나면 GC), root 아님. allowGlobalContext:false 안전망. 비-HTTP는 `@EnsureRequestContext` 필수(roamings 준수).
- 관계 대입은 FK 정합만 해결, read-back(id 조회)은 여전히 flush 선행 필요(둘은 독립 축).
