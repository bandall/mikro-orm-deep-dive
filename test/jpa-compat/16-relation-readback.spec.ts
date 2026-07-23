import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MikroORM } from '@mikro-orm/mysql';
import { TsMorphMetadataProvider } from '@mikro-orm/reflection';
import { TaskEntity } from '../../src/jpa-compat/repro-officials/task.entity';
import { DetailScalarEntity } from '../../src/jpa-compat/repro-officials/detail-scalar.entity';
import { DetailRelationEntity } from '../../src/jpa-compat/repro-officials/detail-relation.entity';

/**
 * auths identify(신규 유저) 패턴 검증:
 *   신규 부모 persist(no flush) → 자식에 "관계 대입"(child.task = task) → 명시 flush → read-back.
 *
 * 질문: 관계를 맺으면 내부 조회(read-back)가 안전한가?
 * 답:  - 관계 대입은 flush 시 FK 를 자동 해소(자식→부모 연결 정확).
 *      - 그러나 read-back 을 "부모 id 로 조회"하면, 그 id 는 flush 전까지 undefined.
 *      => 안전의 조건 = "read-back 전에 flush"(= identify 가 하는 것). 관계 대입만으론 부족.
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
  await em.nativeDelete(DetailRelationEntity, {});
  await em.nativeDelete(DetailScalarEntity, {});
  await em.nativeDelete(TaskEntity, {});
});

describe('관계 대입 + 내부 read-back (identify 패턴 검증)', () => {
  it('✅ identify 패턴: 관계 대입 → 명시 flush → read-back(부모 id) 정상', async () => {
    let taskFound = false;
    let detailFound = false;
    let inMemoryFkOk = false;

    await orm.em.transactional(async (em) => {
      const task = em.create(TaskEntity, { name: '신규 유저(부모)' });
      em.persist(task); // save(new) — flush 아직

      const detail = em.create(DetailRelationEntity, { task }); // 관계 대입(엔티티 참조)
      em.persist(detail);

      await em.flush(); // ← identify 의 usersRepository.flush() 대응: 부모 INSERT + id 확정

      // 내부 read-back: 부모 id 로 조회 (identify 의 findById(user.id) 대응)
      const foundTask = await em.findOne(TaskEntity, task.id);
      const foundDetail = await em.findOne(DetailRelationEntity, { task: task.id });

      taskFound = foundTask !== null;
      detailFound = foundDetail !== null;
      inMemoryFkOk = detail.task.id === task.id && task.id > 0;
    });

    expect(taskFound).toBe(true); // flush 후라 부모 id 유효 → 조회 성공
    expect(detailFound).toBe(true); // 자식도 올바른 FK 로 조회됨
    expect(inMemoryFkOk).toBe(true); // in-memory 참조도 flush 후 id 채워짐
  });

  it('🔴 관계는 맺었지만 flush 전에 read-back(부모 id) → 부모 id 미할당이라 실패', async () => {
    let idBeforeFlush: number | undefined;
    let foundBeforeFlush: TaskEntity | null = null;

    await orm.em.transactional(async (em) => {
      const task = em.create(TaskEntity, { name: '부모2' });
      em.persist(task);
      const detail = em.create(DetailRelationEntity, { task }); // 관계 대입은 함
      em.persist(detail);

      idBeforeFlush = task.id; // flush 전 → undefined

      // flush 없이 부모 id 로 read-back 시도
      foundBeforeFlush =
        task.id === undefined ? null : await em.findOne(TaskEntity, task.id);

      await em.flush(); // (정리용)
    });

    expect(idBeforeFlush).toBeUndefined(); // 관계를 맺어도 부모 id 는 flush 전 미할당
    expect(foundBeforeFlush).toBeNull(); // => id 기반 read-back 은 실패 (관계 대입이 구제 못 함)
  });

  it('✅ 관계 대입은 FK 정합만은 flush 순서로 항상 보장 (자식→부모 연결 정확)', async () => {
    let childFk = -1;
    let parentId = -1;
    await orm.em.transactional(async (em) => {
      const task = em.create(TaskEntity, { name: '부모3' });
      em.persist(task);
      const detail = em.create(DetailRelationEntity, { task });
      em.persist(detail);
      await em.flush(); // 부모 먼저 INSERT → 자식 FK 자동 해소
      parentId = task.id;
      // 커밋 후 상태 확인용: 새 fork 로 재조회
    });
    // 트랜잭션 커밋 후 독립 fork 로 DB 실제 저장 확인
    const em2 = orm.em.fork();
    const detail = await em2.findOne(DetailRelationEntity, { task: parentId }, { populate: ['task'] });
    childFk = detail!.task.id;
    expect(childFk).toBe(parentId); // 스칼라 복사와 달리 NULL 이 아님 — 항상 정확
  });
});
