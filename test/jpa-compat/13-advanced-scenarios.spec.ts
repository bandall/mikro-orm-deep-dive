import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MikroORM, helper } from '@mikro-orm/core';
import { INestApplication } from '@nestjs/common';
import { TestingModule } from '@nestjs/testing';
import { UserEntity } from '../../src/jpa-compat/entities/user.entity';
import { PostEntity } from '../../src/jpa-compat/entities/post.entity';
import { UserRepository } from '../../src/jpa-compat/repositories/user.repository';
import { UserService } from '../../src/jpa-compat/services/user.service';
import { createTestingApp, resetSchema } from './setup';

describe('13. BaseRepository — 고급 시나리오', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let module: TestingModule;

  beforeAll(async () => {
    ({ app, orm, module } = await createTestingApp());
  });

  afterAll(async () => {
    await orm.close();
    await app.close();
  });

  beforeEach(async () => {
    await resetSchema(orm);
  });

  // --- Detached Entity Save ---

  it('13-1: save(detached 엔티티) → 다른 EM에서 로드된 엔티티 upsert UPDATE', async () => {
    // seed
    const seed = orm.em.fork();
    const user = seed.create(UserEntity, { name: 'Original', email: 'a@b.com' });
    seed.persist(user);
    await seed.flush();
    const id = user.id;

    // 다른 EM에서 로드 (detached 시뮬레이션)
    const em1 = orm.em.fork();
    const loaded = await em1.findOneOrFail(UserEntity, id);

    // 또 다른 EM에서 save — loaded는 이 EM 입장에서 detached
    const em2 = orm.em.fork();
    const repo2 = em2.getRepository(UserEntity) as UserRepository;
    loaded.name = 'Merged';
    const saved = await repo2.save(loaded);

    expect(saved.name).toBe('Merged');

    const verify = orm.em.fork();
    const found = await verify.findOne(UserEntity, id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Merged');
  });

  it('13-2: save(detached 엔티티) → 변경 없이 upsert → 데이터 유지', async () => {
    const seed = orm.em.fork();
    const user = seed.create(UserEntity, { name: 'NoChangeMerge' });
    seed.persist(user);
    await seed.flush();
    const id = user.id;

    const em1 = orm.em.fork();
    const loaded = await em1.findOneOrFail(UserEntity, id);

    // 변경 없이 다른 EM에서 save
    const em2 = orm.em.fork();
    const repo2 = em2.getRepository(UserEntity) as UserRepository;
    const saved = await repo2.save(loaded);

    expect(saved.name).toBe('NoChangeMerge');

    const verify = orm.em.fork();
    const found = await verify.findOne(UserEntity, id);
    expect(found!.name).toBe('NoChangeMerge');
  });

  // --- Delete Rollback ---

  it('13-3: deleteById() 후 외부 @Transactional() 예외 → rollback (삭제 취소)', async () => {
    const seed = orm.em.fork();
    const user = seed.create(UserEntity, { name: 'DeleteRollback' });
    seed.persist(user);
    await seed.flush();
    const id = user.id;

    // 서비스에서 @Transactional() 안에서 delete 후 throw → rollback
    const userService = module.get(UserService);

    try {
      await userService.deleteUserAndThrow(id);
    } catch {
      // expected
    }

    const verify = orm.em.fork();
    const found = await verify.findOne(UserEntity, id);
    expect(found).not.toBeNull(); // rollback되어 남아있어야 함
    expect(found!.name).toBe('DeleteRollback');
  });

  // --- Save + Delete Mixed ---

  it('13-4: 같은 EM에서 save + delete 연속 호출 → 정상 처리', async () => {
    const em = orm.em.fork();
    const repo = em.getRepository(UserEntity) as UserRepository;

    // 새 엔티티 save
    const user1 = em.create(UserEntity, { name: 'Keep' });
    await repo.save(user1);

    const user2 = em.create(UserEntity, { name: 'ToRemove' });
    await repo.save(user2);

    // user2 삭제
    await repo.delete(user2);

    const verify = orm.em.fork();
    const remaining = await verify.find(UserEntity, {});
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe('Keep');
  });

  // --- Cascade Persist through save() ---

  it('13-5: save(유저 + posts) → Cascade.PERSIST로 관련 엔티티 함께 저장', async () => {
    const em = orm.em.fork();
    const repo = em.getRepository(UserEntity) as UserRepository;

    const user = em.create(UserEntity, { name: 'WithPosts' });
    const post1 = em.create(PostEntity, { title: 'Post 1', user });
    const post2 = em.create(PostEntity, { title: 'Post 2', user });
    user.posts.add(post1, post2);

    await repo.save(user);

    const verify = orm.em.fork();
    const found = await verify.findOne(UserEntity, { name: 'WithPosts' }, { populate: ['posts'] });
    expect(found).not.toBeNull();
    expect(found!.posts).toHaveLength(2);
    expect(found!.posts.getItems().map((p) => p.title).sort()).toEqual(['Post 1', 'Post 2']);
  });

  // --- Entity State Detection ---

  it('13-6: helper() API로 엔티티 상태 확인', async () => {
    const em = orm.em.fork();

    // 새 엔티티
    const newUser = em.create(UserEntity, { name: 'StateCheck' });
    const newWrapped = helper(newUser);
    expect(newWrapped.__managed).toBeFalsy();
    expect(newWrapped.hasPrimaryKey()).toBe(false);
    expect(newWrapped.__originalEntityData).toBeUndefined();

    // persist 후
    em.persist(newUser);
    await em.flush();
    const managedWrapped = helper(newUser);
    expect(managedWrapped.__managed).toBe(true);
    expect(managedWrapped.hasPrimaryKey()).toBe(true);
    expect(managedWrapped.__originalEntityData).toBeDefined();

    // 다른 EM에서 보면 detached
    const em2 = orm.em.fork();
    const detachedWrapped = helper(newUser);
    expect(detachedWrapped.__managed).toBe(true); // 원래 EM에서는 managed
    expect(detachedWrapped.__em).not.toBe(em2); // 하지만 em2에서는 detached
  });

  // --- saveAll with mixed states ---

  it('13-7: saveAll() 혼합 상태 — new + managed → 모두 정상 처리', async () => {
    const em = orm.em.fork();
    const repo = em.getRepository(UserEntity) as UserRepository;

    // managed 엔티티
    const existing = em.create(UserEntity, { name: 'Existing' });
    em.persist(existing);
    await em.flush();
    existing.name = 'Updated';

    // new 엔티티
    const newUser = em.create(UserEntity, { name: 'Brand New' });

    await repo.saveAll([existing, newUser]);

    const verify = orm.em.fork();
    const all = await verify.find(UserEntity, {}, { orderBy: { id: 'asc' } });
    expect(all).toHaveLength(2);
    expect(all[0].name).toBe('Updated');
    expect(all[1].name).toBe('Brand New');
  });

  // --- deleteAll ---

  it('13-8: deleteAll() → 여러 엔티티를 flush 1번으로 삭제', async () => {
    const em = orm.em.fork();
    const repo = em.getRepository(UserEntity) as UserRepository;

    const u1 = em.create(UserEntity, { name: 'Del1' });
    const u2 = em.create(UserEntity, { name: 'Del2' });
    const u3 = em.create(UserEntity, { name: 'Keep' });
    em.persist([u1, u2, u3]);
    await em.flush();

    await repo.deleteAll([u1, u2]);

    const verify = orm.em.fork();
    const remaining = await verify.find(UserEntity, {});
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe('Keep');
  });

  it('13-9: deleteAllByIds() → 단일 DELETE WHERE id IN (...) 쿼리', async () => {
    const em = orm.em.fork();
    const repo = em.getRepository(UserEntity) as UserRepository;

    const u1 = em.create(UserEntity, { name: 'Bulk1' });
    const u2 = em.create(UserEntity, { name: 'Bulk2' });
    const u3 = em.create(UserEntity, { name: 'Survive' });
    em.persist([u1, u2, u3]);
    await em.flush();

    const deleted = await repo.deleteAllByIds([u1.id, u2.id]);
    expect(deleted).toBe(2);

    const verify = orm.em.fork();
    const remaining = await verify.find(UserEntity, {});
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe('Survive');
  });
});
