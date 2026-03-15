import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MikroORM, RequestContext } from '@mikro-orm/core';
import { INestApplication } from '@nestjs/common';
import { TestingModule } from '@nestjs/testing';
import { AuthorEntity } from '../../src/behavior/entities/author.entity';
import { createTestingApp, resetSchema } from './setup';

describe('14. 중첩 컨텍스트 주의사항', () => {
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

  it('14-1: RequestContext.create() 중첩 → 내부 RC는 별도 fork (외부와 격리)', async () => {
    let outerContextEm: any;
    let innerContextEm: any;

    await RequestContext.create(orm.em, async () => {
      outerContextEm = (orm.em as any).getContext();

      // 외부 RC에서 엔티티 생성
      const author = orm.em.create(AuthorEntity, { name: 'Outer Author' });
      orm.em.persist(author);

      // 중첩 RC 생성
      await RequestContext.create(orm.em, async () => {
        innerContextEm = (orm.em as any).getContext();

        // 내부 RC에서 엔티티 생성
        const innerAuthor = orm.em.create(AuthorEntity, {
          name: 'Inner Author',
        });
        orm.em.persist(innerAuthor);
        await orm.em.flush();
      });

      // 내부와 외부 RC의 EM이 다른 인스턴스
      expect(outerContextEm).not.toBe(innerContextEm);
    });
  });

  it('14-2: 중첩 RC — 내부 flush가 외부 변경사항에 영향 없음', async () => {
    await RequestContext.create(orm.em, async () => {
      // 외부 RC에서 엔티티 생성 (flush 안 함)
      const outerAuthor = orm.em.create(AuthorEntity, {
        name: 'Outer Only',
      });
      orm.em.persist(outerAuthor);

      // 중첩 RC
      await RequestContext.create(orm.em, async () => {
        const innerAuthor = orm.em.create(AuthorEntity, {
          name: 'Inner Only',
        });
        orm.em.persist(innerAuthor);
        await orm.em.flush(); // 내부 RC만 flush
      });

      // 외부 RC의 변경사항은 아직 flush 안 됨
      // DB에서 직접 확인
      const verify = orm.em.fork();
      const innerFound = await verify.findOne(AuthorEntity, {
        name: 'Inner Only',
      });
      const outerFound = await verify.findOne(AuthorEntity, {
        name: 'Outer Only',
      });

      expect(innerFound).not.toBeNull(); // 내부 RC flush됨
      expect(outerFound).toBeNull(); // 외부 RC는 아직 flush 안 됨

      // 외부 RC에서 flush
      await orm.em.flush();
    });

    // 이제 둘 다 DB에 존재
    const verify = orm.em.fork();
    const all = await verify.find(AuthorEntity, {});
    expect(all).toHaveLength(2);
  });

  it('14-3: 중첩 RC — 내부에서 생성한 엔티티가 외부 Identity Map에 없음', async () => {
    let innerId: number | undefined;

    await RequestContext.create(orm.em, async () => {
      // 중첩 RC에서 엔티티 생성
      await RequestContext.create(orm.em, async () => {
        const inner = orm.em.create(AuthorEntity, { name: 'Inner Entity' });
        orm.em.persist(inner);
        await orm.em.flush();
        innerId = inner.id;
      });

      // 외부 RC에서 해당 엔티티를 PK로 조회 → DB에서 새로 로드
      const fromOuter = await orm.em.findOne(AuthorEntity, innerId!);
      expect(fromOuter).not.toBeNull();
      expect(fromOuter!.name).toBe('Inner Entity');
    });
  });

  it('14-4: em.fork() + transactional — fork는 별도 Identity Map', async () => {
    const em = orm.em.fork();

    // 원본 EM에서 엔티티 로드 + 변경
    const seed = em.create(AuthorEntity, { name: 'Seed' });
    em.persist(seed);
    await em.flush();

    const author = await em.findOneOrFail(AuthorEntity, seed.id);
    author.name = 'Memory Change';

    // fork().transactional → 별도 Identity Map
    await em.fork().transactional(async (forkedEm) => {
      const forkedAuthor = await forkedEm.findOneOrFail(
        AuthorEntity,
        seed.id,
      );
      // fork에서는 DB 값 로드 (원본 EM의 변경 영향 없음)
      expect(forkedAuthor.name).toBe('Seed');

      forkedAuthor.name = 'Forked Change';
      // transactional 종료 시 auto flush → DB에 'Forked Change'
    });

    // 원본 EM의 메모리 값은 그대로
    expect(author.name).toBe('Memory Change');

    // DB에는 fork의 변경이 반영됨
    const verify = orm.em.fork();
    const dbValue = await verify.findOneOrFail(AuthorEntity, seed.id);
    expect(dbValue.name).toBe('Forked Change');
  });

  it('14-5: em.transactional (fork 없이) — 같은 Identity Map 공유', async () => {
    const em = orm.em.fork();

    const seed = em.create(AuthorEntity, { name: 'Seed' });
    em.persist(seed);
    await em.flush();

    const author = await em.findOneOrFail(AuthorEntity, seed.id);
    author.name = 'Before TX';

    // em.transactional → 같은 EM의 트랜잭션 (Identity Map 공유)
    await em.transactional(async (txEm) => {
      const txAuthor = await txEm.findOneOrFail(AuthorEntity, seed.id);
      // 같은 Identity Map → 메모리 변경값이 보임
      expect(txAuthor.name).toBe('Before TX');
      expect(txAuthor).toBe(author); // 같은 인스턴스

      txAuthor.name = 'TX Change';
      // transactional 종료 시 flush → DB에 'TX Change'
    });

    // 같은 인스턴스이므로 원본도 변경됨
    expect(author.name).toBe('TX Change');
  });
});
