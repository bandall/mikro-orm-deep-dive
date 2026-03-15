import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MikroORM, RequestContext } from '@mikro-orm/core';
import { INestApplication } from '@nestjs/common';
import { TestingModule } from '@nestjs/testing';
import { AuthorEntity } from '../../src/behavior/entities/author.entity';
import { createTestingApp, resetSchema } from './setup';

describe('8. @CreateRequestContext() vs @Transactional()', () => {
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

  it('8-1: RequestContext 안에서 persist + flush → 정상 동작', async () => {
    await RequestContext.create(orm.em, async () => {
      const author = orm.em.create(AuthorEntity, { name: 'RC Author' });
      orm.em.persist(author);
      await orm.em.flush();
    });

    const verify = orm.em.fork();
    const found = await verify.findOne(AuthorEntity, { name: 'RC Author' });
    expect(found).not.toBeNull();
  });

  it('8-2: RequestContext 안에서 persist (flush 없음) → DB 반영 안 됨', async () => {
    await RequestContext.create(orm.em, async () => {
      const author = orm.em.create(AuthorEntity, { name: 'NoFlush RC' });
      orm.em.persist(author);
      // flush 없음
    });

    const verify = orm.em.fork();
    const found = await verify.findOne(AuthorEntity, { name: 'NoFlush RC' });
    expect(found).toBeNull();
  });

  it('8-3: 데코레이터 없이 글로벌 EM 사용 → allowGlobalContext=false이면 에러', async () => {
    // RequestContext 없이 글로벌 EM 직접 사용 → 에러
    expect(() => orm.em.create(AuthorEntity, { name: 'Global EM' })).toThrow(
      /global EntityManager/,
    );
  });

  it('8-4: RequestContext 안에서 em.transactional → 정상 동작', async () => {
    await RequestContext.create(orm.em, async () => {
      await orm.em.transactional(async (txEm) => {
        const author = txEm.create(AuthorEntity, { name: 'RC + Tx' });
        txEm.persist(author);
      });
    });

    const verify = orm.em.fork();
    const found = await verify.findOne(AuthorEntity, { name: 'RC + Tx' });
    expect(found).not.toBeNull();
  });
});
