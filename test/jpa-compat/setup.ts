import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/core';
import { Test, TestingModule } from '@nestjs/testing';
import { JpaCompatModule } from '../../src/jpa-compat/app.module';

export async function createTestingApp() {
  const module: TestingModule = await Test.createTestingModule({
    imports: [JpaCompatModule],
  }).compile();

  const app = module.createNestApplication();
  await app.init();

  const orm = module.get(MikroORM);

  // 테이블 생성 (drop + create)
  const conn = orm.em.getConnection();
  await conn.execute('SET FOREIGN_KEY_CHECKS = 0');
  await conn.execute('DROP TABLE IF EXISTS `jpa_posts`');
  await conn.execute('DROP TABLE IF EXISTS `jpa_users`');
  await conn.execute('SET FOREIGN_KEY_CHECKS = 1');
  await (orm as any).schema.create({ wrap: false });

  return { app, orm, module };
}

export async function resetSchema(orm: MikroORM) {
  const conn = orm.em.getConnection();
  await conn.execute('SET FOREIGN_KEY_CHECKS = 0');
  await conn.execute('TRUNCATE TABLE `jpa_posts`');
  await conn.execute('TRUNCATE TABLE `jpa_users`');
  await conn.execute('SET FOREIGN_KEY_CHECKS = 1');
}
