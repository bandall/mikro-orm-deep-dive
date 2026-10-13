import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TransactionPropagation } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/mysql';
import { Transactional } from '../../src/jpa-compat/transactional.decorator';
import { UserEntity } from '../../src/jpa-compat/entities/user.entity';
import {
  RR_ENABLED,
  ReplicaControl,
  bootOrm,
  createSchema,
  expectWriteRejected,
  inRequest,
  resetSchema,
  where,
  type Em,
} from './setup';

/**
 * 26. readOnly 트랜잭션 × 전파 조합 — Spring(AbstractRoutingDataSource + LazyConnectionDataSourceProxy) 대비.
 * 서비스는 앱처럼 전역 EM(this.em)을 들고, 실행 시 지금 문맥의 EM 을 찾아간다.
 */
type Work<T> = (em: Em) => Promise<T>;

class Svc {
  constructor(readonly em: Em) {}

  @Transactional()
  async rw<T>(work: Work<T>): Promise<T> {
    return work(this.em);
  }

  @Transactional({ readOnly: true })
  async ro<T>(work: Work<T>): Promise<T> {
    return work(this.em);
  }

  @Transactional({ propagation: TransactionPropagation.REQUIRES_NEW })
  async rwNew<T>(work: Work<T>): Promise<T> {
    return work(this.em);
  }

  @Transactional({ readOnly: true, propagation: TransactionPropagation.REQUIRES_NEW })
  async roNew<T>(work: Work<T>): Promise<T> {
    return work(this.em);
  }

  @Transactional({ readOnly: true, propagation: TransactionPropagation.NESTED })
  async roNested<T>(work: Work<T>): Promise<T> {
    return work(this.em);
  }

  @Transactional({ propagation: TransactionPropagation.NOT_SUPPORTED })
  async notSupported<T>(work: Work<T>): Promise<T> {
    return work(this.em);
  }

  @Transactional({ readOnly: true, propagation: TransactionPropagation.SUPPORTS })
  async roSupports<T>(work: Work<T>): Promise<T> {
    return work(this.em);
  }

  @Transactional({ readOnly: true, propagation: TransactionPropagation.MANDATORY })
  async roMandatory<T>(work: Work<T>): Promise<T> {
    return work(this.em);
  }
}

const insertUser = (name: string) => (em: Em) => em.insert(UserEntity, { name });

describe.skipIf(!RR_ENABLED)('26. readOnly 트랜잭션 × 전파 (primary/replica 실분리)', () => {
  let orm: MikroORM;
  let replica: ReplicaControl;
  let svc: Svc;

  beforeAll(async () => {
    orm = await bootOrm();
    replica = await ReplicaControl.connect();
    svc = new Svc(orm.em);
    await createSchema(orm, replica);
  });

  afterAll(async () => {
    await replica?.close();
    await orm?.close(true);
  });

  beforeEach(() => resetSchema(orm, replica));

  const req = <T>(fn: () => Promise<T>) => inRequest(orm, fn);
  const userCountOnPrimary = async () =>
    Number((await replica.primaryRows<{ c: number }>('select count(*) c from jpa_users'))[0].c);

  describe('기본 (REQUIRED)', () => {
    it('26-1: 트랜잭션 밖 → primary, readOnly → replica, 일반 → primary', async () => {
      expect(await req(() => where(orm.em))).toBe('primary');
      expect(await req(() => svc.ro(where))).toBe('replica');
      expect(await req(() => svc.rw(where))).toBe('primary');
    });

    it('26-2: RW 안의 readOnly 는 바깥에 합류 → primary, 안에서 쓰기도 성공 (Spring 동일: 참여 트랜잭션은 readOnly 무시)', async () => {
      const inner = await req(() =>
        svc.rw(() =>
          svc.ro(async (em) => {
            await insertUser('in-ro')(em);
            return where(em);
          }),
        ),
      );
      expect(inner).toBe('primary');
      expect(await userCountOnPrimary()).toBe(1);
    });

    it('26-3: readOnly 안의 RW(REQUIRED)는 readOnly 에 합류 → replica, 쓰기는 DB 가 거부 (Spring+Hibernate 는 flush 를 건너뛰어 조용히 유실)', async () => {
      const inner = await req(() => svc.ro(() => svc.rw(where)));
      expect(inner).toBe('replica');

      await expectWriteRejected(req(() => svc.ro(() => svc.rw(insertUser('blocked')))));
      expect(await userCountOnPrimary()).toBe(0);
    });

    it('26-4: readOnly 안의 readOnly 는 그대로 합류 → replica', async () => {
      expect(await req(() => svc.ro(() => svc.ro(where)))).toBe('replica');
    });
  });

  describe('REQUIRES_NEW', () => {
    it('26-5: readOnly 안의 RW(REQUIRES_NEW) → primary 새 트랜잭션, 독립 커밋', async () => {
      const [inner, outerAfter] = await req(() =>
        svc.ro(async (em) => {
          const innerWhere = await svc.rwNew(async (e) => {
            await insertUser('new-tx')(e);
            return where(e);
          });
          return [innerWhere, await where(em)];
        }),
      );
      expect(inner).toBe('primary');
      expect(outerAfter).toBe('replica'); // suspend 됐던 바깥 readOnly 로 복귀
      expect(await userCountOnPrimary()).toBe(1);
    });

    it('26-6: readOnly 안 REQUIRES_NEW 로 쓴 행을 바깥 readOnly 가 바로 못 본다 (replica 지연 + 바깥 스냅샷)', async () => {
      await replica.pause();
      const seen = await req(() =>
        svc.ro(async (em) => {
          await svc.rwNew(insertUser('lagged'));
          return em.count(UserEntity, {});
        }),
      );
      expect(seen).toBe(0);
    });

    it('26-7: RW 안의 readOnly(REQUIRES_NEW) → replica 새 트랜잭션, 바깥이 쓴 미커밋 행을 못 본다 (Spring 라우팅도 동일)', async () => {
      const [innerWhere, innerCount, outerCount] = await req(() =>
        svc.rw(async (em) => {
          await insertUser('uncommitted')(em);
          const r = await svc.roNew(async (e) => [await where(e), await e.count(UserEntity, {})] as const);
          return [...r, await em.count(UserEntity, {})];
        }),
      );
      expect(innerWhere).toBe('replica');
      expect(innerCount).toBe(0);
      expect(outerCount).toBe(1);
    });
  });

  describe('NESTED (SAVEPOINT)', () => {
    it('26-8: RW 안의 readOnly NESTED → SAVEPOINT 는 바깥 연결(primary)이고 readOnly 가 무시되어 쓰기가 성공한다', async () => {
      const inner = await req(() =>
        svc.rw(() =>
          svc.roNested(async (em) => {
            await insertUser('nested-ro')(em);
            return where(em);
          }),
        ),
      );
      expect(inner).toBe('primary');
      expect(await userCountOnPrimary()).toBe(1);
    });

    it('26-9: RW 안의 em.transactional(cb, { readOnly: true }) 도 기본 전파가 NESTED 라 같은 결과', async () => {
      await req(() =>
        svc.rw((em) => em.transactional((inner) => insertUser('em-tx-ro')(inner as Em), { readOnly: true })),
      );
      expect(await userCountOnPrimary()).toBe(1);
    });

    it('26-10: readOnly 안의 em.transactional()(NESTED) → replica SAVEPOINT, 쓰기 거부', async () => {
      expect(await req(() => svc.ro((em) => em.transactional((i) => where(i as Em))))).toBe('replica');
      await expectWriteRejected(req(() => svc.ro((em) => em.transactional((i) => insertUser('x')(i as Em)))));
    });
  });

  describe('트랜잭션 없이 돌리는 전파', () => {
    it('26-11: readOnly 안의 NOT_SUPPORTED → 트랜잭션 밖(primary)으로 빠져 쓰기도 된다 (탈출구)', async () => {
      const inner = await req(() =>
        svc.ro(() =>
          svc.notSupported(async (em) => {
            await insertUser('escaped')(em);
            return where(em);
          }),
        ),
      );
      expect(inner).toBe('primary');
      expect(await userCountOnPrimary()).toBe(1);
    });

    it('26-12: 바깥 트랜잭션 없는 readOnly SUPPORTS → 트랜잭션이 안 열려 primary (Spring 은 readOnly 플래그가 살아 reader 로 감)', async () => {
      expect(await req(() => svc.roSupports(where))).toBe('primary');
    });

    it('26-13: readOnly MANDATORY 는 바깥 트랜잭션이 없으면 예외, 있으면 합류', async () => {
      await expect(req(() => svc.roMandatory(where))).rejects.toThrow();
      expect(await req(() => svc.ro(() => svc.roMandatory(where)))).toBe('replica');
      expect(await req(() => svc.rw(() => svc.roMandatory(where)))).toBe('primary');
    });
  });

  describe('같은 요청 안에서 순차 실행', () => {
    it('26-14: RW 커밋 직후 readOnly 조회 — 방금 create 한 엔티티는 요청 EM 에 있어도 부분 로딩이라 PK 조회도 replica 로 가서 null', async () => {
      await replica.pause();
      const result = await req(async () => {
        const id = await svc.rw(async (em) => {
          const u = em.create(UserEntity, { name: 'just-written' });
          await em.flush();
          return u.id;
        });
        return svc.ro(async (em) => ({
          byPk: (await em.findOne(UserEntity, id))?.name ?? null,
          byFilter: (await em.findOne(UserEntity, { name: 'just-written' }))?.name ?? null,
          count: await em.count(UserEntity, {}),
        }));
      });
      // em.create 는 nullable 컬럼을 안 채워 shouldRefresh=true → identity map 을 건너뛰고 replica 조회
      expect(result).toEqual({ byPk: null, byFilter: null, count: 0 });
    });
  });
});
