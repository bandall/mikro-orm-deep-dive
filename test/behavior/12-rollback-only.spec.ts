import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MikroORM } from '@mikro-orm/core';
import { INestApplication } from '@nestjs/common';
import { TestingModule } from '@nestjs/testing';
import { AuthorEntity } from '../../src/behavior/entities/author.entity';
import { OuterService } from '../../src/behavior/services/outer.service';
import { createTestingApp, resetSchema } from './setup';

describe('12. Rollback-only 동작 — Spring과의 차이', () => {
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

  // ============================================================
  // 기본 전제: Inner 예외가 전파되면 전체 rollback (Spring과 동일)
  // ============================================================

  it('12-1: Inner 예외 전파 → 전체 rollback (Spring과 동일)', async () => {
    await expect(
      outerService.createWithInnerThrow('Outer', 'InnerFail'),
    ).rejects.toThrow('Inner error');

    const verify = orm.em.fork();
    const outer = await verify.findOne(AuthorEntity, { name: 'Outer' });
    const inner = await verify.findOne(AuthorEntity, { name: 'InnerFail' });
    expect(outer).toBeNull();   // rollback
    expect(inner).toBeNull();   // rollback
  });

  // ============================================================
  // 핵심: Inner 예외를 catch로 삼키면?
  // ============================================================

  it('12-2: Inner 예외를 catch로 삼킴 → MikroORM은 commit 성공 (Spring은 UnexpectedRollbackException)', async () => {
    // Spring @Transactional(REQUIRED)이라면:
    //   inner에서 RuntimeException → TX에 rollback-only 마킹
    //   outer에서 catch해도 commit 시 UnexpectedRollbackException
    //   → outer 데이터도 rollback
    //
    // MikroORM @Transactional()은:
    //   rollback-only 마킹 개념 없음
    //   catch로 예외를 삼키면 outer는 정상 종료 → commit 성공

    await outerService.createWithInnerCatch('OuterSurvived', 'InnerFailed');

    const verify = orm.em.fork();
    const outer = await verify.findOne(AuthorEntity, { name: 'OuterSurvived' });
    expect(outer).not.toBeNull(); // ✅ MikroORM: outer는 commit됨

    // inner가 flush한 데이터도 같은 TX이므로 — 결과 확인
    const inner = await verify.findOne(AuthorEntity, { name: 'InnerFailed' });
    // inner는 flush 후 throw했지만, outer에서 catch → TX는 rollback 안 됨
    // 따라서 inner의 flush 데이터도 commit됨
    expect(inner).not.toBeNull(); // ✅ inner flush 데이터도 살아있음!
  });

  it('12-3: Inner 예외 catch 후 recovery 데이터 추가 → 전부 commit', async () => {
    await outerService.createWithInnerCatchAndContinue(
      'Outer',
      'InnerFailed',
      'Recovery',
    );

    const verify = orm.em.fork();
    const outer = await verify.findOne(AuthorEntity, { name: 'Outer' });
    const inner = await verify.findOne(AuthorEntity, { name: 'InnerFailed' });
    const recovery = await verify.findOne(AuthorEntity, { name: 'Recovery' });

    expect(outer).not.toBeNull();    // outer → commit
    expect(inner).not.toBeNull();    // inner flush 데이터 → commit (같은 TX)
    expect(recovery).not.toBeNull(); // recovery → commit
  });

  // ============================================================
  // Outer에서 예외 발생 (Inner 성공 후)
  // ============================================================

  it('12-4: Inner 성공 후 Outer throw → 전파 → 전체 rollback (Inner 데이터도 사라짐)', async () => {
    await expect(
      outerService.createWithInnerSuccessThenOuterThrow('OuterFail', 'InnerOK'),
    ).rejects.toThrow('Outer error after inner success');

    const verify = orm.em.fork();
    const outer = await verify.findOne(AuthorEntity, { name: 'OuterFail' });
    const inner = await verify.findOne(AuthorEntity, { name: 'InnerOK' });
    expect(outer).toBeNull();   // rollback
    expect(inner).toBeNull();   // Inner 성공했지만, 같은 TX이므로 rollback
  });

  it('12-5: Inner 성공 후 Outer 내부에서 자체 catch → commit 성공 (전부 저장)', async () => {
    await outerService.createWithInnerSuccessThenOuterCatch('OuterOK', 'InnerOK');

    const verify = orm.em.fork();
    const outer = await verify.findOne(AuthorEntity, { name: 'OuterOK' });
    const inner = await verify.findOne(AuthorEntity, { name: 'InnerOK' });
    expect(outer).not.toBeNull();   // commit
    expect(inner).not.toBeNull();   // commit
  });

  // ============================================================
  // 비교: em.transactional()에서도 동일한 동작인지 확인
  // ============================================================

  it('12-6: em.transactional 안에서 예외 catch → commit 성공', async () => {
    const em = orm.em.fork();

    await em.transactional(async (txEm) => {
      txEm.create(AuthorEntity, { name: 'TxOuter' });

      try {
        txEm.create(AuthorEntity, { name: 'TxInner' });
        await txEm.flush();
        throw new Error('Inner error');
      } catch {
        // 삼킴
      }

      txEm.create(AuthorEntity, { name: 'TxRecovery' });
    });

    const verify = orm.em.fork();
    const all = await verify.find(AuthorEntity, {}, { orderBy: { name: 'asc' } });
    const names = all.map((a) => a.name);
    expect(names).toContain('TxOuter');
    expect(names).toContain('TxInner');
    expect(names).toContain('TxRecovery');
  });

  // ============================================================
  // 대조군: 예외를 catch 안 하면 전체 rollback
  // ============================================================

  it('12-7: em.transactional 안에서 예외 미처리 → 전체 rollback', async () => {
    const em = orm.em.fork();

    await expect(
      em.transactional(async (txEm) => {
        txEm.create(AuthorEntity, { name: 'WillRollback' });
        await txEm.flush();
        throw new Error('Boom');
      }),
    ).rejects.toThrow('Boom');

    const verify = orm.em.fork();
    const found = await verify.findOne(AuthorEntity, { name: 'WillRollback' });
    expect(found).toBeNull(); // rollback
  });
});
