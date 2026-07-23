import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  EntityManager,
  EntityRepository,
  EntitySchema,
  helper,
} from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { Transactional, EnsureRequestContext } from '@mikro-orm/decorators/legacy';

/**
 * PostgreSQL `GENERATED ALWAYS AS IDENTITY` PK 에서 fork-split 의 **실제 크래시**를 재현.
 *
 * doc 16.1 라이브 케이스와 동일 토폴로지:
 *   @EnsureRequestContext 핸들러가 EM_req 에서 기존 행 로드(__em=EM_req)
 *   → @Transactional writer(child fork) 안에서 repo.save(그 행)
 *   → OLD 가드(__em 포인터)는 detached(Case3) 로 오판 → em.upsert
 *   → PG: INSERT 절에 id 가 실려 `cannot insert a non-DEFAULT value into column "id"` 거부.
 *
 * MySQL 샌드박스(spec 15~21)는 explicit-id INSERT 를 허용해 silent degrade 라 이 크래시를 못 봤다.
 * 여기서 **OLD=크래시 / FIXED=plain UPDATE** 토글로 픽스의 teeth 를 증명한다. (doc 16.5 계획의 PG 인프라)
 */

// ---------------------------------------------------------------------------
// 엔티티 — 스키마는 수동 DDL(GENERATED ALWAYS). autoincrement:true 로 DB 생성 PK 임을 알림.
// ---------------------------------------------------------------------------
class PgLedger {
  id!: number;
  signature!: string;
  status!: string;
  updatedAt?: Date | null;
}
const pgLedgerSchema = new EntitySchema<PgLedger>({
  class: PgLedger,
  tableName: 'repro_pg_ledger',
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

// ---------------------------------------------------------------------------
// 리포지토리 — OLD(포인터) / FIXED(멤버십) 제네릭
// ---------------------------------------------------------------------------
class OldRepo<T extends object> extends EntityRepository<T> {
  private ctx(): EntityManager {
    return (this.em as any).getContext(false) as EntityManager;
  }
  @Transactional()
  async save(entity: T): Promise<T> {
    const em = this.ctx();
    const w = helper(entity);
    if (w.__managed && (w as any).__em === em) return entity; // Case1: __em 포인터
    if (!w.hasPrimaryKey()) {
      em.persist(entity);
      return entity;
    }
    if ((w as any).__originalEntityData) {
      return (await em.upsert(this.entityName as any, entity as any)) as T; // Case3: upsert
    }
    em.persist(entity);
    return entity;
  }
}

class FixedRepo<T extends object> extends EntityRepository<T> {
  private ctx(): EntityManager {
    return (this.em as any).getContext(false) as EntityManager;
  }
  private isManagedHere(em: EntityManager, entity: T): boolean {
    const w = helper(entity);
    if (!w.__managed || !w.hasPrimaryKey()) return false;
    return em.getUnitOfWork().getById(this.entityName as never, w.getPrimaryKey() as never) === entity;
  }
  @Transactional()
  async save(entity: T, opts?: { flush?: boolean }): Promise<T> {
    const em = this.ctx();
    const w = helper(entity);
    let result = entity;
    if (this.isManagedHere(em, entity)) {
      // Case1: 멤버십 → no-op
    } else if (!w.hasPrimaryKey()) {
      em.persist(entity); // Case2: persist (flush 는 opts.flush)
    } else if ((w as any).__originalEntityData) {
      result = (await em.upsert(this.entityName as any, entity as any)) as T; // Case3: 보존
    } else {
      em.persist(entity); // Case4
    }
    if (opts?.flush) await em.flush();
    return result;
  }
}

// ---------------------------------------------------------------------------
// 서비스/핸들러 — doc 16.1 토폴로지 (EM_req 로드 → @Transactional save)
// ---------------------------------------------------------------------------
class PgWriter {
  constructor(
    readonly em: EntityManager,
    private readonly oldRepo: OldRepo<PgLedger>,
    private readonly fixedRepo: FixedRepo<PgLedger>,
  ) {}
  @Transactional()
  async persist(entity: PgLedger, variant: 'old' | 'fixed'): Promise<void> {
    if (variant === 'old') await this.oldRepo.save(entity);
    else await this.fixedRepo.save(entity);
  }
}

class PgHandler {
  constructor(
    readonly em: EntityManager,
    private readonly writer: PgWriter,
  ) {}
  private ctx(): EntityManager {
    return (this.em as any).getContext(false) as EntityManager;
  }
  /** @EnsureRequestContext: EM_req 생성 → 여기서 로드(__em=EM_req) → writer(child fork) 에서 save */
  @EnsureRequestContext()
  async handle(signature: string, variant: 'old' | 'fixed'): Promise<void> {
    const em = this.ctx();
    const loaded = await em.findOne(PgLedger, { signature }); // EM_req 로드
    if (!loaded) return;
    loaded.status = 'SENT';
    await this.writer.persist(loaded, variant); // @Transactional fork → fork-split
  }
}

// ---------------------------------------------------------------------------
// 셋업
// ---------------------------------------------------------------------------
let orm: Awaited<ReturnType<typeof MikroORM.init>>;
const sqlLog: string[] = [];
function since(mark: number): string[] {
  return sqlLog.slice(mark).map((q) => q.toLowerCase());
}
function has(qs: string[], needle: string): boolean {
  return qs.some((q) => q.includes(needle));
}

const DDL = `
CREATE TABLE repro_pg_ledger (
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
  await conn.execute('DROP TABLE IF EXISTS repro_pg_ledger');
  await conn.execute(DDL); // ← GENERATED ALWAYS (schema.create 대신 수동)
});

afterAll(async () => {
  await orm.close(true);
});

beforeEach(async () => {
  await orm.em.getConnection().execute('TRUNCATE TABLE repro_pg_ledger RESTART IDENTITY');
  sqlLog.length = 0;
});

function build() {
  const em = orm.em as unknown as EntityManager;
  const oldRepo = new OldRepo<PgLedger>(em, pgLedgerSchema);
  const fixedRepo = new FixedRepo<PgLedger>(em, pgLedgerSchema);
  const writer = new PgWriter(em, oldRepo, fixedRepo);
  const handler = new PgHandler(em, writer);
  return { oldRepo, fixedRepo, handler };
}

async function seed(signature: string): Promise<void> {
  const fork = orm.em.fork();
  fork.persist(fork.create(PgLedger, { signature, status: 'PENDING' }));
  await fork.flush();
}

// ===========================================================================
describe('22. PG GENERATED ALWAYS IDENTITY — fork-split 실제 크래시 teeth', () => {
  it('22-1 [OLD/PG] fork-split managed save → em.upsert → PG IDENTITY 거부로 CRASH', async () => {
    const { handler } = build();
    await seed('SIG-OLD');

    let err: unknown;
    try {
      await handler.handle('SIG-OLD', 'old');
    } catch (e) {
      err = e;
    }

    expect(err).toBeTruthy(); // MySQL 이라면 silent 통과했을 지점 — PG 는 실제로 던진다
    const msg = String((err as Error)?.message ?? err).toLowerCase();
    expect(/identity|non-default|default value|overriding|generated/.test(msg)).toBe(true);

    // tx 롤백 → 값 미반영
    const verify = orm.em.fork();
    const row = await verify.findOneOrFail(PgLedger, { signature: 'SIG-OLD' });
    expect(row.status).toBe('PENDING');
  });

  it('22-2 [FIXED/PG] 같은 fork-split → 크래시 없음, plain UPDATE + onUpdate 훅', async () => {
    const { handler } = build();
    await seed('SIG-FIXED');

    const mark = sqlLog.length;
    await expect(handler.handle('SIG-FIXED', 'fixed')).resolves.toBeUndefined(); // 안 던짐
    const qs = since(mark);

    expect(has(qs, 'on conflict')).toBe(false); // upsert 로 안 샘
    expect(has(qs, 'update "repro_pg_ledger" set')).toBe(true); // dirty UPDATE

    const verify = orm.em.fork();
    const row = await verify.findOneOrFail(PgLedger, { signature: 'SIG-FIXED' });
    expect(row.status).toBe('SENT');
    expect(row.updatedAt).not.toBeNull(); // dirty-flush 경로 → onUpdate 작동
  });

  it('22-3 [대조] OLD 는 INSERT(on conflict) 발행 / FIXED 는 UPDATE 발행', async () => {
    const { handler } = build();

    await seed('SIG-CMP-OLD');
    const m1 = sqlLog.length;
    try {
      await handler.handle('SIG-CMP-OLD', 'old');
    } catch {
      /* 거부 예상 */
    }
    const oldQs = since(m1);
    expect(has(oldQs, 'on conflict')).toBe(true); // Case3 upsert 경로

    await seed('SIG-CMP-FIX');
    const m2 = sqlLog.length;
    await handler.handle('SIG-CMP-FIX', 'fixed');
    const fixQs = since(m2);
    expect(has(fixQs, 'update "repro_pg_ledger" set')).toBe(true);
    expect(has(fixQs, 'on conflict')).toBe(false);
  });

  it('22-4 [FIXED/PG] @Transactional 안 save(new) → flush 로 id 즉시 확보 (Spring parity, PG)', async () => {
    const { fixedRepo } = build();
    let idInsideTx = 0;
    await orm.em.transactional(async (em) => {
      const entity = em.create(PgLedger, { signature: 'SIG-NEW', status: 'PENDING' });
      await fixedRepo.save(entity, { flush: true }); // 새 계약: id 즉시 필요 → 명시 flush
      idInsideTx = entity.id;
    });
    expect(idInsideTx).toBeGreaterThan(0);

    const verify = orm.em.fork();
    expect(await verify.count(PgLedger, { signature: 'SIG-NEW' })).toBe(1);
  });

  it('22-5 [잔여 리스크 문서화] 진짜 detached 를 IDENTITY 테이블에 FIXED save → Case3 upsert 보존이라 PG 는 여전히 CRASH', async () => {
    const { fixedRepo } = build();
    await seed('SIG-DET');

    // 독립 fork 에서 로드 → 그 fork 밖에서 save (UoW 멤버십 밖 = 진짜 detached)
    const loader = orm.em.fork();
    const detached = await loader.findOneOrFail(PgLedger, { signature: 'SIG-DET' });
    detached.status = 'SENT';

    let err: unknown;
    try {
      await fixedRepo.save(detached); // 바깥 컨텍스트 없음 → 자체 tx, detached 는 그 UoW 에 없음 → Case3 upsert
    } catch (e) {
      err = e;
    }
    // doc 16.4 의 알려진 잔여: Case3 는 원본 유지라 진짜 detached + IDENTITY 조합은 여전히 깨진다(감사상 사용처 0).
    expect(err).toBeTruthy();
    const msg = String((err as Error)?.message ?? err).toLowerCase();
    expect(/identity|non-default|default value|overriding|generated/.test(msg)).toBe(true);
  });
});
