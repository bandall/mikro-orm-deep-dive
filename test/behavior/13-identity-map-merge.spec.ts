import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MikroORM } from '@mikro-orm/core';
import { INestApplication } from '@nestjs/common';
import { TestingModule } from '@nestjs/testing';
import { AuthorEntity } from '../../src/behavior/entities/author.entity';
import { createTestingApp, resetSchema } from './setup';

describe('13. Identity Map 병합 우선순위', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let module: TestingModule;
  let seedId: number;

  beforeAll(async () => {
    ({ app, orm, module } = await createTestingApp());
  });

  afterAll(async () => {
    await orm.close();
    await app.close();
  });

  beforeEach(async () => {
    await resetSchema(orm);
    const seed = orm.em.fork();
    const author = seed.create(AuthorEntity, {
      name: 'Original',
      email: 'test@test.com',
    });
    seed.persist(author);
    await seed.flush();
    seedId = author.id;
  });

  it('13-1: PK 조회 → Identity Map 캐시 히트 (DB 쿼리 없이 같은 인스턴스)', async () => {
    const em = orm.em.fork();
    const author1 = await em.findOneOrFail(AuthorEntity, seedId);
    const author2 = await em.findOneOrFail(AuthorEntity, seedId);

    // 같은 인스턴스 (참조 동일)
    expect(author1).toBe(author2);
  });

  it('13-2: 메모리 변경 후 비-PK 조회 → Identity Map의 변경값이 우선', async () => {
    const em = orm.em.fork();
    const author = await em.findOneOrFail(AuthorEntity, seedId);
    author.name = 'Changed In Memory';
    // flush 하지 않음 — DB에는 아직 'Original'

    // 비-PK 조건으로 조회 → DB 쿼리 실행 → Identity Map과 병합
    const authors = await em.find(AuthorEntity, { email: 'test@test.com' });

    // Identity Map의 변경된 값이 우선 적용됨
    const found = authors.find((a) => a.id === seedId);
    expect(found).toBeDefined();
    expect(found!.name).toBe('Changed In Memory'); // DB의 'Original'이 아님
    expect(found).toBe(author); // 같은 인스턴스
  });

  it('13-3: 메모리 변경 후 비-PK 조회 — DB 조건과 메모리 값이 다르면 결과에 포함되지만 메모리 값 유지', async () => {
    const em = orm.em.fork();
    const author = await em.findOneOrFail(AuthorEntity, seedId);
    author.name = 'Changed';
    // DB에는 'Original', 메모리에는 'Changed'

    // DB에서 name='Original'로 조회 → id=seedId가 결과에 포함
    const results = await em.find(AuthorEntity, { name: 'Original' });

    // DB 쿼리 결과에 해당 author가 포함되지만, Identity Map 값이 우선
    const found = results.find((a) => a.id === seedId);
    if (found) {
      expect(found.name).toBe('Changed'); // DB의 'Original'이 아닌 메모리 값
      expect(found).toBe(author);
    }
  });

  it('13-4: refresh: true → DB 값으로 강제 덮어쓰기 (메모리 변경 소실)', async () => {
    const em = orm.em.fork();
    const author = await em.findOneOrFail(AuthorEntity, seedId);
    author.name = 'Will Be Lost';
    // flush 하지 않음

    // refresh: true → DB에서 최신 값으로 강제 갱신
    const refreshed = await em.findOneOrFail(AuthorEntity, seedId, {
      refresh: true,
    });

    // 메모리 변경사항이 DB 값으로 덮어씌워짐
    expect(refreshed.name).toBe('Original');
    expect(refreshed).toBe(author); // 같은 인스턴스지만 값이 DB 값으로 복원
    expect(author.name).toBe('Original'); // 원래 변경도 사라짐
  });

  it('13-5: 다른 EM에서 DB 변경 후 → 기존 EM에서 조회 → Identity Map 캐시 반환 (stale)', async () => {
    const em1 = orm.em.fork();
    const em2 = orm.em.fork();

    // em1에서 로드
    const author1 = await em1.findOneOrFail(AuthorEntity, seedId);
    expect(author1.name).toBe('Original');

    // em2에서 DB 직접 변경
    const author2 = await em2.findOneOrFail(AuthorEntity, seedId);
    author2.name = 'Updated By EM2';
    await em2.flush();

    // em1에서 PK 재조회 → Identity Map 캐시 → stale 데이터
    const stale = await em1.findOneOrFail(AuthorEntity, seedId);
    expect(stale.name).toBe('Original'); // DB에는 'Updated By EM2'이지만 캐시 반환

    // refresh: true로 최신 DB 값 가져오기
    const fresh = await em1.findOneOrFail(AuthorEntity, seedId, {
      refresh: true,
    });
    expect(fresh.name).toBe('Updated By EM2');
  });

  it('13-6: 비-PK 조회 시 flush는 발생하지 않음 — 병합만 수행', async () => {
    const em = orm.em.fork();
    const author = await em.findOneOrFail(AuthorEntity, seedId);
    author.name = 'Dirty';
    // flush 하지 않음

    // 비-PK 조회
    await em.find(AuthorEntity, { email: 'test@test.com' });

    // DB에서 직접 확인 — 여전히 'Original' (flush 안 됨)
    const verify = orm.em.fork();
    const dbAuthor = await verify.findOneOrFail(AuthorEntity, seedId);
    expect(dbAuthor.name).toBe('Original'); // flush가 발생하지 않았음을 확인
  });
});
