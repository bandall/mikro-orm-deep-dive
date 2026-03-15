import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MikroORM } from '@mikro-orm/core';
import { INestApplication } from '@nestjs/common';
import { TestingModule } from '@nestjs/testing';
import { AuthorEntity } from '../../src/behavior/entities/author.entity';
import { AuthorRepository } from '../../src/behavior/repositories/author.repository';
import { OuterService } from '../../src/behavior/services/outer.service';
import { createTestingApp, resetSchema } from './setup';

describe('6. save() 패턴 검증', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let module: TestingModule;
  let outerService: OuterService;

  beforeAll(async () => {
    ({ app, orm, module } = await createTestingApp());
    outerService = module.get(OuterService);
  });

  afterAll(async () => {
    await orm.close();
    await app.close();
  });

  beforeEach(async () => {
    await resetSchema(orm);
  });

  it('6-1: 새 엔티티 → save() → INSERT', async () => {
    const em = orm.em.fork();
    const repo = em.getRepository(AuthorEntity) as unknown as AuthorRepository;
    const author = em.create(AuthorEntity, { name: 'Save New' });
    await repo.save(author);

    const verify = orm.em.fork();
    const found = await verify.findOne(AuthorEntity, { name: 'Save New' });
    expect(found).not.toBeNull();
  });

  it('6-2: 조회한 엔티티 필드 변경 → save() → UPDATE', async () => {
    // seed
    const seed = orm.em.fork();
    seed.persist(seed.create(AuthorEntity, { name: 'Before Save' }));
    await seed.flush();

    const em = orm.em.fork();
    const repo = em.getRepository(AuthorEntity) as unknown as AuthorRepository;
    const author = await em.findOneOrFail(AuthorEntity, { name: 'Before Save' });
    author.name = 'After Save';
    await repo.save(author);

    const verify = orm.em.fork();
    const found = await verify.findOneOrFail(AuthorEntity, { name: 'After Save' });
    expect(found.name).toBe('After Save');
  });

  it('6-3: 조회한 엔티티 변경 없음 → save() → 쿼리 없음', async () => {
    const seed = orm.em.fork();
    seed.persist(seed.create(AuthorEntity, { name: 'NoChange' }));
    await seed.flush();

    const em = orm.em.fork();
    const repo = em.getRepository(AuthorEntity) as unknown as AuthorRepository;
    const author = await em.findOneOrFail(AuthorEntity, { name: 'NoChange' });
    await repo.save(author); // 변경 없음

    const verify = orm.em.fork();
    const found = await verify.findOneOrFail(AuthorEntity, { name: 'NoChange' });
    expect(found.name).toBe('NoChange');
  });

  it('6-4: 바깥 @Transactional 안에서 save() → 바깥 트랜잭션에 참여', async () => {
    const em = orm.em.fork();
    const author = em.create(AuthorEntity, { name: 'Outer Save' });
    await outerService.saveWithRepo(author);

    const verify = orm.em.fork();
    const found = await verify.findOne(AuthorEntity, { name: 'Outer Save' });
    expect(found).not.toBeNull();
  });

  it('6-5: 바깥 트랜잭션 없이 save() → 자체 트랜잭션으로 commit', async () => {
    const em = orm.em.fork();
    const repo = em.getRepository(AuthorEntity) as unknown as AuthorRepository;
    const author = em.create(AuthorEntity, { name: 'Self Tx Save' });
    await repo.save(author);

    const verify = orm.em.fork();
    const found = await verify.findOne(AuthorEntity, { name: 'Self Tx Save' });
    expect(found).not.toBeNull();
  });
});
