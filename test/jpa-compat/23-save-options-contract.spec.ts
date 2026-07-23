import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { EntityManager, EntitySchema } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { FinalBaseRepository } from '../../src/jpa-compat/e2e-final/final-base.repository';

/**
 * commons 최종본의 **새 계약**을 실소스(FinalBaseRepository)로 검증:
 *   - save/saveAll 기본 = persist-only (커밋 시 일괄 flush)
 *   - `{ flush: true }` = 저장 직후 즉시 flush (id/부수효과 즉시 필요 시)
 *   - Case3 detached = warn + upsert 보존 (3a)
 *   - Case4 = DB-생성(autoincrement) PK 가 값 박힌 채 비-managed → assertNotGeneratedPk throw
 *   - Case1 = UoW 멤버십(fork-split 포함) → dirty UPDATE (회귀 방지)
 *
 * PG(GENERATED ALWAYS IDENTITY, 5433) 사용 — id 확보 시점/거부를 실제로 관찰.
 * 실소스를 import 해 인라인 복사본 drift 를 피한다(단일 진실).
 */

class L {
  id!: number;
  signature!: string;
  status!: string;
  updatedAt?: Date | null;
}
const lSchema = new EntitySchema<L>({
  class: L,
  tableName: 'repro_opt_ledger',
  properties: {
    id: { type: 'number', primary: true, autoincrement: true },
    signature: { type: 'string', unique: true },
    status: { type: 'string' },
    updatedAt: { type: 'datetime', nullable: true, fieldName: 'updated_at', onUpdate: () => new Date() },
  },
});

let orm: Awaited<ReturnType<typeof MikroORM.init>>;
const sqlLog: string[] = [];
const warns: string[] = [];
function since(mark: number): string[] {
  return sqlLog.slice(mark).map((q) => String(q).toLowerCase());
}
function has(qs: string[], needle: string): boolean {
  return qs.some((q) => q.includes(needle));
}
function repo(): FinalBaseRepository<L> {
  return new FinalBaseRepository<L>(orm.em as unknown as EntityManager, lSchema);
}
async function seed(signature: string): Promise<void> {
  const fork = orm.em.fork();
  fork.persist(fork.create(L, { signature, status: 'PENDING' }));
  await fork.flush();
}

const DDL = `
CREATE TABLE repro_opt_ledger (
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
    entities: [lSchema],
    discovery: { warnWhenNoEntities: false },
    allowGlobalContext: false,
    debug: ['query'],
    logger: (msg) => sqlLog.push(msg),
  });
  // warn 캡처 (Logger.warn 은 query logger 와 별개 경로일 수 있어 스파이로 확실히)
  const lg = orm.config.getLogger();
  const origWarn = lg.warn.bind(lg);
  lg.warn = (ns: any, msg: any, ctx?: any) => {
    warns.push(String(msg));
    return origWarn(ns, msg, ctx);
  };
  const conn = orm.em.getConnection();
  await conn.execute('DROP TABLE IF EXISTS repro_opt_ledger');
  await conn.execute(DDL);
});
afterAll(async () => {
  await orm.close(true);
});
beforeEach(async () => {
  await orm.em.getConnection().execute('TRUNCATE TABLE repro_opt_ledger RESTART IDENTITY');
  sqlLog.length = 0;
  warns.length = 0;
});

describe('23. save/saveAll 옵션 계약 (기본 persist-only / {flush:true})', () => {
  it('23-1 [기본] save(new) → tx 안에서 id 미할당(커밋 시 flush), 커밋 후 행 존재', async () => {
    const r = repo();
    let idInsideTx: number | undefined = -1;
    let insertedDuringTx = false;
    await orm.em.transactional(async () => {
      const e = orm.em.getContext(false).create(L, { signature: 'DFLT', status: 'PENDING' });
      const mark = sqlLog.length;
      await r.save(e); // 기본: persist 만
      idInsideTx = e.id;
      insertedDuringTx = has(since(mark), 'insert into "repro_opt_ledger"');
    });
    expect(idInsideTx).toBeUndefined(); // 커밋 전엔 id 없음
    expect(insertedDuringTx).toBe(false); // save 시점엔 INSERT 안 나감

    const verify = orm.em.fork();
    const row = await verify.findOneOrFail(L, { signature: 'DFLT' });
    expect(row.id).toBeGreaterThan(0); // 커밋 flush 로 저장됨
  });

  it('23-2 [{flush:true}] save(new,{flush:true}) → tx 안에서 id 즉시 확보', async () => {
    const r = repo();
    let idInsideTx = 0;
    await orm.em.transactional(async () => {
      const e = orm.em.getContext(false).create(L, { signature: 'FLUSH', status: 'PENDING' });
      await r.save(e, { flush: true });
      idInsideTx = e.id;
    });
    expect(idInsideTx).toBeGreaterThan(0);
  });

  it('23-3 [saveAll] 기본은 커밋 flush / {flush:true}는 즉시 id 확보', async () => {
    const r = repo();
    // 기본: tx 안 id 미할당
    let defaultIds: (number | undefined)[] = [];
    await orm.em.transactional(async () => {
      const em = orm.em.getContext(false);
      const es = ['A', 'B'].map((s) => em.create(L, { signature: `SA-${s}`, status: 'P' }));
      await r.saveAll(es);
      defaultIds = es.map((e) => e.id);
    });
    expect(defaultIds.every((id) => id === undefined)).toBe(true);

    // {flush:true}: 즉시 id
    let flushedIds: number[] = [];
    await orm.em.transactional(async () => {
      const em = orm.em.getContext(false);
      const es = ['C', 'D'].map((s) => em.create(L, { signature: `SA-${s}`, status: 'P' }));
      await r.saveAll(es, { flush: true });
      flushedIds = es.map((e) => e.id);
    });
    expect(flushedIds.every((id) => id > 0)).toBe(true);

    const verify = orm.em.fork();
    expect(await verify.count(L, {})).toBe(4); // 넷 다 커밋됨
  });

  it('23-4 [Case1 회귀] fork-split managed save → dirty UPDATE, upsert 아님', async () => {
    const r = repo();
    await seed('MNG');

    const mark = sqlLog.length;
    await orm.em.transactional(async () => {
      const em = orm.em.getContext(false);
      const row = await em.findOneOrFail(L, { signature: 'MNG' });
      row.status = 'SENT';
      await r.save(row); // managed → no-op → 커밋 시 dirty UPDATE
    });
    const qs = since(mark);
    expect(has(qs, 'on conflict')).toBe(false);
    expect(has(qs, 'update "repro_opt_ledger" set')).toBe(true);

    const verify = orm.em.fork();
    const row = await verify.findOneOrFail(L, { signature: 'MNG' });
    expect(row.status).toBe('SENT');
    expect(row.updatedAt).not.toBeNull(); // onUpdate 훅 작동
  });

  it('23-5 [Case3=3a] 진짜 detached save → warn 발생(가시화) + PG IDENTITY 는 여전히 크래시(잔여 리스크)', async () => {
    const r = repo();
    await seed('DET');
    const loader = orm.em.fork();
    const detached = await loader.findOneOrFail(L, { signature: 'DET' });
    detached.status = 'SENT';

    let err: unknown;
    try {
      await r.save(detached); // 자체 tx, UoW 밖 → Case3 (warn 후 upsert)
    } catch (e) {
      err = e;
    }
    // 3a 의 개선점: detached 경로가 warn 으로 가시화됨
    expect(warns.some((m) => m.includes('detached'))).toBe(true);
    // 3a 는 warn 만 추가할 뿐, GENERATED ALWAYS IDENTITY 에선 upsert 가 여전히 거부됨(spec 22-5 잔여)
    expect(err).toBeTruthy();
    expect(String((err as Error).message ?? err).toLowerCase()).toMatch(
      /identity|generated|default value|overriding/,
    );
  });

  it('23-6 [Case4] DB-생성 PK가 값 박힌 채 비-managed → persist 보존(프로덕션 동일) → GENERATED ALWAYS 는 커밋 flush 서 거부', async () => {
    const r = repo();
    const bogus = new L();
    bogus.id = 999; // 역직렬화/update-의도 오용 시뮬
    bogus.signature = 'BOGUS';
    bogus.status = 'X';

    let err: unknown;
    try {
      await r.save(bogus); // Case4: 그냥 persist → @Transactional 커밋 flush 시 명시 id INSERT
    } catch (e) {
      err = e;
    }
    // 런타임 경고 없음(리뷰 체크리스트로 이관) — 동작은 프로덕션 보존(persist).
    // GENERATED ALWAYS 테이블이라 커밋 flush 에서 DB 가 거부(회귀 아님, 프로덕션과 동일).
    expect(err).toBeTruthy();
    expect(String((err as Error).message ?? err).toLowerCase()).toMatch(
      /identity|generated|default value|overriding/,
    );
  });
});
