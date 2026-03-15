import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MikroORM } from '@mikro-orm/core';
import { INestApplication } from '@nestjs/common';
import { TestingModule } from '@nestjs/testing';
import { AuthorEntity } from '../../src/behavior/entities/author.entity';
import { BookEntity } from '../../src/behavior/entities/book.entity';
import { BookRepository } from '../../src/behavior/repositories/book.repository';
import { AuthorRepository } from '../../src/behavior/repositories/author.repository';
import { createTestingApp, resetSchema } from './setup';

describe('10. insertMany()', () => {
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

  it('10-1: insertMany → DB에 INSERT, Identity Map에는 없음', async () => {
    const em = orm.em.fork();
    const repo = em.getRepository(AuthorEntity) as unknown as AuthorRepository;
    await repo.insertMany([
      { name: 'Bulk 1' },
      { name: 'Bulk 2' },
      { name: 'Bulk 3' },
    ]);

    // Identity Map 확인
    const identityMap = em.getUnitOfWork().getIdentityMap();
    const authorsInMap = identityMap.values().filter(
      (e) => e instanceof AuthorEntity,
    );
    expect(authorsInMap.length).toBe(0);

    // DB 확인
    const verify = orm.em.fork();
    const all = await verify.find(AuthorEntity, {});
    expect(all.length).toBe(3);
  });

  it('10-2: insertMany 후 find → DB에서 새로 Identity Map 등록', async () => {
    const em = orm.em.fork();
    const repo = em.getRepository(AuthorEntity) as unknown as AuthorRepository;
    await repo.insertMany([{ name: 'FindAfter' }]);

    const found = await em.findOne(AuthorEntity, { name: 'FindAfter' });
    expect(found).not.toBeNull();
    expect(found!.name).toBe('FindAfter');

    // 이제 Identity Map에 있음
    const identityMap = em.getUnitOfWork().getIdentityMap();
    const authorsInMap = identityMap.values().filter(
      (e) => e instanceof AuthorEntity,
    );
    expect(authorsInMap.length).toBe(1);
  });

  it('10-3: @Transactional 안에서 insertMany → 예외 시 rollback', async () => {
    const em = orm.em.fork();

    try {
      await em.transactional(async (txEm) => {
        const repo = txEm.getRepository(AuthorEntity) as unknown as AuthorRepository;
        await repo.insertMany([{ name: 'Rollback Bulk' }]);
        throw new Error('Force rollback');
      });
    } catch {
      // expected
    }

    const verify = orm.em.fork();
    const found = await verify.findOne(AuthorEntity, { name: 'Rollback Bulk' });
    expect(found).toBeNull();
  });

  it('10-4: 500건 chunk insertMany 반복 → 모두 정상 INSERT', async () => {
    const em = orm.em.fork();
    const repo = em.getRepository(AuthorEntity) as unknown as AuthorRepository;

    const totalItems = 1200;
    const chunkSize = 500;
    const allData = Array.from({ length: totalItems }, (_, i) => ({ name: `Chunk ${i}` }));

    for (let i = 0; i < allData.length; i += chunkSize) {
      const chunk = allData.slice(i, i + chunkSize);
      await repo.insertMany(chunk);
    }

    const verify = orm.em.fork();
    const count = await verify.count(AuthorEntity, {});
    expect(count).toBe(totalItems);
  });
});
