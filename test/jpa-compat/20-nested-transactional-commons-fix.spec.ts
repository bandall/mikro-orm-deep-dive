import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  EntityManager,
  EntityRepository,
  EntitySchema,
  helper,
} from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/mysql';
import { Transactional, EnsureRequestContext } from '@mikro-orm/decorators/legacy';

/**
 * "트랜잭셔널 두 번" — @Transactional **중첩(depth-2/3)** 토폴로지에서 commons 최종본이 안전한지 실측.
 *
 * 확인한 전파 의미(node_modules/@mikro-orm/decorators/legacy/Transactional.js):
 *   @Transactional 기본 propagation = REQUIRED → "join existing transactions".
 *   => 외부 tx 가 있으면 내부 @Transactional 은 **새 fork/savepoint 없이 같은 UoW·같은 DB tx 에 합류**.
 *
 * 따라서 검증 가설:
 *   (H1) 중첩 depth-N 이어도 DB tx 는 1개 (begin 1회, savepoint 0회) — 진짜 join.
 *   (H2) Case1(멤버십): 외부에서 로드한 엔티티를 내부 save → 같은 UoW → no-op → dirty UPDATE (upsert 아님).
 *   (H3) Case2(flush): 내부 save(new) 의 em.flush() 는 commit 이 아니라 공유 tx flush →
 *        외부가 throw 하면 조기 INSERT 도 함께 롤백 (원자성 유지).
 *   (H4) 위험한 fork-split 은 중첩이 아니라 "형제 @Transactional"(각자 tx) 토폴로지 — 대조로 확인.
 *
 * repo = commons/src/database/mikro-orm/base.repository.ts 최종본 verbatim 미러(제네릭).
 * ⚠️ MySQL 샌드박스 — PG IDENTITY 실발현 아님. 라우팅/원자성/tx 구조만 증명.
 */

// ===========================================================================
// 엔티티
// ===========================================================================
class Work {
  id!: number;
  name!: string;
  status!: string;
  updatedAt?: Date | null;
}
const workSchema = new EntitySchema<Work>({
  class: Work,
  tableName: 'repro_work',
  properties: {
    id: { type: 'number', primary: true, autoincrement: true },
    name: { type: 'string' },
    status: { type: 'string' },
    updatedAt: { type: 'datetime', nullable: true, onUpdate: () => new Date() },
  },
});

class WorkStep {
  id!: number;
  /** 스칼라 FK (managements officials 형태) */
  workId?: number | null;
  label!: string;
}
const workStepSchema = new EntitySchema<WorkStep>({
  class: WorkStep,
  tableName: 'repro_work_step',
  properties: {
    id: { type: 'number', primary: true, autoincrement: true },
    workId: { type: 'number', nullable: true },
    label: { type: 'string' },
  },
});

// ===========================================================================
// commons BaseRepository 최종본 verbatim 미러 (제네릭)
// ===========================================================================
class CommonsRepository<T extends object> extends EntityRepository<T> {
  private ctx(): EntityManager {
    return (this.em as any).getContext(false) as EntityManager;
  }
  private isManagedHere(em: EntityManager, entity: T): boolean {
    const wrapped = helper(entity);
    if (!wrapped.__managed || !wrapped.hasPrimaryKey()) return false;
    return (
      em.getUnitOfWork().getById(this.entityName as never, wrapped.getPrimaryKey() as never) ===
      entity
    );
  }

  private route(em: EntityManager, entity: T): T {
    const wrapped = helper(entity);
    if (this.isManagedHere(em, entity)) return entity; // Case 1
    if (!wrapped.hasPrimaryKey()) {
      em.persist(entity); // Case 2: persist (flush 는 opts.flush)
      return entity;
    }
    if ((wrapped as any).__originalEntityData) {
      return em.upsert(this.entityName as any, entity as any) as unknown as T; // Case 3
    }
    em.persist(entity); // Case 4
    return entity;
  }

  @Transactional()
  async save(entity: T, opts?: { flush?: boolean }): Promise<T> {
    const em = this.ctx();
    const result = this.route(em, entity);
    if (opts?.flush) await em.flush();
    return result;
  }

  @Transactional()
  async saveAll(entities: T[], opts?: { flush?: boolean }): Promise<T[]> {
    const em = this.ctx();
    const results = entities.map((e) => this.route(em, e));
    if (opts?.flush) await em.flush();
    return results;
  }
}

// ===========================================================================
// 서비스 — 중첩 @Transactional 토폴로지
// ===========================================================================
class WorkService {
  constructor(
    readonly em: EntityManager,
    private readonly workRepo: CommonsRepository<Work>,
    private readonly stepRepo: CommonsRepository<WorkStep>,
  ) {}
  private ctx(): EntityManager {
    return (this.em as any).getContext(false) as EntityManager;
  }

  /** depth-2: 외부 @Transactional → 내부 @Transactional save(new) */
  @Transactional()
  async createOne(name: string): Promise<{ id: number; idInsideTx: number }> {
    const em = this.ctx();
    const work = em.create(Work, { name, status: 'INIT' });
    await this.workRepo.save(work, { flush: true }); // id 를 같은 tx 에서 읽으므로 즉시 flush
    const idInsideTx = work.id;
    return { id: work.id, idInsideTx };
  }

  /** depth-2: 부모 save(new) + 스칼라 FK 자식 save(new) (officials 준공 패턴) */
  @Transactional()
  async createWithStep(name: string): Promise<{ workId: number; stepLinked: boolean }> {
    const em = this.ctx();
    const work = em.create(Work, { name, status: 'INIT' });
    await this.workRepo.save(work, { flush: true }); // 스칼라 FK 로 부모 id 사용 → 즉시 flush
    const step = em.create(WorkStep, { workId: work.id, label: 'step-1' }); // 스칼라 복사
    await this.stepRepo.save(step);
    const found = await em.findOne(WorkStep, { workId: work.id });
    return { workId: work.id, stepLinked: found !== null };
  }

  /** depth-2: 외부에서 로드 → 내부 save(managed) — Case1 멤버십 */
  @Transactional()
  async updateStatus(id: number, status: string): Promise<void> {
    const em = this.ctx();
    const work = await em.findOneOrFail(Work, id);
    work.status = status;
    await this.workRepo.save(work); // 같은 tx·같은 UoW → no-op → dirty UPDATE
  }

  /** depth-2: save(new) 후 throw → 조기 flush INSERT 도 롤백돼야 함 */
  @Transactional()
  async createThenThrow(name: string): Promise<void> {
    const em = this.ctx();
    const work = em.create(Work, { name, status: 'INIT' });
    await this.workRepo.save(work, { flush: true }); // 조기 flush(commit 아님) → 롤백 대상인지 검증
    throw new Error('force rollback (nested)');
  }

  /** depth-2: 여러 save 후 중간 실패 → 전부 롤백 (부분 커밋 없음) */
  @Transactional()
  async createManyThenFail(names: string[], failAt: number): Promise<void> {
    const em = this.ctx();
    for (let i = 0; i < names.length; i++) {
      const work = em.create(Work, { name: names[i], status: 'INIT' });
      await this.workRepo.save(work, { flush: true }); // 앞서 flush 된 것도 롤백되는지 검증
      if (i === failAt) throw new Error(`fail at ${failAt}`);
    }
  }

  /** depth-2: 내부 saveAll(all-new) */
  @Transactional()
  async createBatch(names: string[]): Promise<number[]> {
    const em = this.ctx();
    const works = names.map((name) => em.create(Work, { name, status: 'INIT' }));
    const saved = await this.workRepo.saveAll(works, { flush: true }); // id 반환 → 즉시 flush
    return saved.map((w) => w.id);
  }

  /** depth-3: lvl1 @Transactional → lvl2 @Transactional → save @Transactional */
  @Transactional()
  async lvl1(name: string): Promise<number> {
    return this.lvl2(name);
  }
  @Transactional()
  async lvl2(name: string): Promise<number> {
    const em = this.ctx();
    const work = em.create(Work, { name, status: 'INIT' });
    await this.workRepo.save(work, { flush: true }); // 반환 id → 즉시 flush
    return work.id;
  }
}

/** 형제 @Transactional (중첩 아님) — fork-split 대조군. @EnsureRequestContext 아래 각자 tx. */
class SiblingConsumer {
  constructor(
    readonly em: EntityManager,
    private readonly svc: SiblingService,
  ) {}
  @EnsureRequestContext()
  async handle(name: string): Promise<void> {
    await this.svc.recordPending(name); // @Transactional #1 (tx fork P)
    // --- 실제로는 여기서 외부 HTTP (tx 밖) ---
    await this.svc.markSent(name); // @Transactional #2 (tx fork M) — load+save
  }
}
class SiblingService {
  constructor(
    readonly em: EntityManager,
    private readonly workRepo: CommonsRepository<Work>,
  ) {}
  private ctx(): EntityManager {
    return (this.em as any).getContext(false) as EntityManager;
  }
  @Transactional()
  async recordPending(name: string): Promise<void> {
    const em = this.ctx();
    const work = em.create(Work, { name, status: 'PENDING' });
    await this.workRepo.save(work);
  }
  @Transactional()
  async markSent(name: string): Promise<void> {
    const em = this.ctx();
    const work = await em.findOneOrFail(Work, { name });
    work.status = 'SENT';
    await this.workRepo.save(work);
  }
}

// ===========================================================================
// 셋업
// ===========================================================================
let orm: Awaited<ReturnType<typeof MikroORM.init>>;
const sqlLog: string[] = [];
function since(mark: number): string[] {
  return sqlLog.slice(mark).map((q) => q.toLowerCase());
}
function count(qs: string[], needle: string): number {
  return qs.filter((q) => q.includes(needle)).length;
}

beforeAll(async () => {
  orm = await MikroORM.init({
    host: 'localhost',
    port: 3307,
    user: 'root',
    password: 'test',
    dbName: 'mikro_orm_test',
    entities: [workSchema, workStepSchema],
    discovery: { warnWhenNoEntities: false },
    allowGlobalContext: false,
    debug: ['query'],
    logger: (msg) => sqlLog.push(msg),
  });
  const conn = orm.em.getConnection();
  await conn.execute('SET FOREIGN_KEY_CHECKS = 0');
  await conn.execute('DROP TABLE IF EXISTS `repro_work_step`');
  await conn.execute('DROP TABLE IF EXISTS `repro_work`');
  await conn.execute('SET FOREIGN_KEY_CHECKS = 1');
  await (orm as any).schema.create({ wrap: false });
});

afterAll(async () => {
  await orm.close(true);
});

beforeEach(async () => {
  const conn = orm.em.getConnection();
  await conn.execute('SET FOREIGN_KEY_CHECKS = 0');
  await conn.execute('TRUNCATE TABLE `repro_work_step`');
  await conn.execute('TRUNCATE TABLE `repro_work`');
  await conn.execute('SET FOREIGN_KEY_CHECKS = 1');
  sqlLog.length = 0;
});

function build() {
  const em = orm.em as unknown as EntityManager;
  const workRepo = new CommonsRepository<Work>(em, workSchema);
  const stepRepo = new CommonsRepository<WorkStep>(em, workStepSchema);
  const service = new WorkService(em, workRepo, stepRepo);
  const siblingSvc = new SiblingService(em, workRepo);
  const siblingConsumer = new SiblingConsumer(em, siblingSvc);
  return { service, siblingConsumer };
}

// ===========================================================================
describe('20. @Transactional 중첩(depth-2/3) — commons 최종본 원자성·정합', () => {
  // ---- H1: join 증명 (tx 1개, savepoint 0) --------------------------------
  it('20-1 [H1] depth-2 (외부 @Transactional → 내부 save @Transactional) → DB tx 1개(begin 1, savepoint 0)', async () => {
    const { service } = build();
    const mark = sqlLog.length;
    const { id, idInsideTx } = await service.createOne('W-1');
    const qs = since(mark);

    expect(count(qs, 'begin')).toBe(1); // REQUIRED join — 새 tx 안 염
    expect(count(qs, 'savepoint')).toBe(0); // nested 아님 → savepoint 없음
    expect(count(qs, 'commit')).toBe(1);
    expect(id).toBeGreaterThan(0);
    expect(idInsideTx).toBe(id); // Case2 flush → tx 안에서 id 즉시 확보 (Spring parity)

    const verify = orm.em.fork();
    expect(await verify.count(Work, { name: 'W-1' })).toBe(1);
  });

  it('20-2 [H1] depth-3 (lvl1 → lvl2 → save, 모두 @Transactional) → 여전히 tx 1개', async () => {
    const { service } = build();
    const mark = sqlLog.length;
    const id = await service.lvl1('W-3LEVEL');
    const qs = since(mark);

    expect(count(qs, 'begin')).toBe(1); // depth-3 이어도 최외곽 1회만
    expect(count(qs, 'savepoint')).toBe(0);
    expect(count(qs, 'commit')).toBe(1);
    expect(id).toBeGreaterThan(0);

    const verify = orm.em.fork();
    expect(await verify.count(Work, { name: 'W-3LEVEL' })).toBe(1);
  });

  // ---- H2: 멤버십 라우팅 (managed → dirty UPDATE, upsert 아님) --------------
  it('20-3 [H2] depth-2: 외부 로드 → 내부 save(managed) → no-op → dirty UPDATE(upsert 아님) + onUpdate 훅', async () => {
    const { service } = build();
    const seed = orm.em.fork();
    seed.persist(seed.create(Work, { name: 'W-UPD', status: 'INIT' }));
    await seed.flush();
    const seeded = await orm.em.fork().findOneOrFail(Work, { name: 'W-UPD' });

    const mark = sqlLog.length;
    await service.updateStatus(seeded.id, 'DONE');
    const qs = since(mark);

    expect(count(qs, 'on duplicate key update')).toBe(0); // 중첩 join → 같은 UoW → 멤버십 히트
    expect(count(qs, 'update `repro_work` set')).toBe(1); // dirty UPDATE 1회
    expect(count(qs, 'begin')).toBe(1);
    expect(count(qs, 'savepoint')).toBe(0);

    const verify = orm.em.fork();
    const row = await verify.findOneOrFail(Work, { name: 'W-UPD' });
    expect(row.status).toBe('DONE');
    expect(row.updatedAt).not.toBeNull(); // dirty-flush 경로 → onUpdate 작동
  });

  it('20-4 [H2] depth-2 스칼라 FK: 부모 save(new)+자식 save(new) → read-back 성공 (officials 준공 치유)', async () => {
    const { service } = build();
    const { workId, stepLinked } = await service.createWithStep('W-STEP');
    expect(workId).toBeGreaterThan(0);
    expect(stepLinked).toBe(true); // 부모 id 즉시 확보 → 스칼라 FK 유효

    const verify = orm.em.fork();
    const step = await verify.findOneOrFail(WorkStep, { label: 'step-1' });
    expect(step.workId).toBe(workId);
  });

  // ---- H3: 원자성 (내부 조기 flush 도 외부 롤백 시 함께 롤백) ----------------
  it('20-5 [H3] depth-2 save(new) 후 외부 throw → 조기 flush 된 INSERT 도 롤백 (부분 커밋 없음)', async () => {
    const { service } = build();
    await expect(service.createThenThrow('W-RB')).rejects.toThrow('force rollback (nested)');

    const verify = orm.em.fork();
    expect(await verify.count(Work, { name: 'W-RB' })).toBe(0); // Case2 flush ≠ commit
  });

  it('20-6 [H3] depth-2 다중 save 중 중간 실패 → 앞서 flush 된 것 포함 전부 롤백', async () => {
    const { service } = build();
    await expect(
      service.createManyThenFail(['M-0', 'M-1', 'M-2'], 1), // index 1 에서 throw
    ).rejects.toThrow('fail at 1');

    const verify = orm.em.fork();
    expect(await verify.count(Work, { name: { $in: ['M-0', 'M-1', 'M-2'] } } as any)).toBe(0);
  });

  it('20-7 [H3] depth-2 saveAll(all-new) → tx 1개 + 전 id 확보, 커밋 후 실제 저장', async () => {
    const { service } = build();
    const mark = sqlLog.length;
    const ids = await service.createBatch(['B-0', 'B-1', 'B-2']);
    const qs = since(mark);

    expect(count(qs, 'begin')).toBe(1);
    expect(count(qs, 'savepoint')).toBe(0);
    expect(ids).toHaveLength(3);
    expect(ids.every((id) => id > 0)).toBe(true);

    const verify = orm.em.fork();
    expect(await verify.count(Work, { name: { $in: ['B-0', 'B-1', 'B-2'] } } as any)).toBe(3);
  });

  it('20-8 [H3] depth-2 saveAll 후 외부 throw → 배치 INSERT 전부 롤백', async () => {
    await expect(
      (async () => {
        // createBatch 를 감싸는 외부 tx 에서 throw
        await orm.em.transactional(async () => {
          const em = (orm.em as any).getContext(false) as EntityManager;
          const workRepo = new CommonsRepository<Work>(orm.em as any, workSchema);
          const works = ['RB-0', 'RB-1'].map((n) => em.create(Work, { name: n, status: 'INIT' }));
          await workRepo.saveAll(works, { flush: true }); // 배치 INSERT 발생 → 롤백 대상 검증
          throw new Error('rollback batch');
        });
      })(),
    ).rejects.toThrow('rollback batch');

    const verify = orm.em.fork();
    expect(await verify.count(Work, { name: { $in: ['RB-0', 'RB-1'] } } as any)).toBe(0);
  });

  // ---- H4: 형제(중첩 아님) 대조 — fork-split 토폴로지도 FIXED 는 안전 ---------
  it('20-9 [H4] 형제 @Transactional(@EnsureRequestContext 아래, 각자 tx) → FIXED save 는 멤버십으로 dirty UPDATE (upsert 아님)', async () => {
    const { siblingConsumer } = build();
    const mark = sqlLog.length;
    await siblingConsumer.handle('SIB-1');
    const qs = since(mark);

    // 형제라 tx 는 2개(begin 2회) — 중첩(20-1)과의 구조 차이 대조
    expect(count(qs, 'begin')).toBe(2);
    expect(count(qs, 'on duplicate key update')).toBe(0); // FIXED 는 fork-split 오판 없음
    expect(count(qs, 'update `repro_work` set')).toBe(1); // markSent → dirty UPDATE

    const verify = orm.em.fork();
    const row = await verify.findOneOrFail(Work, { name: 'SIB-1' });
    expect(row.status).toBe('SENT');
    expect(row.updatedAt).not.toBeNull(); // onUpdate 훅 작동 (upsert 였다면 null)
  });
});
