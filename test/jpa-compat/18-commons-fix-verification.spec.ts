import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { EntityManager, EntitySchema, helper } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/mysql';
import { Transactional, EnsureRequestContext } from '@mikro-orm/decorators/legacy';

/**
 * 17-spring-vs-mikroorm-audit.md 의 "commons 통합 수정안" 검증 스펙.
 *
 * 수정안 = BaseRepository.save() 두 곳 수정:
 *   (1) Case1 가드: `__em` 포인터 비교 → UoW 멤버십 (doc 16.4 — "미테스트"였던 부분을 여기서 실측)
 *   (2) Case2/4(신규): persist 후 즉시 flush (Spring IDENTITY parity — doc 17 스펙 C 검증 완료분과 결합)
 *
 * 검증 항목:
 *   18-1  [현행 재현] fork-split 토폴로지에서 OLD save → Case3 upsert (+ onUpdate 훅 우회)
 *   18-2  [수정안]   같은 토폴로지에서 FIXED save → plain UPDATE + onUpdate 훅 정상
 *   18-3  [수정안]   바깥 @Transactional 안 save(new) → id 즉시 할당 (Spring parity)
 *   18-4  [보존]     진짜 detached 엔티티 → FIXED 도 여전히 Case3 upsert (기존 동작 보존)
 *   18-5  [보존]     같은 fork 안 find→save → no-op → dirty UPDATE 1회 (기존 동작 보존)
 *   18-6  [원자성]   조기 flush된 INSERT 도 바깥 tx 롤백 시 함께 롤백
 */

// ---------------------------------------------------------------------------
// 엔티티 — EntitySchema (TsMorph 불필요). roamings InboundTrade 미러.
// ---------------------------------------------------------------------------
class FixLedger {
  id!: number;
  signature!: string;
  status!: string;
  registeredAt?: Date | null;
  /** onUpdate 훅 — upsert/nativeUpdate 는 이걸 우회한다 (doc 15.3 실측) */
  updatedAt?: Date | null;
}

const fixLedgerSchema = new EntitySchema<FixLedger>({
  class: FixLedger,
  tableName: 'repro_fix_ledger',
  properties: {
    id: { type: 'number', primary: true, autoincrement: true },
    signature: { type: 'string', unique: true },
    status: { type: 'string' },
    registeredAt: { type: 'datetime', nullable: true },
    updatedAt: { type: 'datetime', nullable: true, onUpdate: () => new Date() },
  },
});

// ---------------------------------------------------------------------------
// 리포지토리 2종 — this.em 은 글로벌 프록시 (NestJS DI 주입과 동일 조건)
// ---------------------------------------------------------------------------
class OldCommonsRepo {
  constructor(readonly em: EntityManager) {}

  private ctx(): EntityManager {
    return (this.em as any).getContext(false) as EntityManager;
  }

  /** 현행 commons base.repository.ts save() 로직 그대로 */
  @Transactional()
  async save(entity: FixLedger): Promise<FixLedger> {
    const em = this.ctx();
    const wrapped = helper(entity);
    if (wrapped.__managed && (wrapped as any).__em === em) return entity; // Case1: __em 포인터
    if (!wrapped.hasPrimaryKey()) {
      em.persist(entity); // Case2: flush 없음
      return entity;
    }
    if ((wrapped as any).__originalEntityData) {
      return (await em.upsert(FixLedger, entity)) as FixLedger; // Case3: upsert
    }
    em.persist(entity); // Case4
    return entity;
  }
}

class FixedCommonsRepo {
  constructor(readonly em: EntityManager) {}

  private ctx(): EntityManager {
    return (this.em as any).getContext(false) as EntityManager;
  }

  /** 최종안: Case1=UoW 멤버십, 신규=persist(기본) + opts.flush 시 즉시 flush, Case3 은 유지 */
  @Transactional()
  async save(entity: FixLedger, opts?: { flush?: boolean }): Promise<FixLedger> {
    const em = this.ctx();
    const wrapped = helper(entity);

    // Case 1': "이 인스턴스가 현재 em 의 identity map 에 있는가" (멤버십)
    const inThisUow =
      wrapped.hasPrimaryKey() &&
      em.getUnitOfWork().getById('FixLedger' as any, wrapped.getPrimaryKey() as any) === entity;
    if (wrapped.__managed && inThisUow) {
      if (opts?.flush) await em.flush();
      return entity;
    }

    // Case 2': 신규 — persist (기본), opts.flush 시 즉시 flush (Spring IDENTITY parity)
    if (!wrapped.hasPrimaryKey()) {
      em.persist(entity);
      if (opts?.flush) await em.flush();
      return entity;
    }

    // Case 3: 진짜 detached — 기존 동작(upsert) 보존
    if ((wrapped as any).__originalEntityData) {
      return (await em.upsert(FixLedger, entity)) as FixLedger;
    }

    // Case 4': 수동 PK 신규 — persist (기본), opts.flush 시 즉시
    em.persist(entity);
    if (opts?.flush) await em.flush();
    return entity;
  }
}

// ---------------------------------------------------------------------------
// fork-split 토폴로지 (roamings SQS 컨슈머 미러):
// @EnsureRequestContext(EM_req) → recordPending @Transactional(fork P)
//                               → markResult   @Transactional(fork M)
// ---------------------------------------------------------------------------
class FixService {
  constructor(
    readonly em: EntityManager,
    private readonly oldRepo: OldCommonsRepo,
    private readonly fixedRepo: FixedCommonsRepo,
  ) {}

  private ctx(): EntityManager {
    return (this.em as any).getContext(false) as EntityManager;
  }

  @Transactional()
  async recordPending(signature: string): Promise<void> {
    const em = this.ctx();
    const entity = em.create(FixLedger, { signature, status: 'PENDING', registeredAt: null });
    await this.oldRepo.save(entity); // 신규 INSERT 경로는 old/fixed 동일 결과
    // @Transactional 커밋 시 flush → INSERT, mergeEntitiesToParent → entity.__em = EM_req
  }

  @Transactional()
  async markResult(signature: string, variant: 'old' | 'fixed'): Promise<void> {
    const em = this.ctx();
    const existing = await em.findOne(FixLedger, { signature });
    if (!existing) return;
    existing.status = 'SENT';
    existing.registeredAt = new Date();
    if (variant === 'old') await this.oldRepo.save(existing);
    else await this.fixedRepo.save(existing);
  }
}

class FixConsumer {
  constructor(
    readonly em: EntityManager,
    private readonly service: FixService,
  ) {}

  @EnsureRequestContext()
  async handleMessage(signature: string, variant: 'old' | 'fixed'): Promise<void> {
    await this.service.recordPending(signature);
    // --- (실제로는 여기서 ME HTTP — 트랜잭션 밖) ---
    await this.service.markResult(signature, variant);
  }

  /**
   * users.service.ts upsertCredential 패턴 미러:
   * HTTP 핸들러(RequestContext, 바깥 @Transactional 없음)에서 엔티티를 로드·수정한 뒤
   * @Transactional 이 붙은 repo.save() 하나만 호출 — save 가 자체 tx fork 를 만든다.
   */
  @EnsureRequestContext()
  async handleHttpLikeUpdate(
    signature: string,
    variant: 'old' | 'fixed',
    oldRepo: OldCommonsRepo,
    fixedRepo: FixedCommonsRepo,
  ): Promise<void> {
    const reqEm = (this.em as any).getContext(false) as EntityManager; // EM_req (RC fork)
    const existing = await reqEm.findOne(FixLedger, { signature });
    if (!existing) return;
    existing.status = 'SENT';
    if (variant === 'old') await oldRepo.save(existing);
    else await fixedRepo.save(existing);
  }
}

// ---------------------------------------------------------------------------
// 셋업
// ---------------------------------------------------------------------------
let orm: Awaited<ReturnType<typeof MikroORM.init>>;
const sqlLog: string[] = [];

function queriesSince(mark: number): string[] {
  return sqlLog.slice(mark).map((q) => q.toLowerCase());
}

beforeAll(async () => {
  orm = await MikroORM.init({
    host: 'localhost',
    port: 3307,
    user: 'root',
    password: 'test',
    dbName: 'mikro_orm_test',
    entities: [fixLedgerSchema],
    discovery: { warnWhenNoEntities: false },
    allowGlobalContext: false,
    debug: ['query'],
    logger: (msg) => sqlLog.push(msg),
  });
  const conn = orm.em.getConnection();
  await conn.execute('DROP TABLE IF EXISTS `repro_fix_ledger`');
  await (orm as any).schema.create({ wrap: false });
});

afterAll(async () => {
  await orm.close(true);
});

beforeEach(async () => {
  await orm.em.getConnection().execute('TRUNCATE TABLE `repro_fix_ledger`');
  sqlLog.length = 0;
});

function buildStack() {
  const em = orm.em as unknown as EntityManager;
  const oldRepo = new OldCommonsRepo(em);
  const fixedRepo = new FixedCommonsRepo(em);
  const service = new FixService(em, oldRepo, fixedRepo);
  const consumer = new FixConsumer(em, service);
  return { oldRepo, fixedRepo, consumer };
}

// ===========================================================================
describe('18. commons 통합 수정안 (Case1=UoW 멤버십 + Case2=flush) 실측', () => {
  it('18-1 [현행 재현] fork-split 에서 OLD save → Case3 upsert(ON DUPLICATE) + onUpdate 훅 우회(updatedAt null)', async () => {
    const { consumer } = buildStack();
    const mark = sqlLog.length;

    await consumer.handleMessage('SIG-OLD', 'old');

    const qs = queriesSince(mark);
    expect(qs.some((q) => q.includes('on duplicate key update'))).toBe(true); // upsert 로 빠짐
    expect(qs.some((q) => q.includes('update `repro_fix_ledger` set'))).toBe(false); // plain UPDATE 없음

    const verify = orm.em.fork();
    const row = await verify.findOneOrFail(FixLedger, { signature: 'SIG-OLD' });
    expect(row.status).toBe('SENT'); // MySQL 이라 silent 통과 (PG 였다면 IDENTITY 에러)
    expect(row.updatedAt ?? null).toBeNull(); // upsert 는 onUpdate 훅 우회
  });

  it('18-2 [수정안] 같은 fork-split 에서 FIXED save → upsert 없음, plain UPDATE + onUpdate 훅 정상', async () => {
    const { consumer } = buildStack();
    const mark = sqlLog.length;

    await consumer.handleMessage('SIG-FIXED', 'fixed');

    const qs = queriesSince(mark);
    expect(qs.some((q) => q.includes('on duplicate key update'))).toBe(false); // upsert 로 안 빠짐
    expect(qs.some((q) => q.includes('update `repro_fix_ledger` set'))).toBe(true); // dirty UPDATE

    const verify = orm.em.fork();
    const row = await verify.findOneOrFail(FixLedger, { signature: 'SIG-FIXED' });
    expect(row.status).toBe('SENT');
    expect(row.updatedAt).not.toBeNull(); // dirty-flush 경로라 onUpdate 훅 작동
  });

  it('18-3 [수정안] 바깥 @Transactional 안 save(new) → flush 로 id 즉시 할당 (Spring IDENTITY parity)', async () => {
    const { fixedRepo } = buildStack();
    let idInsideTx = 0;
    await orm.em.transactional(async () => {
      const entity = new FixLedger();
      entity.signature = 'SIG-NEW';
      entity.status = 'PENDING';
      await fixedRepo.save(entity, { flush: true }); // 새 계약: id 즉시 필요 → 명시 flush
      idInsideTx = entity.id; // 기본(no-flush) 이면 undefined; {flush:true} 라 확보
    });
    expect(idInsideTx).toBeGreaterThan(0);
  });

  it('18-4 [보존] 진짜 detached(독립 fork 에서 로드, UoW 밖) → FIXED 도 Case3 upsert 유지', async () => {
    const { fixedRepo } = buildStack();

    // 씨드 + 독립 fork 에서 로드 → 그 fork 밖에서 save
    const seed = orm.em.fork();
    seed.persist(seed.create(FixLedger, { signature: 'SIG-DET', status: 'PENDING' }));
    await seed.flush();

    const loader = orm.em.fork();
    const detached = await loader.findOneOrFail(FixLedger, { signature: 'SIG-DET' });
    detached.status = 'SENT';

    const mark = sqlLog.length;
    await fixedRepo.save(detached); // 바깥 컨텍스트 없음 → 자체 tx fork. detached 는 그 UoW 에 없음

    const qs = queriesSince(mark);
    expect(qs.some((q) => q.includes('on duplicate key update'))).toBe(true); // Case3 보존
  });

  it('18-5 [보존] 같은 fork 안 find→FIXED save → no-op(멤버십 히트) → 커밋 dirty UPDATE 1회', async () => {
    const { fixedRepo } = buildStack();
    const seed = orm.em.fork();
    seed.persist(seed.create(FixLedger, { signature: 'SIG-SAME', status: 'PENDING' }));
    await seed.flush();

    const mark = sqlLog.length;
    await orm.em.transactional(async (em) => {
      const row = await em.findOneOrFail(FixLedger, { signature: 'SIG-SAME' });
      row.status = 'SENT';
      await fixedRepo.save(row); // 같은 fork 의 UoW 멤버 → no-op 이어야 함
    });

    const qs = queriesSince(mark);
    expect(qs.filter((q) => q.includes('update `repro_fix_ledger` set')).length).toBe(1);
    expect(qs.some((q) => q.includes('on duplicate key update'))).toBe(false);
    expect(qs.some((q) => q.includes('insert into `repro_fix_ledger`'))).toBe(false);
  });

  it('18-7 [users 패턴 재현] RC에서 로드·수정 → 무TX repo.save() 1회 (OLD) → save 자체 tx fork 에서 Case3 upsert + 훅 우회', async () => {
    const { oldRepo, fixedRepo, consumer } = buildStack();
    const seed = orm.em.fork();
    seed.persist(seed.create(FixLedger, { signature: 'SIG-HTTP-OLD', status: 'PENDING' }));
    await seed.flush();

    const mark = sqlLog.length;
    await consumer.handleHttpLikeUpdate('SIG-HTTP-OLD', 'old', oldRepo, fixedRepo);

    const qs = queriesSince(mark);
    expect(qs.some((q) => q.includes('on duplicate key update'))).toBe(true); // upsert 로 빠짐
    expect(qs.some((q) => q.includes('update `repro_fix_ledger` set'))).toBe(false);

    const verify = orm.em.fork();
    const row = await verify.findOneOrFail(FixLedger, { signature: 'SIG-HTTP-OLD' });
    expect(row.status).toBe('SENT'); // MySQL silent degrade — 값은 반영되지만
    expect(row.updatedAt ?? null).toBeNull(); // onUpdate 훅 우회
  });

  it('18-8 [users 패턴 치유] 같은 흐름에서 FIXED save → 멤버십 히트(no-op) → dirty UPDATE + 훅 정상', async () => {
    const { oldRepo, fixedRepo, consumer } = buildStack();
    const seed = orm.em.fork();
    seed.persist(seed.create(FixLedger, { signature: 'SIG-HTTP-FIX', status: 'PENDING' }));
    await seed.flush();

    const mark = sqlLog.length;
    await consumer.handleHttpLikeUpdate('SIG-HTTP-FIX', 'fixed', oldRepo, fixedRepo);

    const qs = queriesSince(mark);
    expect(qs.some((q) => q.includes('on duplicate key update'))).toBe(false);
    expect(qs.some((q) => q.includes('update `repro_fix_ledger` set'))).toBe(true);

    const verify = orm.em.fork();
    const row = await verify.findOneOrFail(FixLedger, { signature: 'SIG-HTTP-FIX' });
    expect(row.status).toBe('SENT');
    expect(row.updatedAt).not.toBeNull(); // dirty-flush 경로라 onUpdate 훅 작동
  });

  it('18-6 [원자성] Case2 조기 flush INSERT 도 바깥 tx 롤백 시 함께 롤백', async () => {
    const { fixedRepo } = buildStack();
    let idBeforeRollback = 0;
    await expect(
      orm.em.transactional(async () => {
        const entity = new FixLedger();
        entity.signature = 'SIG-RB';
        entity.status = 'PENDING';
        await fixedRepo.save(entity, { flush: true }); // 조기 flush 를 만들어 그것이 롤백되는지 검증
        idBeforeRollback = entity.id;
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');

    expect(idBeforeRollback).toBeGreaterThan(0); // id 는 받았지만
    const verify = orm.em.fork();
    expect(await verify.count(FixLedger, { signature: 'SIG-RB' })).toBe(0); // 롤백됨
  });
});
