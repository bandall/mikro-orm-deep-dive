import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MikroORM } from '@mikro-orm/core';
import { INestApplication } from '@nestjs/common';
import { TestingModule } from '@nestjs/testing';
import { AuthorEntity } from '../../src/behavior/entities/author.entity';
import { OuterService } from '../../src/behavior/services/outer.service';
import { createTestingApp, resetSchema } from './setup';

describe('2. @Transactional() 데코레이터', () => {
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

  it('2-1: @Transactional 메서드에서 persist (flush 없음) → auto flush', async () => {
    await outerService.createWithAutoFlush('AutoFlush Author');

    const verify = orm.em.fork();
    const found = await verify.findOne(AuthorEntity, { name: 'AutoFlush Author' });
    expect(found).not.toBeNull();
  });

  it('2-2: @Transactional 메서드에서 예외 → rollback', async () => {
    await expect(outerService.createAndThrow('Rollback Author')).rejects.toThrow('Outer error');

    const verify = orm.em.fork();
    const found = await verify.findOne(AuthorEntity, { name: 'Rollback Author' });
    expect(found).toBeNull();
  });

  it('2-3: OuterService @Transactional → InnerService @Transactional → 바깥 끝에서 commit', async () => {
    await outerService.createWithInner('Outer', 'Inner');

    const verify = orm.em.fork();
    const outer = await verify.findOne(AuthorEntity, { name: 'Outer' });
    const inner = await verify.findOne(AuthorEntity, { name: 'Inner' });
    expect(outer).not.toBeNull();
    expect(inner).not.toBeNull();
  });

  it('2-4: OuterService @Transactional → InnerService @Transactional에서 예외 → 전체 rollback', async () => {
    await expect(
      outerService.createWithInnerThrow('OuterSafe', 'InnerFail'),
    ).rejects.toThrow('Inner error');

    const verify = orm.em.fork();
    const outer = await verify.findOne(AuthorEntity, { name: 'OuterSafe' });
    const inner = await verify.findOne(AuthorEntity, { name: 'InnerFail' });
    expect(outer).toBeNull();
    expect(inner).toBeNull();
  });

  it('2-5: @Transactional 없이 글로벌 EM에서 persist → allowGlobalContext=false이면 에러', async () => {
    await expect(
      outerService.createWithoutTransaction('NoTx Author'),
    ).rejects.toThrow(/global EntityManager/);
  });

  it('2-6: @Transactional 없이 글로벌 EM에서 수동 flush → allowGlobalContext=false이면 에러', async () => {
    await expect(
      outerService.createWithManualFlush('ManualFlush Author'),
    ).rejects.toThrow(/global EntityManager/);
  });
});
