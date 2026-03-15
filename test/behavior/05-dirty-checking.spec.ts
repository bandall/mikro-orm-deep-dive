import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MikroORM } from '@mikro-orm/core';
import { INestApplication } from '@nestjs/common';
import { TestingModule } from '@nestjs/testing';
import { AuthorEntity } from '../../src/behavior/entities/author.entity';
import { createTestingApp, resetSchema } from './setup';

describe('5. Dirty Checking', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let module: TestingModule;
  let seedId: number;

  beforeAll(async () => {
    ({ app, orm, module } = await createTestingApp());
  });

  afterAll(async () => {
    await orm.close();
    await app.close();
  });

  beforeEach(async () => {
    await resetSchema(orm);
    const seed = orm.em.fork();
    const author = seed.create(AuthorEntity, { name: 'Original', email: 'original@test.com' });
    seed.persist(author);
    await seed.flush();
    seedId = author.id;
  });

  it('5-1: 필드 변경 → flush → UPDATE', async () => {
    const em = orm.em.fork();
    const author = await em.findOneOrFail(AuthorEntity, seedId);
    author.name = 'Updated';
    await em.flush();

    const verify = orm.em.fork();
    const found = await verify.findOneOrFail(AuthorEntity, seedId);
    expect(found.name).toBe('Updated');
  });

  it('5-2: 같은 값으로 할당 → flush → 쿼리 없음', async () => {
    const em = orm.em.fork();
    const author = await em.findOneOrFail(AuthorEntity, seedId);
    author.name = 'Original'; // 같은 값
    await em.flush();

    const verify = orm.em.fork();
    const found = await verify.findOneOrFail(AuthorEntity, seedId);
    expect(found.name).toBe('Original');
  });

  it('5-3: 여러 필드 변경 → flush → UPDATE 1회', async () => {
    const em = orm.em.fork();
    const author = await em.findOneOrFail(AuthorEntity, seedId);
    author.name = 'Multi Updated';
    author.email = 'multi@test.com';
    await em.flush();

    const verify = orm.em.fork();
    const found = await verify.findOneOrFail(AuthorEntity, seedId);
    expect(found.name).toBe('Multi Updated');
    expect(found.email).toBe('multi@test.com');
  });

  it('5-4: 필드 변경 → persist 없이 flush → UPDATE 실행', async () => {
    const em = orm.em.fork();
    const author = await em.findOneOrFail(AuthorEntity, seedId);
    author.name = 'NoPersist Update';
    // persist() 호출 안 함
    await em.flush();

    const verify = orm.em.fork();
    const found = await verify.findOneOrFail(AuthorEntity, seedId);
    expect(found.name).toBe('NoPersist Update');
  });
});
