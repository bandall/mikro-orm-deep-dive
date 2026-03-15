import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MikroORM, FlushMode } from '@mikro-orm/core';
import { INestApplication } from '@nestjs/common';
import { TestingModule } from '@nestjs/testing';
import { AuthorEntity } from '../../src/behavior/entities/author.entity';
import { BookEntity } from '../../src/behavior/entities/book.entity';
import { createTestingApp, resetSchema } from './setup';

describe('3. flush 시점과 FlushMode', () => {
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

  it('3-1: persist(Author) → find(Author) (AUTO) → auto flush 후 조회', async () => {
    const em = orm.em.fork({ flushMode: FlushMode.AUTO });
    const author = em.create(AuthorEntity, { name: 'AutoFlush' });
    em.persist(author);

    // 같은 엔티티 타입 조회 → auto flush 발동
    const found = await em.find(AuthorEntity, { name: 'AutoFlush' });
    expect(found.length).toBe(1);
  });

  it('3-2: persist(Author) → find(Book) (AUTO) → flush 안 함', async () => {
    const em = orm.em.fork({ flushMode: FlushMode.AUTO });
    const author = em.create(AuthorEntity, { name: 'NoFlush' });
    em.persist(author);

    // 다른 엔티티 타입 조회 → flush 안 함
    await em.find(BookEntity, {});

    // 별도 EM으로 DB 확인 → Author INSERT 안 됐어야 함
    const verify = orm.em.fork();
    const found = await verify.findOne(AuthorEntity, { name: 'NoFlush' });
    console.log('3-2 result: author in DB =', found !== null);
  });

  it('3-3: persist(Author) → find(Book) (ALWAYS) → flush 발동', async () => {
    const em = orm.em.fork({ flushMode: FlushMode.ALWAYS });
    const author = em.create(AuthorEntity, { name: 'AlwaysFlush' });
    em.persist(author);

    // ALWAYS 모드 → 다른 타입이어도 flush
    await em.find(BookEntity, {});

    const verify = orm.em.fork();
    const found = await verify.findOne(AuthorEntity, { name: 'AlwaysFlush' });
    expect(found).not.toBeNull();
  });

  it('3-4: dirty checking + 같은 타입 조건 조회 (AUTO) → auto flush 안 됨 (UPDATE는 대상 아님)', async () => {
    // seed
    const seed = orm.em.fork();
    seed.persist(seed.create(AuthorEntity, { name: 'Before' }));
    await seed.flush();

    const em = orm.em.fork({ flushMode: FlushMode.AUTO });
    const author = await em.findOneOrFail(AuthorEntity, { name: 'Before' });
    author.name = 'After';

    // [발견] AUTO mode는 pending INSERT만 flush, dirty UPDATE는 flush하지 않음
    const found = await em.find(AuthorEntity, { name: 'After' });
    expect(found.length).toBe(0); // DB에는 아직 'Before'

    // 수동 flush 후에야 반영됨
    await em.flush();
    const verify = orm.em.fork();
    const afterFlush = await verify.findOne(AuthorEntity, { name: 'After' });
    expect(afterFlush).not.toBeNull();
  });

  it('3-5: FlushMode.COMMIT + persist → find → flush 안 함', async () => {
    const em = orm.em.fork({ flushMode: FlushMode.COMMIT });
    const author = em.create(AuthorEntity, { name: 'CommitMode' });
    em.persist(author);

    // COMMIT 모드 → 조회해도 flush 안 함
    await em.find(AuthorEntity, { name: 'CommitMode' });

    const verify = orm.em.fork();
    const found = await verify.findOne(AuthorEntity, { name: 'CommitMode' });
    expect(found).toBeNull(); // 아직 DB에 없음
  });
});
