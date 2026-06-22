import 'reflect-metadata';
import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { NestFactory } from '@nestjs/core';
import { MikroOrmModule, type MikroOrmModuleAsyncOptions } from '@mikro-orm/nestjs';
import { EntityManager as CoreEntityManager, MikroORM } from '@mikro-orm/core';
import { EntityManager as MysqlEntityManager, MySqlDriver } from '@mikro-orm/mysql';
import { TransactionalExplorer } from '../transactional.explorer';
import { LedgerEntity } from './ledger.entity';
import { LedgerService, MarkMode } from './ledger.service';
import { LedgerConsumer } from './ledger.consumer';

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
        debug: ['query'],
        logger: (msg: string) => console.log('   [SQL]', msg.replace(/\x1b\[[0-9;]*m/g, '')),
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

async function runMode(consumer: LedgerConsumer, orm: MikroORM, mode: MarkMode) {
  console.log('\n\n############################################################');
  console.log(`#  MODE = ${mode}`);
  console.log('############################################################');
  await orm.em.getConnection().execute('TRUNCATE TABLE `repro_ledger`');
  try {
    await consumer.handleMessage(`SIG-${mode}`, mode);
    const verify = orm.em.fork();
    const row = await verify.findOne(LedgerEntity, { signature: `SIG-${mode}` });
    console.log(
      `\n>>> 최종 DB 상태: status=${row?.status}, registeredAt=${row?.registeredAt ? 'set' : 'null'}, ` +
        `updatedAt=${row?.updatedAt ? 'SET ✅' : 'null ❌(훅 우회)'}`,
    );
  } catch (e: any) {
    console.log(`\n>>> 예외 발생: ${e?.name}: ${e?.message}`);
  }
}

async function main() {
  const app = await NestFactory.create(ReproModule, { logger: false });
  await app.init();
  const orm = app.get(MikroORM);
  const consumer = app.get(LedgerConsumer);

  await orm.em.getConnection().execute('DROP TABLE IF EXISTS `repro_ledger`');
  await (orm as any).schema.create({ wrap: false });

  await runMode(consumer, orm, 'save-no-clear');
  await runMode(consumer, orm, 'clear-then-save');
  await runMode(consumer, orm, 'dirty-flush');
  await runMode(consumer, orm, 'native-update');

  await orm.close();
  await app.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
