import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { EntityManager, EntityRepository, EntitySchema, helper } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { Transactional, EnsureRequestContext } from '@mikro-orm/decorators/legacy';

/**
 * 순차 트랜잭션 save 시나리오 — 사용자 질문 재현:
 *   (S1) tx start → save → tx end
 *   (S2) tx1 에서 조회한 엔티티를 → 다른/새 tx 에서 save → tx end
 *
 * 22-pg-identity-teeth 와 같은 PG GENERATED ALWAYS IDENTITY 토폴로지를 재사용하되,
 * "엔티티를 **어디서 로드했는가**"가 FIXED(멤버십) 라우팅의 갈림길임을 드러낸다.
 *
 *   - request-EM(EM_req) 에서 로드 → @Transactional child fork(clear:false)가 identity map 을
 *     복사하므로 UoW 멤버십 히트 → Case1 dirty UPDATE (안전).
 *   - **이전 트랜잭션(별도 fork)** 에서 로드하고 그 tx 가 끝나면, 그 엔티티는 어느 살아있는 UoW 에도
 *     없다 → 멤버십 미스 → Case3 upsert → GENERATED ALWAYS IDENTITY 는 INSERT 거부로 CRASH.
 */

// ---------------------------------------------------------------------------
class PgLedger {
  id!: number;
  signature!: string;
  status!: string;
  updatedAt?: Date | null;
}
const pgLedgerSchema = new EntitySchema<PgLedger>({
  class: PgLedger,
  tableName: 'xtx_pg_ledger',
  properties: {
    id: { type: 'number', primary: true, autoincrement: true },
    signature: { type: 'string', unique: true },
    status: { type: 'string' },
    updatedAt: {
      type: 'datetime',
      nullable: true,
      fieldName: 'updated_at',
      onUpdate: () => new Date(),
    },
  },
});

// FIXED repo — commons 0.35.0-beta.0 base.repository 와 동형(멤버십 판정 + Case3 보존 + flush 옵션)
class FixedRepo<T extends object> extends EntityRepository<T> {
  private ctx(): EntityManager {
    return (this.em as any).getContext(false) as EntityManager;
  }
  private isManagedHere(em: EntityManager, entity: T): boolean {
    const w = helper(entity);
    if (!w.__managed || !w.hasPrimaryKey()) return false;
    return (
      em.getUnitOfWork().getById(this.entityName as never, w.getPrimaryKey() as never) === entity
    );
  }
  @Transactional()
  async save(entity: T, opts?: { flush?: boolean }): Promise<T> {
    const em = this.ctx();
    const w = helper(entity);
    let result = entity;
    if (this.isManagedHere(em, entity)) {
      // Case1: 멤버십 → no-op (dirty checking)
    } else if (!w.hasPrimaryKey()) {
      em.persist(entity); // Case2
    } else if ((w as any).__originalEntityData) {
      result = (await em.upsert(this.entityName as any, entity as any)) as T; // Case3 보존
    } else {
      em.persist(entity); // Case4
    }
    if (opts?.flush) await em.flush();
    return result;
  }
}

// request 토폴로지: @EnsureRequestContext 안에서 tx1(로드) → tx2(save) 순차
class RequestScopedSequentialFlow {
  constructor(
    readonly em: EntityManager,
    private readonly repo: FixedRepo<PgLedger>,
  ) {}
  private ctx(): EntityManager {
    return (this.em as any).getContext(false) as EntityManager;
  }
  @Transactional()
  private async loadTx(signature: string): Promise<PgLedger> {
    return this.ctx().findOneOrFail(PgLedger, { signature });
  }
  @Transactional()
  private async saveTx(entity: PgLedger): Promise<void> {
    await this.repo.save(entity);
  }
  /** EM_req 열림 → tx1 로드 → (tx1 커밋) → tx2 save. tx1 로드가 EM_req UoW 에 남아 Case1 이 되는가? */
  @EnsureRequestContext()
  async run(signature: string): Promise<{ inReqUowAfterTx1: boolean }> {
    const loaded = await this.loadTx(signature); // tx1
    loaded.status = 'SENT';

    // probe: tx1 커밋 후, loaded 가 EM_req(요청 컨텍스트) UoW 에 있는가?
    const reqEm = this.ctx();
    const pk = helper(loaded).getPrimaryKey() as never;
    const inReqUowAfterTx1 =
      reqEm.getUnitOfWork().getById('PgLedger' as never, pk) === loaded;

    await this.saveTx(loaded); // tx2
    return { inReqUowAfterTx1 };
  }
}

// request 토폴로지: EM_req 에서 로드 → @Transactional writer 에서 save
class RequestScopedFlow {
  constructor(
    readonly em: EntityManager,
    private readonly repo: FixedRepo<PgLedger>,
  ) {}
  private ctx(): EntityManager {
    return (this.em as any).getContext(false) as EntityManager;
  }
  @Transactional()
  private async writer(entity: PgLedger): Promise<void> {
    await this.repo.save(entity);
  }
  /** @EnsureRequestContext: EM_req 로드(__em=EM_req) → @Transactional child fork 에서 save */
  @EnsureRequestContext()
  async loadInReqThenSave(signature: string): Promise<void> {
    const em = this.ctx();
    const loaded = await em.findOneOrFail(PgLedger, { signature }); // EM_req 로드
    loaded.status = 'SENT';
    await this.writer(loaded); // fork-split → 멤버십 히트 기대
  }
}

// ---------------------------------------------------------------------------
let orm: Awaited<ReturnType<typeof MikroORM.init>>;
const sqlLog: string[] = [];
const since = (mark: number) => sqlLog.slice(mark).map((q) => q.toLowerCase());
const has = (qs: string[], needle: string) => qs.some((q) => q.includes(needle));

const DDL = `
CREATE TABLE xtx_pg_ledger (
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  signature VARCHAR(255) UNIQUE NOT NULL,
  status VARCHAR(255) NOT NULL,
  updated_at TIMESTAMPTZ NULL
)`;

beforeAll(async () => {
  orm = await MikroORM.init({
    host: 'localhost',
    port: 5433,
    user: 'postgres',
    password: 'test',
    dbName: 'mikro_orm_test',
    entities: [pgLedgerSchema],
    discovery: { warnWhenNoEntities: false },
    allowGlobalContext: false,
    debug: ['query'],
    logger: (msg) => sqlLog.push(msg),
  });
  const conn = orm.em.getConnection();
  await conn.execute('DROP TABLE IF EXISTS xtx_pg_ledger');
  await conn.execute(DDL);
});

afterAll(async () => {
  await orm.close(true);
});

beforeEach(async () => {
  await orm.em.getConnection().execute('TRUNCATE TABLE xtx_pg_ledger RESTART IDENTITY');
  sqlLog.length = 0;
});

async function seed(signature: string): Promise<void> {
  const fork = orm.em.fork();
  fork.persist(fork.create(PgLedger, { signature, status: 'PENDING' }));
  await fork.flush();
}

function build() {
  const em = orm.em as unknown as EntityManager;
  const repo = new FixedRepo<PgLedger>(em, pgLedgerSchema);
  const flow = new RequestScopedFlow(em, repo);
  return { repo, flow };
}

const isIdentityReject = (err: unknown) =>
  /identity|non-default|default value|overriding|generated/.test(
    String((err as Error)?.message ?? err).toLowerCase(),
  );

// ===========================================================================
describe('24. 순차 트랜잭션 save (tx1 로드 → tx2 save) 경계', () => {
  // -------------------------------------------------------------------------
  // S1: tx start → save(new) → tx end
  // -------------------------------------------------------------------------
  it('24-1 [S1] tx { save(new) } commit → INSERT 1건, upsert 아님', async () => {
    const { repo } = build();
    const mark = sqlLog.length;

    await orm.em.transactional(async (em) => {
      const e = em.create(PgLedger, { signature: 'S1-NEW', status: 'PENDING' });
      await repo.save(e); // Case2 persist, 기본 no-flush → 커밋 시 flush
    });

    const qs = since(mark);
    expect(has(qs, 'insert into "xtx_pg_ledger"')).toBe(true);
    expect(has(qs, 'on conflict')).toBe(false);

    const verify = orm.em.fork();
    expect(await verify.count(PgLedger, { signature: 'S1-NEW' })).toBe(1);
  });

  it('24-1b [S1] tx { save(new, {flush:true}) } → tx 안에서 id 즉시 확보 (Spring parity)', async () => {
    const { repo } = build();
    let idInTx = 0;

    await orm.em.transactional(async (em) => {
      const e = em.create(PgLedger, { signature: 'S1-FLUSH', status: 'PENDING' });
      await repo.save(e, { flush: true }); // 같은 tx 에서 id 필요 → 명시 flush
      idInTx = e.id;
    });

    expect(idInTx).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // S2a: request-EM 에서 로드 → 새 tx 에서 save → Case1 dirty UPDATE (안전)
  // -------------------------------------------------------------------------
  it('24-2 [S2/request-EM 로드] EM_req 로드 → @Transactional save → dirty UPDATE (크래시 없음)', async () => {
    const { flow } = build();
    await seed('S2-REQ');

    const mark = sqlLog.length;
    await expect(flow.loadInReqThenSave('S2-REQ')).resolves.toBeUndefined();
    const qs = since(mark);

    expect(has(qs, 'update "xtx_pg_ledger" set')).toBe(true); // Case1 dirty UPDATE
    expect(has(qs, 'on conflict')).toBe(false); // upsert 로 안 샘

    const verify = orm.em.fork();
    const row = await verify.findOneOrFail(PgLedger, { signature: 'S2-REQ' });
    expect(row.status).toBe('SENT');
    expect(row.updatedAt).not.toBeNull(); // onUpdate 훅 작동
  });

  // -------------------------------------------------------------------------
  // S2b: 이전 tx(em.transactional)에서 로드 → 새 tx 에서 save
  //      → 그 엔티티는 살아있는 UoW 에 없음 → Case3 upsert → IDENTITY 크래시
  // -------------------------------------------------------------------------
  it('24-3 [S2/이전 tx 로드] tx1 로드 → tx2 save → Case3 upsert → PG IDENTITY 거부(CRASH)', async () => {
    const { repo } = build();
    await seed('S2-XTX');

    // tx1: 별도 트랜잭션에서 로드하고 커밋 → loaded 는 tx1 fork 소속(커밋 후 폐기)
    let loaded!: PgLedger;
    await orm.em.transactional(async (em1) => {
      loaded = await em1.findOneOrFail(PgLedger, { signature: 'S2-XTX' });
    });
    loaded.status = 'SENT';

    // tx2: 새 트랜잭션에서 그 엔티티 save → tx2 UoW 에 loaded 없음 → 멤버십 미스 → Case3
    let err: unknown;
    try {
      await orm.em.transactional(async () => {
        await repo.save(loaded);
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeTruthy();
    expect(isIdentityReject(err)).toBe(true);

    // tx2 롤백 → 값 미반영
    const verify = orm.em.fork();
    const row = await verify.findOneOrFail(PgLedger, { signature: 'S2-XTX' });
    expect(row.status).toBe('PENDING');
  });

  it('24-6 [request ctx + 순차 tx] @EnsureRequestContext { tx1 로드 → tx2 save } 의 라우팅', async () => {
    const em = orm.em as unknown as EntityManager;
    const repo = new FixedRepo<PgLedger>(em, pgLedgerSchema);
    const flow = new RequestScopedSequentialFlow(em, repo);
    await seed('S2-REQSEQ');

    const mark = sqlLog.length;
    let probe: { inReqUowAfterTx1: boolean } | undefined;
    let err: unknown;
    try {
      probe = await flow.run('S2-REQSEQ');
    } catch (e) {
      err = e;
    }
    const qs = since(mark);

    console.log('[24-6 request-ctx seq-tx]', {
      inReqUowAfterTx1: probe?.inReqUowAfterTx1, // true 면 EM_req 에 남음 → tx2 fork 가 상속
      crashed: !!err,
      hasUpdate: has(qs, 'update "xtx_pg_ledger" set'), // Case1 dirty UPDATE
      hasConflict: has(qs, 'on conflict'), // Case3 upsert
    });

    // 결과에 따라 진실을 고정 — request context 가 tx 경계 너머로 identity map 을 유지하면 Case1(안전)
    expect(err).toBeFalsy();
    expect(has(qs, 'update "xtx_pg_ledger" set')).toBe(true);
    expect(has(qs, 'on conflict')).toBe(false);

    const verify = orm.em.fork();
    expect((await verify.findOneOrFail(PgLedger, { signature: 'S2-REQSEQ' })).status).toBe('SENT');
  });

  it('24-5 [probe] tx1 커밋 시 loaded 가 부모/tx2 UoW 에 편입되는가?', async () => {
    await seed('S2-PROBE');

    // tx1: 별도 트랜잭션에서 로드 → 커밋
    let em1Ref!: EntityManager;
    let loaded!: PgLedger;
    await orm.em.transactional(async (em1) => {
      em1Ref = em1;
      loaded = await em1.findOneOrFail(PgLedger, { signature: 'S2-PROBE' });
    });

    const w = helper(loaded);
    const pk = w.getPrimaryKey() as never;
    // tx1 커밋 후에도 __managed/__em 은 em1(폐기된 fork)을 가리킨 채 남는다
    const stillManaged = w.__managed;
    const emIsTx1 = (w as any).__em === em1Ref;
    const inTx1Uow = em1Ref.getUnitOfWork().getById('PgLedger' as never, pk) === loaded;

    // 새 tx2 fork 를 만들었을 때, 아무 find 없이 loaded 가 이미 그 UoW 에 있는가?
    // (부모 UoW 로 merge-back 됐다면, fork(clear:false)가 복사해 와서 존재해야 한다)
    let presentInFreshTx2: unknown = 'n/a';
    let sameInstanceInTx2: unknown = 'n/a';
    await orm.em.transactional(async (em2) => {
      const byId = em2.getUnitOfWork().getById('PgLedger' as never, pk);
      presentInFreshTx2 = byId != null;
      sameInstanceInTx2 = byId === loaded;
    });

    console.log('[24-5 probe]', {
      stillManaged, // true — 커밋해도 managed 플래그는 유지
      emIsTx1, // true — __em 은 여전히 폐기된 em1
      inTx1Uow, // true — em1 UoW 엔 아직 있음(참조가 살아있어서)
      presentInFreshTx2, // false 이면 = 부모 UoW 편입 안 됨(merge-back 없음)
      sameInstanceInTx2, // false
    });

    // 핵심 주장: tx1 커밋은 loaded 를 새 tx2 fork 의 UoW 로 데려오지 않는다.
    expect(presentInFreshTx2).toBe(false);
    expect(sameInstanceInTx2).toBe(false);
  });

  it('24-4 [S2/교정 패턴] 이전 tx 로드 엔티티라도 tx2 에서 re-load 후 값 복사하면 안전한 UPDATE', async () => {
    const { repo } = build();
    await seed('S2-FIX');

    // tx1 로드(값만 참고)
    let stale!: PgLedger;
    await orm.em.transactional(async (em1) => {
      stale = await em1.findOneOrFail(PgLedger, { signature: 'S2-FIX' });
    });

    // tx2: 현재 UoW 에서 re-load → 값 복사 → 그 managed 엔티티 save (JPA merge 정석)
    const mark = sqlLog.length;
    await orm.em.transactional(async (em2) => {
      const managed = await em2.findOneOrFail(PgLedger, { signature: stale.signature });
      managed.status = 'SENT';
      await repo.save(managed); // Case1 멤버십 히트
    });
    const qs = since(mark);

    expect(has(qs, 'update "xtx_pg_ledger" set')).toBe(true);
    expect(has(qs, 'on conflict')).toBe(false);

    const verify = orm.em.fork();
    expect((await verify.findOneOrFail(PgLedger, { signature: 'S2-FIX' })).status).toBe('SENT');
  });
});
