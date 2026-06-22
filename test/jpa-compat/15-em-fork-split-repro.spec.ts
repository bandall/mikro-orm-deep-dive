import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { MikroOrmModule, type MikroOrmModuleAsyncOptions } from '@mikro-orm/nestjs';
import { EntityManager as CoreEntityManager, MikroORM } from '@mikro-orm/core';
import { EntityManager as MysqlEntityManager, MySqlDriver } from '@mikro-orm/mysql';
import { TransactionalExplorer } from '../../src/jpa-compat/transactional.explorer';
import { LedgerEntity } from '../../src/jpa-compat/repro/ledger.entity';
import { LedgerService } from '../../src/jpa-compat/repro/ledger.service';
import { LedgerConsumer } from '../../src/jpa-compat/repro/ledger.consumer';

/**
 * EM fork split → commons save() upsert → (PG) GENERATED ALWAYS IDENTITY 에러 재현.
 *
 * 재현 토폴로지 (roamings 런타임과 동일):
 *   SQS 컨슈머 @EnsureRequestContext   → RequestContext(EM_req fork)
 *     └ recordPending  @Transactional  → sub-fork P, INSERT, 커밋 시 entity.__em = EM_req
 *     └ (ME HTTP)
 *     └ markResult     @Transactional  → sub-fork M (clear:false → EM_req map 상속)
 *           find(signature) = SELECT (non-PK) → 캐시 dedup → __em=EM_req 인스턴스 반환
 *           save() → ctxEm=M, __em=EM_req ≠ M → Case3 upsert
 *
 * allowGlobalContext:false + registerRequestContext:true (commons 런타임과 동일).
 */

// SQL 로그 수집기 — 어떤 쿼리가 나가는지 단언에 사용
const queryLog: string[] = [];

@Global()
@Module({
  imports: [
    DiscoveryModule,
    MikroOrmModule.forRootAsync({
      driver: MySqlDriver,
      useFactory: () => ({
        host: 'localhost',
        port: 3307,
        user: 'root',
        password: 'test',
        dbName: 'mikro_orm_test',
        driver: MySqlDriver,
        debug: ['query', 'query-params'],
        logger: (msg: string) => {
          queryLog.push(msg);
          console.log(msg);
        },
        entities: [LedgerEntity],
        discovery: { warnWhenNoEntities: false },
        registerRequestContext: true,
        allowGlobalContext: false,
      }),
    } as unknown as MikroOrmModuleAsyncOptions),
    MikroOrmModule.forFeature([LedgerEntity]),
  ],
  providers: [
    { provide: MysqlEntityManager, useExisting: CoreEntityManager },
    TransactionalExplorer,
    LedgerService,
    LedgerConsumer,
  ],
  exports: [MysqlEntityManager],
})
class ReproModule {}

/** queryLog 에서 최근 항목 중 패턴 매칭이 있었는지 — 구간 단위로 검사 */
function sliceQueries(from: number): string[] {
  return queryLog.slice(from).map((q) => q.toLowerCase());
}

describe('15. EM fork split → commons save() upsert 재현 (실제 MySQL)', () => {
  let app: any;
  let orm: MikroORM;
  let module: TestingModule;
  let consumer: LedgerConsumer;

  beforeAll(async () => {
    module = await Test.createTestingModule({ imports: [ReproModule] }).compile();
    app = module.createNestApplication();
    await app.init();
    orm = module.get(MikroORM);
    consumer = module.get(LedgerConsumer);

    const conn = orm.em.getConnection();
    await conn.execute('DROP TABLE IF EXISTS `repro_ledger`');
    await (orm as any).schema.create({ wrap: false });
  });

  afterAll(async () => {
    await orm.close();
    await app.close();
  });

  beforeEach(async () => {
    const conn = orm.em.getConnection();
    await conn.execute('TRUNCATE TABLE `repro_ledger`');
  });

  it('15-1: [버그] save-no-clear — markResult.find 는 SELECT 가 나가지만(non-PK), 반환 인스턴스 __em=EM_req → save 가 Case3 upsert(INSERT..ON DUPLICATE) 로 빠진다', async () => {
    const sig = 'SIG-NOCLEAR';
    const mark = queryLog.length;

    await consumer.handleMessage(sig, 'save-no-clear');

    const markQueries = sliceQueries(mark);
    // recordPending INSERT 이후 markResult 구간만 보기 위해, INSERT 다음의 select/upsert 확인
    const hasSelect = markQueries.some((q) => q.includes('select') && q.includes('repro_ledger') && q.includes('signature'));
    const hasUpsert = markQueries.some((q) => q.includes('on duplicate key update'));

    console.log(`\n[검증 15-1] markResult find SELECT 발생=${hasSelect}, save 가 upsert(ON DUPLICATE) 발생=${hasUpsert}`);

    // 핵심 1: find 는 non-PK(signature) 쿼리라 캐시가 있어도 SELECT 가 나간다
    expect(hasSelect).toBe(true);
    // 핵심 2: 그럼에도 save 는 Case1(UPDATE)이 아니라 Case3(upsert)로 빠진다 = 버그 경로
    expect(hasUpsert).toBe(true);
  });

  it('15-2: [수정 A] clear-then-save — find 전 em.clear() → SELECT 결과가 fresh hydrate(__em=M) → save Case1(dirty UPDATE), upsert 안 나감', async () => {
    const sig = 'SIG-CLEAR';
    const mark = queryLog.length;

    await consumer.handleMessage(sig, 'clear-then-save');

    const markQueries = sliceQueries(mark);
    const hasSelect = markQueries.some((q) => q.includes('select') && q.includes('repro_ledger') && q.includes('signature'));
    const hasUpsert = markQueries.some((q) => q.includes('on duplicate key update'));
    const hasUpdate = markQueries.some((q) => q.startsWith('update `repro_ledger`') || q.includes('update `repro_ledger` set'));

    console.log(`\n[검증 15-2] SELECT=${hasSelect}, upsert=${hasUpsert}, plain UPDATE=${hasUpdate}`);

    expect(hasSelect).toBe(true);     // clear 여부와 무관하게 SELECT 는 나감
    expect(hasUpsert).toBe(false);    // upsert 로 빠지지 않음
    expect(hasUpdate).toBe(true);     // 깔끔한 UPDATE
  });

  it('15-3: [수정 B] dirty-flush — save() 호출 안 함 → 커밋 시 UnitOfWork change-set 이 UPDATE (upsert 없음)', async () => {
    const sig = 'SIG-DIRTY';
    const mark = queryLog.length;

    await consumer.handleMessage(sig, 'dirty-flush');

    const markQueries = sliceQueries(mark);
    const hasUpsert = markQueries.some((q) => q.includes('on duplicate key update'));
    const hasUpdate = markQueries.some((q) => q.includes('update `repro_ledger` set'));

    console.log(`\n[검증 15-3] upsert=${hasUpsert}, plain UPDATE=${hasUpdate}`);

    expect(hasUpsert).toBe(false);
    expect(hasUpdate).toBe(true);
  });

  it('15-4: 세 모드 모두 최종 DB 상태는 SENT (MySQL 은 explicit id INSERT 허용이라 upsert 도 통과 — PG 였다면 15-1 만 IDENTITY 에러)', async () => {
    for (const mode of ['save-no-clear', 'clear-then-save', 'dirty-flush'] as const) {
      await orm.em.getConnection().execute('TRUNCATE TABLE `repro_ledger`');
      await consumer.handleMessage(`SIG-${mode}`, mode);

      const verify = orm.em.fork();
      const row = await verify.findOneOrFail(LedgerEntity, { signature: `SIG-${mode}` });
      expect(row.status).toBe('SENT');
      expect(row.registeredAt).not.toBeNull();
    }
  });
});
