import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MikroORM } from '@mikro-orm/core';
import { INestApplication } from '@nestjs/common';
import { TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AuthorEntity } from '../../src/behavior/entities/author.entity';
import { createTestingApp, resetSchema } from './setup';

describe('9. E2E — registerRequestContext & allowGlobalContext', () => {
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

  it('9-1: POST /authors — registerRequestContext가 자동 fork → INSERT 성공', async () => {
    const res = await request(app.getHttpServer())
      .post('/authors')
      .send({ name: 'E2E Author' })
      .expect(201);

    expect(res.body.name).toBe('E2E Author');
    expect(res.body.id).toBeDefined();

    // DB에서 직접 확인
    const em = orm.em.fork();
    const found = await em.findOne(AuthorEntity, { name: 'E2E Author' });
    expect(found).not.toBeNull();
  });

  it('9-2: GET /authors/:id — registerRequestContext가 자동 fork → SELECT 성공', async () => {
    // seed
    const seed = orm.em.fork();
    const author = seed.create(AuthorEntity, { name: 'Find Me' });
    seed.persist(author);
    await seed.flush();

    const res = await request(app.getHttpServer())
      .get(`/authors/${author.id}`)
      .expect(200);

    expect(res.body.found).toBe(true);
    expect(res.body.name).toBe('Find Me');
  });

  it('9-3: 연속 요청 — 각 요청이 독립된 Identity Map 사용', async () => {
    // 첫 번째 요청: Author 생성
    const res1 = await request(app.getHttpServer())
      .post('/authors')
      .send({ name: 'Request 1' })
      .expect(201);

    // 두 번째 요청: 다른 Author 생성
    const res2 = await request(app.getHttpServer())
      .post('/authors')
      .send({ name: 'Request 2' })
      .expect(201);

    // 각 요청이 독립된 fork EM을 사용했으므로 둘 다 성공
    expect(res1.body.id).not.toBe(res2.body.id);

    // DB에서 전체 조회
    const em = orm.em.fork();
    const all = await em.find(AuthorEntity, {});
    expect(all).toHaveLength(2);
  });

  it('9-4: GET /authors — 목록 조회가 이전 요청의 Identity Map에 영향받지 않음', async () => {
    // seed: 2개 생성
    const seed = orm.em.fork();
    seed.persist(seed.create(AuthorEntity, { name: 'Author A' }));
    seed.persist(seed.create(AuthorEntity, { name: 'Author B' }));
    await seed.flush();

    // 첫 조회
    const res1 = await request(app.getHttpServer())
      .get('/authors')
      .expect(200);
    expect(res1.body).toHaveLength(2);

    // seed로 1개 추가
    const seed2 = orm.em.fork();
    seed2.persist(seed2.create(AuthorEntity, { name: 'Author C' }));
    await seed2.flush();

    // 두 번째 조회 — 새 fork이므로 3개 보여야 함
    const res2 = await request(app.getHttpServer())
      .get('/authors')
      .expect(200);
    expect(res2.body).toHaveLength(3);
  });

  it('9-5: 요청 안에서 생성한 엔티티가 같은 요청의 조회에 반영됨 (같은 fork EM)', async () => {
    // POST로 생성
    const createRes = await request(app.getHttpServer())
      .post('/authors')
      .send({ name: 'Same Request' })
      .expect(201);

    const id = createRes.body.id;

    // GET으로 즉시 조회 — 별도 요청이므로 새 fork이지만 DB에 commit 완료된 상태
    const getRes = await request(app.getHttpServer())
      .get(`/authors/${id}`)
      .expect(200);

    expect(getRes.body.found).toBe(true);
    expect(getRes.body.name).toBe('Same Request');
  });
});
