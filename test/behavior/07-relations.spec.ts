import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MikroORM } from '@mikro-orm/core';
import { INestApplication } from '@nestjs/common';
import { TestingModule } from '@nestjs/testing';
import { AuthorEntity } from '../../src/behavior/entities/author.entity';
import { BookEntity } from '../../src/behavior/entities/book.entity';
import { BookRepository } from '../../src/behavior/repositories/book.repository';
import { createTestingApp, resetSchema } from './setup';

describe('7. 관계(Relation) INSERT/DELETE', () => {
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

  it('7-1: 부모 + 자식 함께 persist → flush → 둘 다 INSERT', async () => {
    const em = orm.em.fork();
    const author = em.create(AuthorEntity, { name: 'Parent' });
    const book = em.create(BookEntity, { title: 'Child Book', author });
    em.persist(author);
    em.persist(book);
    await em.flush();

    const verify = orm.em.fork();
    const found = await verify.findOne(BookEntity, { title: 'Child Book' }, { populate: ['author'] });
    expect(found).not.toBeNull();
    expect(found!.author.name).toBe('Parent');
  });

  it('7-2: 부모만 persist + cascade PERSIST → 자식도 INSERT', async () => {
    const em = orm.em.fork();
    const author = em.create(AuthorEntity, { name: 'Cascade Parent' });
    const book = em.create(BookEntity, { title: 'Cascade Book', author });
    author.books.add(book);
    em.persist(author); // 부모만 persist
    await em.flush();

    const verify = orm.em.fork();
    const found = await verify.findOne(BookEntity, { title: 'Cascade Book' });
    expect(found).not.toBeNull();
  });

  it('7-3: 부모 조회 → 자식 컬렉션에서 제거 (orphanRemoval 동작 확인)', async () => {
    // seed
    const seed = orm.em.fork();
    const author = seed.create(AuthorEntity, { name: 'Orphan Parent' });
    const book = seed.create(BookEntity, { title: 'Orphan Book', author });
    author.books.add(book);
    seed.persist(author);
    await seed.flush();
    const bookId = book.id;

    // test
    const em = orm.em.fork();
    const parent = await em.findOneOrFail(AuthorEntity, { name: 'Orphan Parent' }, { populate: ['books'] });
    parent.books.removeAll();
    await em.flush();

    const verify = orm.em.fork();
    const removedBook = await verify.findOne(BookEntity, bookId);
    console.log('7-3: orphanRemoval result, book still exists =', removedBook !== null);
  });

  it('7-5: 자식만 persist (부모 이미 managed) → 자식 INSERT', async () => {
    // seed parent
    const seed = orm.em.fork();
    const author = seed.create(AuthorEntity, { name: 'Existing Parent' });
    seed.persist(author);
    await seed.flush();
    const authorId = author.id;

    // test
    const em = orm.em.fork();
    const parent = await em.findOneOrFail(AuthorEntity, authorId);
    const book = em.create(BookEntity, { title: 'New Child', author: parent });
    em.persist(book);
    await em.flush();

    const verify = orm.em.fork();
    const found = await verify.findOne(BookEntity, { title: 'New Child' }, { populate: ['author'] });
    expect(found).not.toBeNull();
    expect(found!.author.id).toBe(authorId);
  });

  it('7-6: 부모 remove + cascade REMOVE → 자식도 삭제', async () => {
    // seed
    const seed = orm.em.fork();
    const author = seed.create(AuthorEntity, { name: 'Remove Parent' });
    const book = seed.create(BookEntity, { title: 'Remove Book', author });
    author.books.add(book);
    seed.persist(author);
    await seed.flush();

    // test
    const em = orm.em.fork();
    const parent = await em.findOneOrFail(AuthorEntity, { name: 'Remove Parent' }, { populate: ['books'] });
    em.remove(parent);
    await em.flush();

    const verify = orm.em.fork();
    const removedParent = await verify.findOne(AuthorEntity, { name: 'Remove Parent' });
    const removedBook = await verify.findOne(BookEntity, { title: 'Remove Book' });
    console.log('7-6: parent exists =', removedParent !== null, ', book exists =', removedBook !== null);
  });

  it('7-7: insertMany로 자식 벌크 삽입 → Identity Map에 안 올라감', async () => {
    // seed parent
    const seed = orm.em.fork();
    const author = seed.create(AuthorEntity, { name: 'Bulk Parent' });
    seed.persist(author);
    await seed.flush();
    const authorId = author.id;

    // test
    const em = orm.em.fork();
    const bookRepo = em.getRepository(BookEntity) as BookRepository;
    await bookRepo.insertMany([
      { title: 'Bulk 1', author: authorId },
      { title: 'Bulk 2', author: authorId },
      { title: 'Bulk 3', author: authorId },
    ]);

    // Identity Map에 없는지 확인
    const identityMap = em.getUnitOfWork().getIdentityMap();
    const booksInMap = identityMap.values().filter(
      (e) => e instanceof BookEntity,
    );
    expect(booksInMap.length).toBe(0);

    // DB에는 있는지 확인
    const verify = orm.em.fork();
    const books = await verify.find(BookEntity, { author: authorId });
    expect(books.length).toBe(3);
  });

  // --- Lazy Loading 동작 ---

  it('7-8: populate 없이 Collection 접근 → 에러 (Spring과 다름: 자동 로딩 안 됨)', async () => {
    // seed
    const seed = orm.em.fork();
    const author = seed.create(AuthorEntity, { name: 'Lazy Author' });
    seed.create(BookEntity, { title: 'Lazy Book', author });
    author.books.add(author.books.getItems()[0] || seed.create(BookEntity, { title: 'Lazy Book 2', author }));
    seed.persist(author);
    await seed.flush();

    // populate 없이 조회
    const em = orm.em.fork();
    const found = await em.findOneOrFail(AuthorEntity, { name: 'Lazy Author' });

    // Spring이라면 found.books 접근 시 자동으로 SELECT 실행 (Hibernate 프록시)
    // MikroORM은 초기화 안 된 Collection 접근 시 에러
    expect(found.books.isInitialized()).toBe(false);
    expect(() => found.books.getItems()).toThrow(/not initialized/);
  });

  it('7-9: Collection.init() → 명시적 Lazy Loading', async () => {
    // seed
    const seed = orm.em.fork();
    const author = seed.create(AuthorEntity, { name: 'Init Author' });
    const b1 = seed.create(BookEntity, { title: 'Init Book 1', author });
    const b2 = seed.create(BookEntity, { title: 'Init Book 2', author });
    author.books.add(b1, b2);
    seed.persist(author);
    await seed.flush();

    // populate 없이 조회 후 init()
    const em = orm.em.fork();
    const found = await em.findOneOrFail(AuthorEntity, { name: 'Init Author' });

    expect(found.books.isInitialized()).toBe(false);

    // init() → 이 시점에 SELECT 실행
    await found.books.init();

    expect(found.books.isInitialized()).toBe(true);
    expect(found.books.count()).toBe(2);
    expect(found.books.getItems().map((b) => b.title).sort()).toEqual([
      'Init Book 1',
      'Init Book 2',
    ]);
  });

  it('7-10: populate으로 Eager Loading → 즉시 사용 가능', async () => {
    // seed
    const seed = orm.em.fork();
    const author = seed.create(AuthorEntity, { name: 'Eager Author' });
    seed.create(BookEntity, { title: 'Eager Book', author });
    author.books.add(author.books.getItems()[0] || seed.create(BookEntity, { title: 'Eager Book', author }));
    seed.persist(author);
    await seed.flush();

    // populate으로 조회
    const em = orm.em.fork();
    const found = await em.findOneOrFail(
      AuthorEntity,
      { name: 'Eager Author' },
      { populate: ['books'] },
    );

    // 이미 로드됨 — init() 불필요
    expect(found.books.isInitialized()).toBe(true);
    expect(found.books.count()).toBeGreaterThanOrEqual(1);
    expect(() => found.books.getItems()).not.toThrow();
  });

  it('7-11: ManyToOne은 Reference로 로드 — PK만 접근 가능, 나머지는 load 필요', async () => {
    // seed
    const seed = orm.em.fork();
    const author = seed.create(AuthorEntity, { name: 'Ref Author' });
    const book = seed.create(BookEntity, { title: 'Ref Book', author });
    seed.persist(author);
    await seed.flush();
    const authorId = author.id;

    // book만 조회 (author populate 없이)
    const em = orm.em.fork();
    const found = await em.findOneOrFail(BookEntity, { title: 'Ref Book' });

    // ManyToOne은 Reference — PK는 접근 가능
    expect(found.author.id).toBe(authorId);

    // 하지만 다른 프로퍼티는 로드 안 됨
    // Spring Hibernate라면 found.author.name 접근 시 자동 SELECT
    // MikroORM은 명시적 load 필요
    expect(found.author.name).toBeUndefined();
  });
});
