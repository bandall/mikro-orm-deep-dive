import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/core';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../../src/behavior/app.module';

export async function createTestingApp() {
  const module: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = module.createNestApplication();
  await app.init();

  const orm = module.get(MikroORM);

  return { app, orm, module };
}

export async function resetSchema(orm: MikroORM) {
  const conn = orm.em.getConnection();
  await conn.execute('SET FOREIGN_KEY_CHECKS = 0');
  await conn.execute('TRUNCATE TABLE `books`');
  await conn.execute('TRUNCATE TABLE `authors`');
  await conn.execute('SET FOREIGN_KEY_CHECKS = 1');
}
