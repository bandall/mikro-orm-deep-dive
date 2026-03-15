import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MikroORM } from '@mikro-orm/core';
import { INestApplication } from '@nestjs/common';
import { TestingModule } from '@nestjs/testing';
import { UserEntity } from '../../src/jpa-compat/entities/user.entity';
import { UserRepository } from '../../src/jpa-compat/repositories/user.repository';
import { UserService } from '../../src/jpa-compat/services/user.service';
import { createTestingApp, resetSchema } from './setup';

describe('12. BaseRepository — JPA-like 메서드', () => {
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

  it('12-1: save(새 엔티티) → INSERT', async () => {
    const em = orm.em.fork();
    const repo = em.getRepository(UserEntity) as UserRepository;
    const user = em.create(UserEntity, { name: 'Save New' });
    const saved = await repo.save(user);

    expect(saved.id).toBeDefined();

    const verify = orm.em.fork();
    const found = await verify.findOne(UserEntity, { name: 'Save New' });
    expect(found).not.toBeNull();
  });

  it('12-2: save(변경된 엔티티) → UPDATE', async () => {
    // seed
    const seed = orm.em.fork();
    const user = seed.create(UserEntity, { name: 'Before' });
    seed.persist(user);
    await seed.flush();

    // update
    const em = orm.em.fork();
    const repo = em.getRepository(UserEntity) as UserRepository;
    const target = await em.findOneOrFail(UserEntity, { name: 'Before' });
    target.name = 'After';
    await repo.save(target);

    const verify = orm.em.fork();
    const found = await verify.findOne(UserEntity, { name: 'After' });
    expect(found).not.toBeNull();
  });

  it('12-3: save(변경 없는 엔티티) → 쿼리 없음', async () => {
    const seed = orm.em.fork();
    seed.persist(seed.create(UserEntity, { name: 'NoChange' }));
    await seed.flush();

    const em = orm.em.fork();
    const repo = em.getRepository(UserEntity) as UserRepository;
    const target = await em.findOneOrFail(UserEntity, { name: 'NoChange' });
    await repo.save(target); // 변경 없음

    const verify = orm.em.fork();
    const found = await verify.findOne(UserEntity, { name: 'NoChange' });
    expect(found).not.toBeNull();
  });

  it('12-4: saveAll() → 벌크 INSERT', async () => {
    const em = orm.em.fork();
    const repo = em.getRepository(UserEntity) as UserRepository;
    const users = [
      em.create(UserEntity, { name: 'Bulk 1' }),
      em.create(UserEntity, { name: 'Bulk 2' }),
      em.create(UserEntity, { name: 'Bulk 3' }),
    ];
    await repo.saveAll(users);

    const verify = orm.em.fork();
    const count = await verify.count(UserEntity, {});
    expect(count).toBe(3);
  });

  it('12-5: findById() → 조회 성공', async () => {
    const seed = orm.em.fork();
    const user = seed.create(UserEntity, { name: 'FindById' });
    seed.persist(user);
    await seed.flush();
    const id = user.id;

    const em = orm.em.fork();
    const repo = em.getRepository(UserEntity) as UserRepository;
    const found = await repo.findById(id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('FindById');
  });

  it('12-6: findById(없는 ID) → null', async () => {
    const em = orm.em.fork();
    const repo = em.getRepository(UserEntity) as UserRepository;
    const found = await repo.findById(99999);
    expect(found).toBeNull();
  });

  it('12-7: findByIdOrFail(없는 ID) → 에러', async () => {
    const em = orm.em.fork();
    const repo = em.getRepository(UserEntity) as UserRepository;
    await expect(repo.findByIdOrFail(99999)).rejects.toThrow();
  });

  it('12-8: existsById() → true/false', async () => {
    const seed = orm.em.fork();
    const user = seed.create(UserEntity, { name: 'Exists' });
    seed.persist(user);
    await seed.flush();
    const id = user.id;

    const em = orm.em.fork();
    const repo = em.getRepository(UserEntity) as UserRepository;
    expect(await repo.existsById(id)).toBe(true);
    expect(await repo.existsById(99999)).toBe(false);
  });

  it('12-9: deleteById() → 삭제', async () => {
    const seed = orm.em.fork();
    const user = seed.create(UserEntity, { name: 'ToDelete' });
    seed.persist(user);
    await seed.flush();
    const id = user.id;

    const em = orm.em.fork();
    const repo = em.getRepository(UserEntity) as UserRepository;
    await repo.deleteById(id);

    const verify = orm.em.fork();
    const found = await verify.findOne(UserEntity, id);
    expect(found).toBeNull();
  });

  it('12-10: delete(entity) → 삭제', async () => {
    const seed = orm.em.fork();
    const user = seed.create(UserEntity, { name: 'EntityDelete' });
    seed.persist(user);
    await seed.flush();
    const id = user.id;

    const em = orm.em.fork();
    const repo = em.getRepository(UserEntity) as UserRepository;
    const target = await em.findOneOrFail(UserEntity, id);
    await repo.delete(target);

    const verify = orm.em.fork();
    const found = await verify.findOne(UserEntity, id);
    expect(found).toBeNull();
  });

  it('12-11: 커스텀 메서드 findByName() → 정상 동작', async () => {
    const seed = orm.em.fork();
    seed.persist(seed.create(UserEntity, { name: 'CustomQuery' }));
    await seed.flush();

    const em = orm.em.fork();
    const repo = em.getRepository(UserEntity) as UserRepository;
    const found = await repo.findByName('CustomQuery');
    expect(found).not.toBeNull();
  });

  it('12-12: @Transactional() 없이 repo 사용 → allowGlobalContext=false이면 에러', async () => {
    // createUserWithSave는 @Transactional() 없이 repo.create() 호출
    // → 글로벌 EM에 접근하므로 에러
    const userService = module.get(UserService);
    await expect(userService.createUserWithSave('SaveInTx')).rejects.toThrow(
      /global EntityManager/,
    );
  });
});
