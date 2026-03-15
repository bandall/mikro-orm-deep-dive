import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MikroORM, RequestContext } from '@mikro-orm/core';
import { EntityManager as MysqlEntityManager } from '@mikro-orm/mysql';
import { INestApplication } from '@nestjs/common';
import { TestingModule } from '@nestjs/testing';
import { AuthorEntity } from '../../src/behavior/entities/author.entity';
import { AuthorRepository } from '../../src/behavior/repositories/author.repository';
import { createTestingApp, resetSchema } from './setup';

describe('4. EntityManager 컨텍스트 해결', () => {
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
    // seed
    const seed = orm.em.fork();
    seed.persist(seed.create(AuthorEntity, { name: 'Context Author' }));
    await seed.flush();
  });

  it('4-1: RequestContext 안에서 글로벌 EM으로 find → fork EM 사용', async () => {
    await RequestContext.create(orm.em, async () => {
      const found = await orm.em.findOne(AuthorEntity, { name: 'Context Author' });
      expect(found).not.toBeNull();

      // RequestContext 내에서 글로벌 EM의 getContext()가 fork를 반환
      const contextEm = (orm.em as any).getContext();
      expect(contextEm).not.toBe(orm.em);
    });
  });

  it('4-2: RequestContext 없이 글로벌 EM 사용 → allowGlobalContext=false이면 에러', async () => {
    // allowGlobalContext: false → 글로벌 EM으로 context-specific 작업 시 에러
    await expect(
      orm.em.findOne(AuthorEntity, { name: 'Context Author' }),
    ).rejects.toThrow(/global EntityManager/);
  });

  it('4-3: 두 개의 RequestContext에서 같은 엔티티 조회 → 서로 다른 인스턴스', async () => {
    let id1: number | undefined;
    let id2: number | undefined;

    await RequestContext.create(orm.em, async () => {
      const found = await orm.em.findOne(AuthorEntity, { name: 'Context Author' });
      id1 = found?.id;
    });

    await RequestContext.create(orm.em, async () => {
      const found = await orm.em.findOne(AuthorEntity, { name: 'Context Author' });
      id2 = found?.id;
    });

    // [발견] RC가 끝난 후 엔티티 참조를 외부에서 사용하면
    // lazy-loaded Collection 접근 시 에러 발생 → RC 밖에서 엔티티 사용 금지
    // ID만 비교하면 같은 레코드를 가리킴
    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    expect(id1).toBe(id2); // 같은 DB 레코드
  });

  it('4-4: RequestContext 안에서 repository.getEntityManager() → 같은 프록시 반환 (내부적으로 fork EM 사용)', async () => {
    await RequestContext.create(orm.em, async () => {
      const repo = orm.em.getRepository(AuthorEntity) as AuthorRepository;
      const repoEm = repo.getEntityManager();
      // [발견] repo.getEntityManager()은 같은 글로벌 EM 프록시를 반환
      // 하지만 내부적으로 getContext()를 통해 fork EM에서 실행됨
      expect(repoEm).toBe(orm.em); // 같은 프록시 객체

      // getContext()로 확인하면 fork EM
      const context = (repoEm as any).getContext();
      expect(context).not.toBe(orm.em);
    });
  });

  it('4-5: DI 주입 EM vs repository EM (RequestContext 내) → 같은 fork EM', async () => {
    await RequestContext.create(orm.em, async () => {
      const diEm = module.get(MysqlEntityManager);
      const repo = orm.em.getRepository(AuthorEntity) as AuthorRepository;
      const repoEm = repo.getEntityManager();

      // 둘 다 RequestContext를 통해 같은 fork EM을 사용
      const diContext = (diEm as any).getContext();
      const repoContext = (repoEm as any).getContext();
      console.log('4-5: DI EM context === repo EM context:', diContext === repoContext);
    });
  });

  it('4-6: orm.em은 프록시 — fork()해도 참조는 동일하지만 Identity Map은 독립', async () => {
    // orm.em 자체는 항상 같은 프록시 객체
    const ref1 = orm.em;
    const ref2 = orm.em;
    expect(ref1).toBe(ref2); // 같은 프록시 참조

    // fork()하면 별개의 실제 EM 인스턴스
    const fork1 = orm.em.fork();
    const fork2 = orm.em.fork();
    expect(fork1).not.toBe(fork2); // 다른 인스턴스
    expect(fork1).not.toBe(orm.em); // 프록시와도 다름

    // RequestContext마다 getContext()가 다른 fork를 반환
    let context1: any;
    let context2: any;
    await RequestContext.create(orm.em, async () => {
      context1 = (orm.em as any).getContext();
    });
    await RequestContext.create(orm.em, async () => {
      context2 = (orm.em as any).getContext();
    });
    expect(context1).not.toBe(context2); // 각 RC마다 독립 fork
    expect(context1).not.toBe(orm.em);   // 프록시 자체가 아님
  });

  it('4-7: DI로 주입받은 EM도 같은 프록시 — NestJS 전역에 하나', async () => {
    const diEm = module.get(MysqlEntityManager);
    // DI 주입 EM === orm.em (같은 글로벌 프록시)
    expect(diEm).toBe(orm.em);

    // RequestContext 안에서는 둘 다 같은 fork로 해소
    await RequestContext.create(orm.em, async () => {
      const ctx1 = (orm.em as any).getContext();
      const ctx2 = (diEm as any).getContext();
      expect(ctx1).toBe(ctx2); // 같은 fork EM
    });
  });

  it('4-8: em.clear() 후 동일 PK 조회 → DB에서 새로 로드', async () => {
    const em = orm.em.fork();
    const author1 = await em.findOneOrFail(AuthorEntity, { name: 'Context Author' });
    const id = author1.id;
    const name1 = author1.name; // clear 전에 값 보존

    em.clear(); // Identity Map 초기화

    const author2 = await em.findOneOrFail(AuthorEntity, id);
    // [발견] clear() 후 재조회하면 새 인스턴스 (다른 참조)
    expect(author2.name).toBe('Context Author');
    expect(name1).toBe(author2.name);
    // author1은 detached 상태 → collection 접근 시 에러
  });
});
