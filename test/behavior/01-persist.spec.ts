import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MikroORM } from '@mikro-orm/core';
import { INestApplication } from '@nestjs/common';
import { TestingModule } from '@nestjs/testing';
import { AuthorEntity } from '../../src/behavior/entities/author.entity';
import { createTestingApp, resetSchema } from './setup';

describe('1. persist() INSERT/UPDATE 판단', () => {
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

  it('1-1: 새 엔티티 persist + flush → INSERT', async () => {
    const em = orm.em.fork();
    const author = em.create(AuthorEntity, { name: 'Test Author' });
    em.persist(author);
    await em.flush();

    const verify = orm.em.fork();
    const found = await verify.findOne(AuthorEntity, { name: 'Test Author' });
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Test Author');
  });

  it('1-2: managed 엔티티에 persist + flush (변경 없음) → 쿼리 없음', async () => {
    // seed
    const seed = orm.em.fork();
    const author = seed.create(AuthorEntity, { name: 'Existing' });
    seed.persist(author);
    await seed.flush();
    const authorId = author.id;

    // test
    const em = orm.em.fork();
    const found = await em.findOneOrFail(AuthorEntity, authorId);
    em.persist(found); // 이미 managed, 변경 없음
    await em.flush();

    // DB 값 변경 없음 확인
    const verify = orm.em.fork();
    const check = await verify.findOneOrFail(AuthorEntity, authorId);
    expect(check.name).toBe('Existing');
  });

  it('1-3: 새 엔티티 persist 2번 + flush → INSERT 1회 (Set 중복 무해)', async () => {
    const em = orm.em.fork();
    const author = em.create(AuthorEntity, { name: 'Double Persist' });
    em.persist(author);
    em.persist(author); // 두 번째 persist
    await em.flush();

    const verify = orm.em.fork();
    const all = await verify.find(AuthorEntity, { name: 'Double Persist' });
    expect(all.length).toBe(1); // 1건만 INSERT
  });

  it('1-4: PK 직접 할당한 새 엔티티 persist + flush → INSERT', async () => {
    const em = orm.em.fork();
    const author = em.create(AuthorEntity, { id: 999, name: 'Manual PK' });
    em.persist(author);
    await em.flush();

    const verify = orm.em.fork();
    const found = await verify.findOne(AuthorEntity, 999);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(999);
    expect(found!.name).toBe('Manual PK');
  });

  it('1-5: 이미 존재하는 PK로 새 인스턴스 persist + flush → 에러', async () => {
    // seed
    const seed = orm.em.fork();
    const author = seed.create(AuthorEntity, { name: 'Original' });
    seed.persist(author);
    await seed.flush();
    const existingId = author.id;

    // test: 같은 PK로 새 인스턴스 생성
    const em = orm.em.fork();
    const duplicate = em.create(AuthorEntity, { id: existingId, name: 'Duplicate' });
    em.persist(duplicate);

    await expect(em.flush()).rejects.toThrow();
  });

  it('1-6: em.create() + flush (persist 호출 없이) → persistOnCreate 동작 확인', async () => {
    const em = orm.em.fork();
    em.create(AuthorEntity, { name: 'No Persist Call' });
    // persist()를 명시적으로 호출하지 않음
    await em.flush();

    const verify = orm.em.fork();
    const found = await verify.findOne(AuthorEntity, { name: 'No Persist Call' });
    // persistOnCreate 기본값이 true면 INSERT 됨, false면 안 됨
    // 실제 동작을 기록하는 것이 목적
    console.log('1-6 result: found =', found !== null);
  });
});
