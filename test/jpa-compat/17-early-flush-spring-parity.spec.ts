import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  EntityManager,
  EntitySchema,
  FlushMode,
  TransactionPropagation,
  helper,
} from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/mysql';
import { TsMorphMetadataProvider } from '@mikro-orm/reflection';
import { Transactional } from '@mikro-orm/decorators/legacy';
import { TaskEntity } from '../../src/jpa-compat/repro-officials/task.entity';
import { DetailScalarEntity } from '../../src/jpa-compat/repro-officials/detail-scalar.entity';
import { DetailRelationEntity } from '../../src/jpa-compat/repro-officials/detail-relation.entity';

/**
 * 조사: "Spring JPA처럼 save(new) 직후 auto-increment id가 자동으로 채워지게" 할 수 있는가?
 *
 * 후보 방안 4가지를 실측한다:
 *   A. FlushMode 설정 (AUTO/ALWAYS) — persist 시점 early-INSERT가 되는가? 쿼리 전 auto-flush 는 무엇을 구제하는가?
 *   B. 관계(ManyToOne) + FlushMode.AUTO 조합 — 수동 flush 없이 FK/read-back이 자동화되는가?
 *   C. commons BaseRepository.save() Case 2에 flush 추가 (Spring-parity 패치) — id 즉시 확보 + 트레이드오프 실측
 *   D. @Transactional({ propagation: NESTED }) — savepoint 종료 시 자동 flush로 id 확보 (config-only 대안)
 *   E. 앱 생성 PK(uuid) — flush 자체가 필요 없는 설계 대안
 *
 * SQL 로그를 수집해 "무엇이 언제 flush 되는지"까지 검증한다.
 */

// ---------------------------------------------------------------------------
// E용 엔티티: 앱에서 PK를 생성 (EntitySchema — TsMorph 리플렉션 불필요)
// ---------------------------------------------------------------------------
class UuidTask {
  id: string = randomUUID();
  name!: string;
}

const uuidTaskSchema = new EntitySchema<UuidTask>({
  class: UuidTask,
  tableName: 'repro_uuid_tasks',
  properties: {
    id: { type: 'string', length: 36, primary: true },
    name: { type: 'string' },
  },
});

// ---------------------------------------------------------------------------
// commons base.repository.ts save() 미러 (동일 로직, 동일 데코레이터 경로)
//  - save        : 현행 commons (Case 2 = persist만)
//  - saveFlush   : 패치안 (Case 2 = persist + flush)
//  - saveNested  : 현행 로직 그대로 + propagation: NESTED (config-only 대안)
// ---------------------------------------------------------------------------
class CommonsMirrorRepo {
  constructor(readonly em: EntityManager) {}

  private resolveEm(): EntityManager {
    return (this.em as any).getContext(false) as EntityManager;
  }

  /** 현행 commons save — @Transactional() 기본(REQUIRED) */
  @Transactional()
  async save<T extends object>(entity: T): Promise<T> {
    const em = this.resolveEm();
    const wrapped = helper(entity);
    if (wrapped.__managed && wrapped.__em === em) return entity; // Case 1
    if (!wrapped.hasPrimaryKey()) {
      em.persist(entity); // Case 2 — flush 없음 (프로덕션 버그 지점)
      return entity;
    }
    if (wrapped.__originalEntityData) {
      return (await em.upsert((entity as any).constructor, entity as any)) as T; // Case 3
    }
    em.persist(entity); // Case 4
    return entity;
  }

  /** 패치안: Case 2/4(신규)에서 persist 후 즉시 flush → Spring IDENTITY parity */
  @Transactional()
  async saveFlush<T extends object>(entity: T): Promise<T> {
    const em = this.resolveEm();
    const wrapped = helper(entity);
    if (wrapped.__managed && wrapped.__em === em) return entity;
    if (!wrapped.hasPrimaryKey()) {
      em.persist(entity);
      await em.flush(); // ← 추가되는 한 줄
      return entity;
    }
    if (wrapped.__originalEntityData) {
      return (await em.upsert((entity as any).constructor, entity as any)) as T;
    }
    em.persist(entity);
    await em.flush();
    return entity;
  }

  /** config-only 대안: 현행 로직 그대로, propagation만 NESTED (savepoint + 종료 시 자동 flush) */
  @Transactional({ propagation: TransactionPropagation.NESTED })
  async saveNested<T extends object>(entity: T): Promise<T> {
    const em = this.resolveEm();
    const wrapped = helper(entity);
    if (wrapped.__managed && wrapped.__em === em) return entity;
    if (!wrapped.hasPrimaryKey()) {
      em.persist(entity);
      return entity;
    }
    em.persist(entity);
    return entity;
  }
}

// ---------------------------------------------------------------------------
// 셋업 — SQL 로그 수집
// ---------------------------------------------------------------------------
let orm: Awaited<ReturnType<typeof MikroORM.init>>;
const sqlLog: string[] = [];

/** sqlLog에서 startIdx 이후 구간에 pattern이 포함된 쿼리 수 */
function countSql(pattern: string, startIdx = 0): number {
  return sqlLog.slice(startIdx).filter((q) => q.includes(pattern)).length;
}

beforeAll(async () => {
  orm = await MikroORM.init({
    host: 'localhost',
    port: 3307,
    user: 'root',
    password: 'test',
    dbName: 'mikro_orm_test',
    entities: [TaskEntity, DetailScalarEntity, DetailRelationEntity, uuidTaskSchema],
    metadataProvider: TsMorphMetadataProvider,
    discovery: { warnWhenNoEntities: false },
    allowGlobalContext: false,
    debug: ['query'],
    logger: (msg) => sqlLog.push(msg),
  });
  const conn = orm.em.getConnection();
  await conn.execute('SET FOREIGN_KEY_CHECKS = 0');
  await conn.execute('DROP TABLE IF EXISTS `repro_detail_scalar`');
  await conn.execute('DROP TABLE IF EXISTS `repro_detail_relation`');
  await conn.execute('DROP TABLE IF EXISTS `repro_uuid_tasks`');
  await conn.execute('DROP TABLE IF EXISTS `repro_tasks`');
  await conn.execute('SET FOREIGN_KEY_CHECKS = 1');
  await (orm as any).schema.create({ wrap: false });
});

afterAll(async () => {
  await orm.close(true);
});

beforeEach(async () => {
  const em = orm.em.fork();
  await em.nativeDelete(DetailScalarEntity, {});
  await em.nativeDelete(DetailRelationEntity, {});
  await em.nativeDelete(UuidTask, {});
  await em.nativeDelete(TaskEntity, {});
  sqlLog.length = 0;
});

// ===========================================================================
// A. FlushMode 설정 — persist 시점 early-INSERT는 없는가?
// ===========================================================================
describe('A. FlushMode 설정 — persist 시점 즉시 INSERT 옵션은 존재하지 않는다', () => {
  it('A-1 FlushMode.ALWAYS 도 persist 시점엔 INSERT하지 않는다 (쿼리 발생 시에만 flush)', async () => {
    await orm.em.transactional(async (em) => {
      em.setFlushMode(FlushMode.ALWAYS);
      const task = em.create(TaskEntity, { name: 'A-1' });
      em.persist(task);

      // persist 직후: ALWAYS 모드여도 id 미할당 (flush 트리거는 "쿼리"뿐)
      expect(task.id).toBeUndefined();

      // 무관한 타입 쿼리 → ALWAYS는 모든 쿼리 전 flush → task INSERT 발생
      await em.count(DetailScalarEntity, {});
      expect(task.id).toBeGreaterThan(0);
    });
  });

  it('A-2 FlushMode.AUTO(기본): 같은 엔티티 타입 쿼리 전에 auto-flush → 쿼리 후 id 할당', async () => {
    await orm.em.transactional(async (em) => {
      const task = em.create(TaskEntity, { name: 'A-2' });
      em.persist(task);
      expect(task.id).toBeUndefined();

      // pending INSERT 대상 타입(TaskEntity)을 쿼리 → auto-flush 발동
      const found = await em.findOne(TaskEntity, { name: 'A-2' });
      expect(found).not.toBeNull();
      expect(task.id).toBeGreaterThan(0); // 쿼리가 flush를 유발해 id 확보
    });
  });

  it('A-3 AUTO는 "값 접근"(자식 생성 시 id 복사)을 구제하지 못한다 — officials 버그 그대로 재현', async () => {
    let detailTaskIdInDb: number | null = -1;
    await orm.em.transactional(async (em) => {
      const task = em.create(TaskEntity, { name: 'A-3' });
      em.persist(task);

      // 쿼리가 아니라 "값 접근" — auto-flush 개입 지점이 없음
      const copiedId = task.id;
      expect(copiedId).toBeUndefined();

      const detail = em.create(DetailScalarEntity, { taskId: copiedId });
      em.persist(detail);
      await em.flush();
      detailTaskIdInDb = detail.taskId ?? null;
    });
    expect(detailTaskIdInDb).toBeNull(); // NULL FK — FlushMode로는 못 막는다
  });

  it('A-4 AUTO는 타입 단위 판정: 무관한 타입 쿼리는 flush를 유발하지 않는다', async () => {
    await orm.em.transactional(async (em) => {
      const task = em.create(TaskEntity, { name: 'A-4' });
      em.persist(task);

      // pending은 TaskEntity뿐 → DetailScalarEntity 쿼리는 auto-flush 안 함
      await em.count(DetailScalarEntity, {});
      expect(task.id).toBeUndefined();
      await em.flush(); // 정리
    });
  });
});

// ===========================================================================
// B. 관계(ManyToOne) + FlushMode.AUTO 조합
// ===========================================================================
describe('B. 관계 대입 + AUTO auto-flush 조합 — 수동 flush 없이 어디까지 자동화되나', () => {
  it('B-1 관계 대입 + "엔티티 참조로 쿼리" → 수동 flush 0회로 FK/read-back 모두 성공', async () => {
    await orm.em.transactional(async (em) => {
      const task = em.create(TaskEntity, { name: 'B-1' });
      em.persist(task);
      const detail = em.create(DetailRelationEntity, { task }); // 관계 대입 (id 스칼라 복사 아님)
      em.persist(detail);

      // read-back을 "id 값"이 아니라 "엔티티 참조"로 — 쿼리 전 auto-flush가 먼저 돌고,
      // where 절의 PK 추출은 flush 이후에 일어난다
      const found = await em.findOne(DetailRelationEntity, { task });

      expect(found).not.toBeNull();
      expect(task.id).toBeGreaterThan(0); // 쿼리가 flush를 유발
      expect(found!.task.id).toBe(task.id); // FK 정확
    });
  });

  it('B-2 그러나 쿼리 전에 id "값"을 읽으면 여전히 undefined — 값 접근은 자동화 불가', async () => {
    await orm.em.transactional(async (em) => {
      const task = em.create(TaskEntity, { name: 'B-2' });
      em.persist(task);
      const detail = em.create(DetailRelationEntity, { task });
      em.persist(detail);

      expect(task.id).toBeUndefined(); // 관계+AUTO여도 값 접근 시점엔 미할당
      await em.flush();
    });
  });
});

// ===========================================================================
// C. save()에 flush 추가 — Spring-parity 패치 실측
// ===========================================================================
describe('C. commons save() Case 2 + flush — Spring IDENTITY parity 패치', () => {
  it('C-1 [현행 재현] 데코레이터 경로: 외부 @Transactional 안 save(new) → id undefined (프로덕션 버그)', async () => {
    const repo = new CommonsMirrorRepo(orm.em as unknown as EntityManager);
    await orm.em.transactional(async () => {
      const task = new TaskEntity();
      task.name = 'C-1';
      await repo.save(task);
      expect(task.id).toBeUndefined(); // REQUIRED가 기존 tx에 조인만 → flush 없음
    });
  });

  it('C-2 [패치안] save(new)에 flush 추가 → 외부 tx 안에서도 id 즉시 할당 = Spring parity', async () => {
    const repo = new CommonsMirrorRepo(orm.em as unknown as EntityManager);
    let idInsideTx = 0;
    await orm.em.transactional(async (em) => {
      const task = new TaskEntity();
      task.name = 'C-2';
      await repo.saveFlush(task);
      idInsideTx = task.id;

      // officials 패턴: 스칼라 FK 복사도 이제 안전
      const detail = em.create(DetailScalarEntity, { taskId: task.id });
      em.persist(detail);
      await em.flush();
      const found = await em.findOne(DetailScalarEntity, { taskId: task.id });
      expect(found).not.toBeNull();
    });
    expect(idInsideTx).toBeGreaterThan(0);
  });

  it('C-3 [비대칭성 증명] 외부 tx가 없으면 "현행 save"도 id를 할당한다 (자체 tx 종료 시 flush)', async () => {
    const repo = new CommonsMirrorRepo(orm.em as unknown as EntityManager);
    const task = new TaskEntity();
    task.name = 'C-3';
    await repo.save(task); // REQUIRED + 기존 tx 없음 → 새 tx 생성 → 종료 시 flush
    expect(task.id).toBeGreaterThan(0); // 버그는 "외부 tx 조인" 시에만 발생하는 비대칭
  });

  it('C-4 [트레이드오프] flush는 UoW 전체를 밀어낸다 — 무관한 dirty 엔티티의 UPDATE가 조기 실행', async () => {
    // seed
    const seedEm = orm.em.fork();
    seedEm.persist(seedEm.create(TaskEntity, { name: 'C-4-old' }));
    await seedEm.flush();

    const repo = new CommonsMirrorRepo(orm.em as unknown as EntityManager);
    await orm.em.transactional(async (em) => {
      const existing = await em.findOneOrFail(TaskEntity, { name: 'C-4-old' });
      existing.name = 'C-4-dirty'; // managed dirty — 아직 flush 안 함

      const markStart = sqlLog.length;
      const task = new TaskEntity();
      task.name = 'C-4-new';
      await repo.saveFlush(task); // ← 이 flush가 dirty UPDATE까지 같이 밀어냄

      expect(countSql('insert into `repro_tasks`', markStart)).toBe(1);
      expect(countSql('update `repro_tasks`', markStart)).toBe(1); // 조기 UPDATE 실측
    });
  });

  it('C-5 [트레이드오프] 루프 save: 현행=배치 INSERT 1문, 패치안=INSERT N문 (배치 손실)', async () => {
    const repo = new CommonsMirrorRepo(orm.em as unknown as EntityManager);

    // 현행: persist만 N번 → tx 종료 flush에서 배치 INSERT 1문
    await orm.em.transactional(async () => {
      for (let i = 0; i < 3; i++) {
        const t = new TaskEntity();
        t.name = `C-5-batch-${i}`;
        await repo.save(t);
      }
    });
    const batchInserts = countSql('insert into `repro_tasks`');
    expect(batchInserts).toBe(1); // 3건이 1문으로 배치됨

    sqlLog.length = 0;

    // 패치안: save마다 flush → INSERT 3문
    await orm.em.transactional(async () => {
      for (let i = 0; i < 3; i++) {
        const t = new TaskEntity();
        t.name = `C-5-flush-${i}`;
        await repo.saveFlush(t);
      }
    });
    const perSaveInserts = countSql('insert into `repro_tasks`');
    expect(perSaveInserts).toBe(3); // 배치 손실 실측 (Spring IDENTITY도 동일한 비용)
  });

  it('C-6 [안전성] 조기 flush된 INSERT도 외부 tx 롤백 시 함께 롤백된다 (원자성 유지)', async () => {
    const repo = new CommonsMirrorRepo(orm.em as unknown as EntityManager);
    let idBeforeRollback = 0;
    await expect(
      orm.em.transactional(async () => {
        const task = new TaskEntity();
        task.name = 'C-6';
        await repo.saveFlush(task); // INSERT는 이미 DB로 나감 (같은 tx 커넥션)
        idBeforeRollback = task.id;
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');

    expect(idBeforeRollback).toBeGreaterThan(0); // flush로 id는 받았지만
    const verify = orm.em.fork();
    expect(await verify.count(TaskEntity, { name: 'C-6' })).toBe(0); // 롤백으로 사라짐
  });
});

// ===========================================================================
// D. @Transactional({ propagation: NESTED }) — config-only 대안
// ===========================================================================
describe('D. propagation: NESTED — savepoint 종료 시 자동 flush로 id 확보', () => {
  it('D-1 외부 tx 안 saveNested(new) → savepoint 생성 + 종료 flush → id 할당', async () => {
    const repo = new CommonsMirrorRepo(orm.em as unknown as EntityManager);
    let idInsideTx = 0;
    await orm.em.transactional(async () => {
      const markStart = sqlLog.length;
      const task = new TaskEntity();
      task.name = 'D-1';
      await repo.saveNested(task);
      idInsideTx = task.id;

      expect(countSql('savepoint', markStart)).toBeGreaterThan(0); // savepoint 라운드트립 확인
      expect(countSql('insert into `repro_tasks`', markStart)).toBe(1);
    });
    expect(idInsideTx).toBeGreaterThan(0);
  });

  it('D-2 saveNested 이후 엔티티는 외부 em에서 계속 managed — dirty check UPDATE 정상', async () => {
    const repo = new CommonsMirrorRepo(orm.em as unknown as EntityManager);
    await orm.em.transactional(async () => {
      const task = new TaskEntity();
      task.name = 'D-2';
      await repo.saveNested(task);
      task.name = 'D-2-modified'; // savepoint 밖(외부 tx)에서 수정
    });
    const verify = orm.em.fork();
    const found = await verify.findOne(TaskEntity, { name: 'D-2-modified' });
    expect(found).not.toBeNull(); // merge-back 후에도 dirty checking 동작
  });

  it('D-3 [트레이드오프] NESTED fork도 외부 UoW의 pending을 통째로 끌고 가 flush한다 (범위 격리 없음)', async () => {
    // fork({ clear: false })가 identity map + persist stack을 모두 복사하므로
    // (EntityManager.fork 소스 확인) savepoint 종료 flush는 외부 pending까지 INSERT한다.
    // → flush 범위 관점에선 save() 내 em.flush()와 동일. savepoint 라운드트립만 추가 비용.
    const repo = new CommonsMirrorRepo(orm.em as unknown as EntityManager);
    await orm.em.transactional(async (em) => {
      // 외부 em에 pending 신규 (persist만)
      const other = em.create(TaskEntity, { name: 'D-3-other' });
      em.persist(other);

      const task = new TaskEntity();
      task.name = 'D-3-target';
      await repo.saveNested(task);

      expect(task.id).toBeGreaterThan(0); // 대상 flush됨
      expect(other.id).toBeGreaterThan(0); // 외부 pending도 같이 flush됨 — 격리 이점 없음
      await em.flush();
    });
  });
});

// ===========================================================================
// E. 앱 생성 PK — flush가 아예 필요 없는 설계 대안
// ===========================================================================
describe('E. 앱 생성 PK(uuid) — id가 생성자에서 확정되므로 flush 무관', () => {
  it('E-1 new 직후 id 존재 — Spring parity를 넘어서는 즉시성 (단, 기존 테이블 PK 교체 필요)', async () => {
    await orm.em.transactional(async (em) => {
      const task = new UuidTask();
      task.name = 'E-1';
      expect(task.id).toMatch(/^[0-9a-f-]{36}$/); // persist 전부터 id 확정
      em.persist(task);

      const detail = em.create(DetailScalarEntity, { taskId: undefined });
      void detail; // (uuid는 스칼라 FK 복사도 안전하다는 개념 확인용 — 타입이 달라 직접 FK는 생략)
      await em.flush();
    });
    const verify = orm.em.fork();
    expect(await verify.count(UuidTask, {})).toBe(1);
  });
});
