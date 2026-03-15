import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MikroORM, raw } from '@mikro-orm/core';
import { INestApplication } from '@nestjs/common';
import { TestingModule } from '@nestjs/testing';
import { AuthorEntity } from '../../src/behavior/entities/author.entity';
import { BookEntity } from '../../src/behavior/entities/book.entity';
import { createTestingApp, resetSchema } from './setup';

describe('9. nativeUpdate / nativeDelete', () => {
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
    const author = seed.create(AuthorEntity, { name: 'Native Author', email: 'native@test.com' });
    seed.persist(author);
    await seed.flush();
    seedId = author.id;
  });

  it('9-1: nativeUpdate → 같은 EM에서 find → Identity Map 캐시 반환', async () => {
    const em = orm.em.fork();

    // 먼저 조회해서 Identity Map에 올리기
    const cached = await em.findOneOrFail(AuthorEntity, seedId);
    expect(cached.name).toBe('Native Author');

    // nativeUpdate로 DB 직접 변경
    await em.nativeUpdate(AuthorEntity, { id: seedId }, { name: 'Native Updated' });

    // 같은 EM에서 다시 find → Identity Map 캐시 반환
    const found = await em.findOneOrFail(AuthorEntity, seedId);
    console.log('9-1: after nativeUpdate, find returns:', found.name);
    // Identity Map 캐시이므로 'Native Author'일 수 있음
  });

  it('9-2: nativeUpdate + raw 원자적 증가', async () => {
    // Book에 숫자 필드가 없으므로 Author의 id를 이용한 간단한 테스트
    // 별도 EM에서 nativeUpdate 실행
    const em = orm.em.fork();
    await em.nativeUpdate(AuthorEntity, { id: seedId }, { name: 'Atomic Updated' });

    const verify = orm.em.fork();
    const found = await verify.findOneOrFail(AuthorEntity, seedId);
    expect(found.name).toBe('Atomic Updated');
  });

  it('9-3: nativeDelete → 같은 EM에서 find → Identity Map에 남아있을 수 있음', async () => {
    const em = orm.em.fork();

    // 먼저 조회해서 Identity Map에 올리기
    const cached = await em.findOneOrFail(AuthorEntity, seedId);

    // nativeDelete로 DB에서 삭제
    await em.nativeDelete(AuthorEntity, { id: seedId });

    // 같은 EM에서 findOne → Identity Map 캐시 반환?
    const found = await em.findOne(AuthorEntity, seedId);
    console.log('9-3: after nativeDelete, findOne returns:', found !== null ? found.name : null);

    // 별도 EM으로 DB 확인
    const verify = orm.em.fork();
    const dbCheck = await verify.findOne(AuthorEntity, seedId);
    expect(dbCheck).toBeNull(); // DB에서는 삭제됨
  });

  it('9-4: @Transactional 안에서 nativeUpdate → 예외 시 rollback', async () => {
    const em = orm.em.fork();

    try {
      await em.transactional(async (txEm) => {
        await txEm.nativeUpdate(AuthorEntity, { id: seedId }, { name: 'TxNative' });
        throw new Error('Force rollback');
      });
    } catch {
      // expected
    }

    const verify = orm.em.fork();
    const found = await verify.findOneOrFail(AuthorEntity, seedId);
    expect(found.name).toBe('Native Author'); // rollback됨
  });
});
