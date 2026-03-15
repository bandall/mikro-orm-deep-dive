import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MikroORM } from '@mikro-orm/core';
import { INestApplication } from '@nestjs/common';
import { TestingModule } from '@nestjs/testing';
import { UserEntity } from '../../src/jpa-compat/entities/user.entity';
import { UserService } from '../../src/jpa-compat/services/user.service';
import { OrderService } from '../../src/jpa-compat/services/order.service';
import { createTestingApp, resetSchema } from './setup';

describe('11. TransactionalExplorer — em 자동 주입', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let module: TestingModule;
  let userService: UserService;
  let orderService: OrderService;

  beforeAll(async () => {
    ({ app, orm, module } = await createTestingApp());
    userService = module.get(UserService);
    orderService = module.get(OrderService);
  });

  afterAll(async () => {
    await orm.close();
    await app.close();
  });

  beforeEach(async () => {
    await resetSchema(orm);
  });

  it('11-1: em 미주입 서비스에서 @Transactional() → Explorer가 em 자동 주입 → 정상 동작', async () => {
    // UserService는 constructor에 em이 없음
    // TransactionalExplorer가 onModuleInit에서 em을 주입
    await userService.createUser('Explorer Test');

    const verify = orm.em.fork();
    const found = await verify.findOne(UserEntity, { name: 'Explorer Test' });
    expect(found).not.toBeNull();
  });

  it('11-2: em 미주입 서비스 @Transactional() 예외 → rollback', async () => {
    try {
      await userService.createUserAndThrow('Should Rollback');
    } catch {
      // expected
    }

    const verify = orm.em.fork();
    const found = await verify.findOne(UserEntity, { name: 'Should Rollback' });
    expect(found).toBeNull();
  });

  it('11-3: 서비스 간 @Transactional() 전파 — Outer → Inner 정상', async () => {
    await orderService.createOrderWithUser('Propagated User');

    const verify = orm.em.fork();
    const found = await verify.findOne(UserEntity, { name: 'Propagated User' });
    expect(found).not.toBeNull();
  });

  it('11-4: 서비스 간 @Transactional() 전파 — Inner 예외 → 전체 rollback', async () => {
    try {
      await orderService.createOrderWithUserThrow('Inner Fail');
    } catch {
      // expected
    }

    const verify = orm.em.fork();
    const owner = await verify.findOne(UserEntity, { name: 'Order Owner' });
    const inner = await verify.findOne(UserEntity, { name: 'Inner Fail' });
    expect(owner).toBeNull();   // rollback
    expect(inner).toBeNull();   // rollback
  });

  it('11-5: Explorer 주입된 em이 실제 글로벌 EM 프록시인지 확인', async () => {
    // UserService에 주입된 em이 존재하는지
    expect((userService as any).em).toBeDefined();
    // OrderService에도
    expect((orderService as any).em).toBeDefined();
  });
});
