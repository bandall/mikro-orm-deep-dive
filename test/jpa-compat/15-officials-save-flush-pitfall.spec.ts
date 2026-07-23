import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MikroORM } from '@mikro-orm/mysql';
import { TsMorphMetadataProvider } from '@mikro-orm/reflection';
import { TaskEntity } from '../../src/jpa-compat/repro-officials/task.entity';
import { DetailScalarEntity } from '../../src/jpa-compat/repro-officials/detail-scalar.entity';
import { DetailRelationEntity } from '../../src/jpa-compat/repro-officials/detail-relation.entity';

/**
 * managements officials/opens create() 프로덕션 장애 재현.
 *
 * 근본원인: BaseRepository.save(new)는 이미 열린 @Transactional(=em.transactional fork) 안에서
 *          persist 만 하고 flush 하지 않는다 → 신규 부모의 auto-increment id 가 undefined.
 *          이 미할당 id 를 자식의 스칼라 FK 로 복사하면 자식이 NULL FK 로 INSERT → read-back 실패.
 *
 * em.transactional(cb) 가 서비스의 외부 @Transactional 을, cb 안의 persist(no flush) 가
 * BaseRepository.save Case 2(base.repository.ts:18-20) 를 미러한다.
 */
let orm: Awaited<ReturnType<typeof MikroORM.init>>;

beforeAll(async () => {
  orm = await MikroORM.init({
    host: 'localhost',
    port: 3307,
    user: 'root',
    password: 'test',
    dbName: 'mikro_orm_test',
    entities: [TaskEntity, DetailScalarEntity, DetailRelationEntity],
    metadataProvider: TsMorphMetadataProvider,
    discovery: { warnWhenNoEntities: false },
    allowGlobalContext: false,
    debug: false,
  });
  // setup.ts 패턴: 이 repro 3개 테이블만 drop 후 create (다른 테이블 무영향)
  const conn = orm.em.getConnection();
  await conn.execute('SET FOREIGN_KEY_CHECKS = 0');
  await conn.execute('DROP TABLE IF EXISTS `repro_detail_scalar`');
  await conn.execute('DROP TABLE IF EXISTS `repro_detail_relation`');
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
  await em.nativeDelete(TaskEntity, {});
});

describe('officials 장애 재현 — save(new) + 스칼라 FK 복사', () => {
  it('🔴 BUG: @Transactional 안에서 persist(no flush) → task.id undefined → detail.taskId NULL → read-back 실패', async () => {
    let idDuringTx: number | undefined;
    let detailTaskIdAfterFlush: number | null | undefined;
    let readBackResult: DetailScalarEntity | null = null;

    await orm.em.transactional(async (em) => {
      // save(new) Case 2 미러: persist 만, flush 없음
      const task = em.create(TaskEntity, { name: '오류동삼천리 준공' });
      em.persist(task);

      idDuringTx = task.id; // ← 이 시점 id 미할당 (undefined) 이어야 버그

      // 미할당 id 를 스칼라 FK 로 복사 (officials createOfficial({projectTaskId: task.id}))
      const detail = em.create(DetailScalarEntity, { taskId: task.id });
      em.persist(detail);

      await em.flush(); // 여기서 task INSERT + id 할당, 그러나 detail.taskId 는 이미 undefined 로 박힘
      detailTaskIdAfterFlush = detail.taskId;

      // read-back: 이제 task.id 는 할당됨 → 그 id 로 detail 조회 (officials getOfficialByProjectTaskId)
      readBackResult = await em.findOne(DetailScalarEntity, { taskId: task.id });
    });

    expect(idDuringTx).toBeUndefined(); // 트랜잭션 내 persist 직후 id 미할당
    expect(detailTaskIdAfterFlush ?? null).toBeNull(); // detail 은 NULL FK 로 저장됨
    expect(readBackResult).toBeNull(); // ← read-back 실패 = "OfficialDetail for task(N) not found"
  });

  it('✅ FIX A: 엔티티 관계 대입(detail.task = task) → flush 순서로 FK 자동 해소', async () => {
    let ok = false;
    await orm.em.transactional(async (em) => {
      const task = em.create(TaskEntity, { name: 'relation fix' });
      em.persist(task);

      const detail = em.create(DetailRelationEntity, { task }); // ← id 스칼라 아니라 엔티티 참조
      em.persist(detail);

      await em.flush(); // 부모 먼저 INSERT → id 획득 → 자식 FK 해소

      expect(task.id).toBeGreaterThan(0);
      expect(detail.task.id).toBe(task.id); // FK 정확
      const found = await em.findOne(DetailRelationEntity, { task: task.id });
      ok = found !== null;
    });
    expect(ok).toBe(true);
  });

  it('✅ FIX B: createAndFlush(부모 먼저 flush로 id 확정) → 스칼라 FK 유효', async () => {
    let ok = false;
    await orm.em.transactional(async (em) => {
      const task = em.create(TaskEntity, { name: 'createAndFlush fix' });
      em.persist(task);
      await em.flush(); // ← 자식 생성 전에 flush → task.id 확정

      expect(task.id).toBeGreaterThan(0);

      const detail = em.create(DetailScalarEntity, { taskId: task.id }); // 유효 id 복사
      em.persist(detail);
      await em.flush();

      const found = await em.findOne(DetailScalarEntity, { taskId: task.id });
      ok = found !== null && found.taskId === task.id;
    });
    expect(ok).toBe(true);
  });
});
