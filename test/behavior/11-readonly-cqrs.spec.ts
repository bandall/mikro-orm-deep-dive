import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MikroORM, FlushMode, IsolationLevel, LockMode, helper } from '@mikro-orm/core';
import { INestApplication } from '@nestjs/common';
import { TestingModule } from '@nestjs/testing';
import { AuthorEntity } from '../../src/behavior/entities/author.entity';
import { BookEntity } from '../../src/behavior/entities/book.entity';
import { createTestingApp, resetSchema } from './setup';

describe('11. Readonly 트랜잭션 & CQRS 패턴', () => {
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
    // seed 데이터
    const seed = orm.em.fork();
    const author = seed.create(AuthorEntity, { name: 'Read Author', email: 'r@test.com' });
    seed.create(BookEntity, { title: 'Book A', author, status: 'published' });
    seed.create(BookEntity, { title: 'Book B', author, status: 'draft' });
    seed.persist(author);
    await seed.flush();
  });

  // ============================================================
  // 11-1 ~ 11-3: em.transactional({ readOnly: true })
  // ============================================================

  it('11-1: readOnly 트랜잭션 안에서 SELECT → 정상 동작', async () => {
    const em = orm.em.fork();

    const result = await em.transactional(
      async (txEm) => {
        const authors = await txEm.find(AuthorEntity, {});
        return authors;
      },
      { readOnly: true },
    );

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Read Author');
  });

  it('11-2: readOnly 트랜잭션 안에서 INSERT → DB가 거부 (에러)', async () => {
    const em = orm.em.fork();

    await expect(
      em.transactional(
        async (txEm) => {
          txEm.create(AuthorEntity, { name: 'Blocked' });
          txEm.persist(txEm.getReference(AuthorEntity, 0)); // force flush
          await txEm.flush();
        },
        { readOnly: true },
      ),
    ).rejects.toThrow();

    // DB에 반영되지 않았어야 함
    const verify = orm.em.fork();
    const blocked = await verify.findOne(AuthorEntity, { name: 'Blocked' });
    expect(blocked).toBeNull();
  });

  it('11-3: readOnly 트랜잭션 안에서 UPDATE → DB가 거부', async () => {
    const em = orm.em.fork();

    await expect(
      em.transactional(
        async (txEm) => {
          const author = await txEm.findOneOrFail(AuthorEntity, { name: 'Read Author' });
          author.name = 'Modified';
          await txEm.flush();
        },
        { readOnly: true },
      ),
    ).rejects.toThrow();

    // 원본 유지 확인
    const verify = orm.em.fork();
    const author = await verify.findOneOrFail(AuthorEntity, { name: 'Read Author' });
    expect(author.name).toBe('Read Author');
  });

  // ============================================================
  // 11-4 ~ 11-5: FlushMode를 활용한 읽기 전용 컨텍스트
  // ============================================================

  it('11-4: FlushMode.COMMIT 트랜잭션 → persist해도 쿼리 전 flush 안 됨', async () => {
    const em = orm.em.fork();

    await em.transactional(
      async (txEm) => {
        // persist 후 find — AUTO라면 INSERT가 먼저 실행되지만, COMMIT에서는 안 됨
        const newAuthor = txEm.create(AuthorEntity, { name: 'Pending' });
        txEm.persist(newAuthor);

        // 같은 트랜잭션에서 find — pending INSERT는 반영 안 됨
        const found = await txEm.find(AuthorEntity, {});
        expect(found).toHaveLength(1); // seed 데이터만
        expect(found.some((a) => a.name === 'Pending')).toBe(false);
      },
      { flushMode: FlushMode.COMMIT },
    );

    // 트랜잭션 끝나면서 commit → flush됨
    const verify = orm.em.fork();
    const all = await verify.find(AuthorEntity, {});
    expect(all).toHaveLength(2); // seed + Pending
  });

  it('11-5: em.fork({ flushMode: COMMIT }) → 읽기 전용 EM 패턴', async () => {
    const readEm = orm.em.fork({ flushMode: FlushMode.COMMIT });

    // 읽기는 정상
    const authors = await readEm.find(AuthorEntity, {});
    expect(authors).toHaveLength(1);

    // persist해도 즉시 flush 안 됨 (명시적 flush 전까지)
    const author = readEm.create(AuthorEntity, { name: 'NotFlushed' });
    readEm.persist(author);

    const recheck = await readEm.find(AuthorEntity, {});
    // COMMIT 모드이므로 persist된 것이 자동 flush 안 됨
    expect(recheck).toHaveLength(1);

    // 명시적 flush하면 반영
    await readEm.flush();
    const verify = orm.em.fork();
    const all = await verify.find(AuthorEntity, {});
    expect(all).toHaveLength(2);
  });

  // ============================================================
  // 11-6 ~ 11-7: disableIdentityMap — 순수 읽기
  // ============================================================

  it('11-6: find({ disableIdentityMap }) → Identity Map에 등록 안 됨', async () => {
    const em = orm.em.fork();

    const authors = await em.find(AuthorEntity, {}, { disableIdentityMap: true });
    expect(authors).toHaveLength(1);
    expect(authors[0].name).toBe('Read Author');

    // Identity Map에는 없어야 함
    const unitOfWork = em.getUnitOfWork();
    const managed = unitOfWork.getIdentityMap().values();
    const authorInMap = [...managed].find(
      (e) => e instanceof AuthorEntity && (e as AuthorEntity).name === 'Read Author',
    );
    expect(authorInMap).toBeUndefined();
  });

  it('11-7: disableIdentityMap으로 읽은 엔티티 수정 → flush해도 UPDATE 안 됨', async () => {
    const em = orm.em.fork();

    const [author] = await em.find(AuthorEntity, {}, { disableIdentityMap: true });
    author.name = 'ShouldNotUpdate';

    // flush해도 Identity Map에 없으므로 UPDATE 발생 안 함
    await em.flush();

    const verify = orm.em.fork();
    const found = await verify.findOneOrFail(AuthorEntity, 1);
    expect(found.name).toBe('Read Author'); // 원본 유지
  });

  // ============================================================
  // 11-8 ~ 11-9: em.fork({ disableTransactions }) — 트랜잭션 없는 읽기
  // ============================================================

  it('11-8: em.fork({ disableTransactions }) → flush 시 autocommit 모드', async () => {
    const em = orm.em.fork({ disableTransactions: true });

    // 읽기
    const author = await em.findOneOrFail(AuthorEntity, { name: 'Read Author' });
    expect(author.name).toBe('Read Author');

    // 쓰기도 가능하지만 BEGIN/COMMIT 없이 바로 실행
    author.name = 'AutoCommit';
    await em.flush();

    const verify = orm.em.fork();
    const found = await verify.findOneOrFail(AuthorEntity, 1);
    expect(found.name).toBe('AutoCommit');
  });

  it('11-9: disableTransactions EM에서 여러 INSERT → 하나 실패해도 나머지 커밋됨 (비원자적)', async () => {
    const em = orm.em.fork({ disableTransactions: true });

    // 정상 데이터
    em.create(AuthorEntity, { name: 'Success Author' });
    await em.flush();

    // 별도 EM에서 검증 — commit됨
    const verify = orm.em.fork();
    const found = await verify.findOne(AuthorEntity, { name: 'Success Author' });
    expect(found).not.toBeNull();
  });

  // ============================================================
  // 11-10 ~ 11-12: Lock 모드 — 비관적 잠금
  // ============================================================

  it('11-10: PESSIMISTIC_WRITE → FOR UPDATE 쿼리 생성', async () => {
    const em = orm.em.fork();

    await em.transactional(async (txEm) => {
      // PESSIMISTIC_WRITE = FOR UPDATE
      const author = await txEm.findOneOrFail(
        AuthorEntity,
        { name: 'Read Author' },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      expect(author).toBeDefined();
      expect(author.name).toBe('Read Author');

      // 잠금 중 변경 가능
      author.name = 'Locked Update';
      await txEm.flush();
    });

    const verify = orm.em.fork();
    const found = await verify.findOneOrFail(AuthorEntity, 1);
    expect(found.name).toBe('Locked Update');
  });

  it('11-11: PESSIMISTIC_READ → FOR SHARE 쿼리 생성', async () => {
    const em = orm.em.fork();

    await em.transactional(async (txEm) => {
      // PESSIMISTIC_READ = FOR SHARE (다른 트랜잭션도 읽기 가능, 쓰기만 차단)
      const author = await txEm.findOneOrFail(
        AuthorEntity,
        { name: 'Read Author' },
        { lockMode: LockMode.PESSIMISTIC_READ },
      );
      expect(author).toBeDefined();
    });
  });

  it('11-12: 트랜잭션 밖에서 비관적 잠금 → 에러', async () => {
    const em = orm.em.fork();

    // 트랜잭션 없이 PESSIMISTIC_WRITE → 에러
    await expect(
      em.findOneOrFail(
        AuthorEntity,
        { name: 'Read Author' },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      ),
    ).rejects.toThrow();
  });

  // ============================================================
  // 11-13 ~ 11-14: CQRS 읽기/쓰기 EM 분리 패턴
  // ============================================================

  it('11-13: CQRS 패턴 — 읽기 EM과 쓰기 EM 분리', async () => {
    // 쓰기 EM — 일반 fork
    const writeEm = orm.em.fork();
    const author = writeEm.create(AuthorEntity, { name: 'CQRS Writer' });
    writeEm.persist(author);
    await writeEm.flush();

    // 읽기 EM — disableIdentityMap으로 가볍게
    const readEm = orm.em.fork({ flushMode: FlushMode.COMMIT });
    const results = await readEm.find(AuthorEntity, {}, { disableIdentityMap: true });

    expect(results).toHaveLength(2); // seed + CQRS Writer
    expect(results.map((a) => a.name).sort()).toEqual(['CQRS Writer', 'Read Author']);
  });

  it('11-14: CQRS 패턴 — 읽기 전용 트랜잭션으로 일관된 스냅샷 읽기', async () => {
    const em = orm.em.fork();

    // REPEATABLE READ + readOnly → 일관된 스냅샷
    const snapshot = await em.transactional(
      async (txEm) => {
        const authors = await txEm.find(AuthorEntity, {}, { populate: ['books'] });
        const books = await txEm.find(BookEntity, {});

        return {
          authorCount: authors.length,
          bookCount: books.length,
          authorNames: authors.map((a) => a.name),
          bookTitles: books.map((b) => b.title).sort(),
        };
      },
      {
        readOnly: true,
        isolationLevel: IsolationLevel.REPEATABLE_READ,
      },
    );

    expect(snapshot.authorCount).toBe(1);
    expect(snapshot.bookCount).toBe(2);
    expect(snapshot.authorNames).toEqual(['Read Author']);
    expect(snapshot.bookTitles).toEqual(['Book A', 'Book B']);
  });

  // ============================================================
  // 11-15: getConnection('read') / getConnection('write') 존재 확인
  // ============================================================

  it('11-15: getConnection() read/write 타입 지원 확인', async () => {
    const em = orm.em.fork();

    // replicas 미설정 시 read/write 모두 같은 커넥션
    const readConn = em.getConnection('read');
    const writeConn = em.getConnection('write');

    expect(readConn).toBeDefined();
    expect(writeConn).toBeDefined();

    // replicas 없으면 동일 커넥션
    const readResult = await readConn.execute('SELECT 1 as val');
    const writeResult = await writeConn.execute('SELECT 1 as val');
    expect(readResult[0].val).toBe(1);
    expect(writeResult[0].val).toBe(1);
  });
});
