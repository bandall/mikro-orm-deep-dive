import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { MikroORM, EntityManager as CoreEntityManager } from '@mikro-orm/core';
import { EntityManager as MysqlEntityManager, MySqlDriver } from '@mikro-orm/mysql';
import { MikroOrmModule, type MikroOrmModuleSyncOptions } from '@mikro-orm/nestjs';
import { TsMorphMetadataProvider } from '@mikro-orm/reflection';
import { TransactionalExplorer } from '../../src/jpa-compat/transactional.explorer';
import { LedgerEntity } from '../../src/jpa-compat/e2e-final/ledger.entity';
import { LedgerStepEntity } from '../../src/jpa-compat/e2e-final/ledger-step.entity';
import { LedgerController } from '../../src/jpa-compat/e2e-final/ledger.controller';
import { LedgerService } from '../../src/jpa-compat/e2e-final/ledger.service';
import { LedgerConsumer } from '../../src/jpa-compat/e2e-final/ledger.consumer';

/**
 * commons 최종본을 **실제 런타임 배선**으로 검증:
 *   - MikroOrmModule.forRoot(registerRequestContext: true) → HTTP 요청마다 RequestContext(EM_req) 미들웨어
 *   - TransactionalExplorer → @Transactional 서비스에 em 자동 주입 (프로덕션과 동일)
 *   - supertest 로 **진짜 HTTP 요청** 발사 → 컨트롤러 → @Transactional 서비스 → repo.save
 *   - @EnsureRequestContext 컨슈머 → **SQS 요청** 경로(HTTP 미들웨어 없이 요청 스코프 생성)
 *
 * "http/sqs 환경에서도 동작하나?" 를 수동 wiring 이 아니라 실 배선으로 답한다.
 * ⚠️ MySQL 샌드박스 — PG IDENTITY 실발현 아님. 라우팅(upsert vs dirty UPDATE)·onUpdate 훅·id 확보를 본다.
 */

let app: INestApplication;
let orm: MikroORM;
const sqlLog: string[] = [];
function since(mark: number): string[] {
  return sqlLog.slice(mark).map((q) => q.toLowerCase());
}
function has(qs: string[], needle: string): boolean {
  return qs.some((q) => q.includes(needle));
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      DiscoveryModule,
      MikroOrmModule.forRoot({
        driver: MySqlDriver,
        host: 'localhost',
        port: 3307,
        user: 'root',
        password: 'test',
        dbName: 'mikro_orm_test',
        entities: [LedgerEntity, LedgerStepEntity],
        metadataProvider: TsMorphMetadataProvider,
        discovery: { warnWhenNoEntities: false },
        registerRequestContext: true, // ← HTTP 요청별 RequestContext 미들웨어 (실 배선 핵심)
        allowGlobalContext: false,
        debug: ['query'],
        logger: (msg: string) => sqlLog.push(msg),
      } as unknown as MikroOrmModuleSyncOptions),
      MikroOrmModule.forFeature([LedgerEntity, LedgerStepEntity]),
    ],
    controllers: [LedgerController],
    providers: [
      { provide: MysqlEntityManager, useExisting: CoreEntityManager },
      TransactionalExplorer,
      LedgerService,
      LedgerConsumer,
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  await app.init();
  orm = moduleRef.get(MikroORM);

  const conn = orm.em.getConnection();
  await conn.execute('SET FOREIGN_KEY_CHECKS = 0');
  await conn.execute('DROP TABLE IF EXISTS `e2e_ledger_step`');
  await conn.execute('DROP TABLE IF EXISTS `e2e_ledger`');
  await conn.execute('SET FOREIGN_KEY_CHECKS = 1');
  await (orm as any).schema.create({ wrap: false });
});

afterAll(async () => {
  await orm.close();
  await app.close();
});

beforeEach(async () => {
  const conn = orm.em.getConnection();
  await conn.execute('SET FOREIGN_KEY_CHECKS = 0');
  await conn.execute('TRUNCATE TABLE `e2e_ledger_step`');
  await conn.execute('TRUNCATE TABLE `e2e_ledger`');
  await conn.execute('SET FOREIGN_KEY_CHECKS = 1');
  sqlLog.length = 0;
});

// ===========================================================================
describe('21. e2e — 실제 HTTP(RequestContext 미들웨어) + SQS(@EnsureRequestContext) × commons 최종본', () => {
  // ---- HTTP ----------------------------------------------------------------
  it('21-1 [HTTP POST] create(new) → 201 + 응답 body 에 id (Case2 flush = Spring parity, 미들웨어 경유)', async () => {
    const mark = sqlLog.length;
    const res = await request(app.getHttpServer())
      .post('/ledgers')
      .send({ signature: 'HTTP-CREATE' })
      .expect(201);

    expect(res.body.id).toBeGreaterThan(0); // flush 로 응답 직렬화 전에 id 확보
    const qs = since(mark);
    expect(has(qs, 'insert into `e2e_ledger`')).toBe(true);
    expect(has(qs, 'on duplicate key update')).toBe(false);
  });

  it('21-2 [HTTP POST] createWithStep — nested @Transactional + 스칼라 FK → read-back 성공 (준공 탭 치유)', async () => {
    const res = await request(app.getHttpServer())
      .post('/ledgers/with-step')
      .send({ signature: 'HTTP-STEP' })
      .expect(201);

    expect(res.body.ledgerId).toBeGreaterThan(0);
    expect(res.body.stepLinked).toBe(true); // 부모 id 즉시 확보 → 자식 스칼라 FK 유효

    const verify = orm.em.fork();
    const step = await verify.findOneOrFail(LedgerStepEntity, { label: 'step-1' });
    expect(step.ledgerId).toBe(res.body.ledgerId);
  });

  it('21-3 [HTTP PATCH] in-tx update(managed) → dirty UPDATE(upsert 아님) + onUpdate 훅', async () => {
    const created = await request(app.getHttpServer())
      .post('/ledgers')
      .send({ signature: 'HTTP-UPD-INTX' })
      .expect(201);
    const id = created.body.id;

    const mark = sqlLog.length;
    await request(app.getHttpServer()).patch(`/ledgers/${id}/in-tx`).send({ status: 'DONE' }).expect(200);
    const qs = since(mark);

    expect(has(qs, 'on duplicate key update')).toBe(false);
    expect(has(qs, 'update `e2e_ledger` set')).toBe(true);

    const got = await request(app.getHttpServer()).get(`/ledgers/${id}`).expect(200);
    expect(got.body.status).toBe('DONE');
    expect(got.body.updatedAt).not.toBeNull(); // dirty-flush 경로 → onUpdate 작동
  });

  it('21-4 [HTTP PATCH] outside-tx update (users fork-split 패턴, 실 HTTP) → FIXED 는 dirty UPDATE(upsert 아님)', async () => {
    const created = await request(app.getHttpServer())
      .post('/ledgers')
      .send({ signature: 'HTTP-UPD-OUT' })
      .expect(201);
    const id = created.body.id;

    const mark = sqlLog.length;
    await request(app.getHttpServer())
      .patch(`/ledgers/${id}/outside-tx`)
      .send({ status: 'DONE' })
      .expect(200);
    const qs = since(mark);

    // EM_req 로드 + @Transactional save(자체 tx fork) 인데도 멤버십으로 dirty UPDATE (OLD 였다면 upsert + 훅 우회)
    expect(has(qs, 'on duplicate key update')).toBe(false);
    expect(has(qs, 'update `e2e_ledger` set')).toBe(true);

    const got = await request(app.getHttpServer()).get(`/ledgers/${id}`).expect(200);
    expect(got.body.status).toBe('DONE');
    expect(got.body.updatedAt).not.toBeNull(); // 실 HTTP 에서도 onUpdate 작동
  });

  it('21-5 [HTTP POST] createThenThrow → 500 + 롤백 (조기 flush INSERT 도 커밋 안 됨)', async () => {
    await request(app.getHttpServer())
      .post('/ledgers/throw')
      .send({ signature: 'HTTP-RB' })
      .expect(500);

    const verify = orm.em.fork();
    expect(await verify.count(LedgerEntity, { signature: 'HTTP-RB' })).toBe(0);
  });

  // ---- SQS -----------------------------------------------------------------
  it('21-6 [SQS] @EnsureRequestContext 컨슈머(형제 @Transactional 2개) → dirty UPDATE + onUpdate (upsert 아님)', async () => {
    const consumer = app.get(LedgerConsumer);

    const mark = sqlLog.length;
    await consumer.handle('SQS-1'); // recordPending(insert) → markSent(load+update)
    const qs = since(mark);

    expect(has(qs, 'insert into `e2e_ledger`')).toBe(true); // recordPending
    expect(has(qs, 'update `e2e_ledger` set')).toBe(true); // markSent → dirty UPDATE
    expect(has(qs, 'on duplicate key update')).toBe(false); // fork-split 오판 없음

    const verify = orm.em.fork();
    const row = await verify.findOneOrFail(LedgerEntity, { signature: 'SQS-1' });
    expect(row.status).toBe('SENT');
    expect(row.updatedAt).not.toBeNull(); // SQS 경로에서도 onUpdate 작동
  });
});
