import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { EntityManager, EntityRepository, EntitySchema, helper } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';

/**
 * saveAll Case3(detached upsert)의 async 결함 재현 — commons 0.35.0-beta.1 수정 근거.
 *
 * `route()` 는 Case3 에서 `em.upsert(...)`(Promise<T>)를 `T` 로 캐스팅해 반환한다.
 *   - 구 saveAll: `entities.map(e => route(e))` → Case3 원소는 **미await Promise** 로 배열에 남는다.
 *     `return results` 는 배열 안 Promise 를 언랩하지 않으므로(=Promise.all 부재) 호출자는 엔티티가
 *     아니라 Promise 를 받는다(반환값 오염) + upsert 가 커밋 전에 await 되지 않는다.
 *   - 신 saveAll: `for...of` 순차 await → 각 upsert 가 완료된 엔티티가 배열에 담긴다.
 *
 * IDENTITY 크래시(reject) 경로는 unhandledRejection 으로 러너를 흔들 수 있어, 여기서는 upsert 가
 * **성공**하는 비-IDENTITY(앱 지정 PK) 테이블로 "반환값 오염 vs 정상"을 결정적으로 대조한다.
 */

class Ledger {
  id!: number;
  signature!: string;
  status!: string;
}
const ledgerSchema = new EntitySchema<Ledger>({
  class: Ledger,
  tableName: 'saveall_repro',
  properties: {
    id: { type: 'number', primary: true }, // 앱 지정 PK(비 IDENTITY) → upsert 유효
    signature: { type: 'string', unique: true },
    status: { type: 'string' },
  },
});

// route: commons 와 동형(isManagedHere 멤버십 + Case3 upsert)
function isManagedHere(em: EntityManager, entity: Ledger): boolean {
  const w = helper(entity);
  if (!w.__managed || !w.hasPrimaryKey()) return false;
  return em.getUnitOfWork().getById('Ledger' as never, w.getPrimaryKey() as never) === entity;
}
async function route(em: EntityManager, entity: Ledger): Promise<Ledger> {
  const w = helper(entity);
  if (isManagedHere(em, entity)) return entity;
  if (!w.hasPrimaryKey()) {
    em.persist(entity);
    return entity;
  }
  if ((w as { __originalEntityData?: unknown }).__originalEntityData) {
    return (await em.upsert('Ledger' as never, entity as never)) as unknown as Ledger;
  }
  em.persist(entity);
  return entity;
}

// 구 saveAll — map(미await) : Case3 원소가 Promise 로 오염된다
class BuggyRepo extends EntityRepository<Ledger> {
  private ctx(): EntityManager {
    return (this.em as any).getContext(false) as EntityManager;
  }
  async saveAll(entities: Ledger[]): Promise<Ledger[]> {
    const em = this.ctx();
    const results = entities.map((e) => route(em, e) as unknown as Ledger); // ← await 없음
    await em.flush();
    return results;
  }
}

// 신 saveAll — for...of 순차 await
class FixedRepo extends EntityRepository<Ledger> {
  private ctx(): EntityManager {
    return (this.em as any).getContext(false) as EntityManager;
  }
  async saveAll(entities: Ledger[]): Promise<Ledger[]> {
    const em = this.ctx();
    const results: Ledger[] = [];
    for (const e of entities) results.push(await route(em, e));
    await em.flush();
    return results;
  }
}

let orm: Awaited<ReturnType<typeof MikroORM.init>>;
const DDL = `
CREATE TABLE saveall_repro (
  id INT PRIMARY KEY,
  signature VARCHAR(255) UNIQUE NOT NULL,
  status VARCHAR(255) NOT NULL
)`;

beforeAll(async () => {
  orm = await MikroORM.init({
    host: 'localhost',
    port: 5433,
    user: 'postgres',
    password: 'test',
    dbName: 'mikro_orm_test',
    entities: [ledgerSchema],
    discovery: { warnWhenNoEntities: false },
    allowGlobalContext: false,
  });
  const conn = orm.em.getConnection();
  await conn.execute('DROP TABLE IF EXISTS saveall_repro');
  await conn.execute(DDL);
});

afterAll(async () => {
  await orm.close(true);
});

beforeEach(async () => {
  await orm.em.getConnection().execute('TRUNCATE TABLE saveall_repro');
});

async function seed(id: number, signature: string): Promise<void> {
  const fork = orm.em.fork();
  fork.persist(fork.create(Ledger, { id, signature, status: 'PENDING' }));
  await fork.flush();
}

/** 독립 fork 에서 로드 → 그 fork 밖 = 진짜 detached(Case3) */
async function loadDetached(signature: string): Promise<Ledger> {
  const loader = orm.em.fork();
  const row = await loader.findOneOrFail(Ledger, { signature });
  row.status = 'SENT';
  return row;
}

describe('25. saveAll Case3 upsert — await 결함 (commons 0.35.0-beta.1)', () => {
  it('25-1 [버그] 구 saveAll(map) → detached 원소가 엔티티가 아니라 Promise 로 반환된다', async () => {
    await seed(1, 'SIG-BUG');
    const detached = await loadDetached('SIG-BUG');

    // 실제 @Transactional 이 fork 컨텍스트를 세우는 것을 fork em 주입으로 대체(detached 는 다른 fork 소속)
    const repo = new BuggyRepo(orm.em.fork() as any, ledgerSchema);
    const results = await repo.saveAll([detached]);

    // 반환값 오염: 엔티티가 아니라 thenable
    expect(typeof (results[0] as any)?.then).toBe('function');
    // 그래서 필드 접근이 깨진다
    expect((results[0] as any).id).toBeUndefined();
  });

  it('25-2 [수정] 신 saveAll(for-await) → detached 원소가 완료된 엔티티로 반환된다', async () => {
    await seed(2, 'SIG-FIX');
    const detached = await loadDetached('SIG-FIX');

    const repo = new FixedRepo(orm.em.fork() as any, ledgerSchema);
    const results = await repo.saveAll([detached]);

    // 진짜 엔티티 — thenable 아님
    expect(typeof (results[0] as any)?.then).not.toBe('function');
    expect(results[0].id).toBe(2);
    expect(results[0].status).toBe('SENT');

    // upsert 가 커밋 전에 await 됨 → DB 실제 반영
    const verify = orm.em.fork();
    expect((await verify.findOneOrFail(Ledger, { signature: 'SIG-FIX' })).status).toBe('SENT');
  });

  it('25-3 [수정] 혼합 배치(managed+new+detached) 전원 엔티티로 반환·정상 반영', async () => {
    await seed(3, 'SIG-MGD');
    await seed(4, 'SIG-DET');

    // managed: 현재 컨텍스트에서 로드
    const work = orm.em.fork();
    const managed = await work.findOneOrFail(Ledger, { signature: 'SIG-MGD' });
    managed.status = 'SENT';
    const fresh = work.create(Ledger, { id: 5, signature: 'SIG-NEW', status: 'SENT' });
    const detached = await loadDetached('SIG-DET');

    const repo = new FixedRepo(work as any, ledgerSchema);
    const results = await repo.saveAll([managed, fresh, detached]);

    results.forEach((r) => expect(typeof (r as any)?.then).not.toBe('function'));
    const verify = orm.em.fork();
    const rows = await verify.find(Ledger, {});
    expect(rows.filter((r) => r.status === 'SENT')).toHaveLength(3);
  });
});
