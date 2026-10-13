import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { MikroORM } from '@mikro-orm/mysql';
import { Transactional } from '../../src/jpa-compat/transactional.decorator';
import { UserEntity } from '../../src/jpa-compat/entities/user.entity';
import { PostEntity } from '../../src/jpa-compat/entities/post.entity';
import {
  RR_ENABLED,
  ReplicaControl,
  bootOrm,
  createSchema,
  expectWriteRejected,
  inRequest,
  resetSchema,
  type Em,
} from './setup';

/**
 * 27. readOnly 트랜잭션 × 요청 EM(identity map).
 * MikroORM 은 트랜잭션마다 요청 EM 을 fork(clear: false)하고 커밋 뒤 엔티티를 요청 EM 으로 되돌린다.
 * Spring(OSIV 꺼짐)은 트랜잭션마다 영속성 컨텍스트가 새로 열린다 — 여기서 차이가 난다.
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
}

describe.skipIf(!RR_ENABLED)('27. readOnly 트랜잭션 × identity map', () => {
  let orm: MikroORM;
  let replica: ReplicaControl;
  let svc: Svc;
  let userId: number;

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

  beforeEach(async () => {
    await resetSchema(orm, replica);
    await replica.primaryExec(`insert into jpa_users (name, age) values ('kim', 10)`);
    userId = (await replica.primaryRows<{ id: number }>('select id from jpa_users'))[0].id;
    await replica.catchUp();
  });

  const req = <T>(fn: () => Promise<T>) => inRequest(orm, fn);
  const ageOnPrimary = async () =>
    (await replica.primaryRows<{ age: number }>(`select age from jpa_users where id = ${userId}`))[0].age;

  /** 다른 요청이 primary 에서 age 를 20 으로 바꿨고, replica 는 아직 10 이다. */
  async function otherRequestUpdatesAgeTo20WhileReplicaLags() {
    await replica.pause();
    await replica.primaryExec(`update jpa_users set age = 20 where id = ${userId}`);
  }

  describe('replica 에서 읽은 값이 쓰기 트랜잭션으로 넘어간다', () => {
    it('27-1: readOnly 로 읽은 뒤 RW 에서 PK 재조회 → 요청 EM 캐시(replica 값)가 나와 갱신이 유실된다', async () => {
      await otherRequestUpdatesAgeTo20WhileReplicaLags();

      const seenInRw = await req(async () => {
        await svc.ro((em) => em.findOneOrFail(UserEntity, userId)); // replica: age 10
        return svc.rw(async (em) => {
          const user = await em.findOneOrFail(UserEntity, userId); // 쿼리 없이 캐시
          const seen = user.age;
          user.age = (user.age ?? 0) + 5;
          return seen;
        });
      });

      // Spring(OSIV 꺼짐)이면 RW 트랜잭션이 새 영속성 컨텍스트에서 primary 를 읽어 25 가 된다
      expect(seenInRw).toBe(10);
      expect(await ageOnPrimary()).toBe(15);
    });

    it('27-2: RW 에서 refresh: true 로 다시 읽으면 primary 값으로 갱신된다', async () => {
      await otherRequestUpdatesAgeTo20WhileReplicaLags();

      await req(async () => {
        await svc.ro((em) => em.findOneOrFail(UserEntity, userId));
        await svc.rw(async (em) => {
          const user = await em.findOneOrFail(UserEntity, userId, { refresh: true });
          user.age = (user.age ?? 0) + 5;
        });
      });

      expect(await ageOnPrimary()).toBe(25);
    });

    it('27-3: 반면 RW 에서 조건(비 PK) 조회는 primary 를 읽어 관리 중인 엔티티를 최신값으로 갱신한다', async () => {
      await otherRequestUpdatesAgeTo20WhileReplicaLags();

      const seen = await req(async () => {
        await svc.ro((em) => em.findOneOrFail(UserEntity, userId));
        return svc.rw(async (em) => (await em.findOneOrFail(UserEntity, { name: 'kim' })).age);
      });

      expect(seen).toBe(20);
    });
  });

  describe('반대 방향 — primary 에서 읽은 값을 가진 채 readOnly 로 조회', () => {
    it('27-4: readOnly 의 PK 조회는 캐시(primary 값)를 주고, 조건 조회 결과는 replica 기준이라 서로 어긋난다', async () => {
      await otherRequestUpdatesAgeTo20WhileReplicaLags();

      const result = await req(async () => {
        await orm.em.findOneOrFail(UserEntity, userId); // 트랜잭션 밖 → primary: age 20
        return svc.ro(async (em) => ({
          byPk: (await em.findOneOrFail(UserEntity, userId)).age,
          age20Count: await em.count(UserEntity, { age: 20 }),
          byAge20: (await em.findOne(UserEntity, { age: 20 }))?.age ?? null,
        }));
      });

      expect(result).toEqual({ byPk: 20, age20Count: 0, byAge20: null });
    });
  });

  describe('readOnly 트랜잭션의 커밋 시 flush', () => {
    it('27-5: readOnly 안에서 엔티티를 고치면 커밋 flush 가 replica 에 UPDATE 를 보내 메서드 전체가 실패한다 (Hibernate 는 조용히 무시)', async () => {
      await expectWriteRejected(
        req(() =>
          svc.ro(async (em) => {
            const user = await em.findOneOrFail(UserEntity, userId);
            user.name = user.name.trim().toUpperCase(); // 조회 중 "정규화"
            return user;
          }),
        ),
      );
      expect((await replica.primaryRows<{ name: string }>('select name from jpa_users'))[0].name).toBe('kim');
    });

    it('27-6: 요청 EM 에 미반영 변경이 있으면, 무관한 readOnly 조회가 그 변경을 flush 하려다 실패한다', async () => {
      await expectWriteRejected(
        req(async () => {
          const user = await orm.em.findOneOrFail(UserEntity, userId);
          user.age = 99; // 아직 flush 안 한 변경
          return svc.ro((em) => em.count(PostEntity, {})); // 전혀 다른 엔티티 조회
        }),
      );
    });
  });

  describe('지연 로딩·populate', () => {
    it('27-7: readOnly 에서 읽은 엔티티를 트랜잭션 밖에서 populate 하면 primary 로 간다', async () => {
      await replica.pause();
      await replica.primaryExec(`insert into jpa_posts (title, user_id) values ('only-on-primary', ${userId})`);

      const [inside, outside] = await req(async () => {
        const insideCount = await svc.ro(async (em) => {
          const u = await em.findOneOrFail(UserEntity, userId, { populate: ['posts'] });
          return u.posts.length;
        });
        const user = await orm.em.findOneOrFail(UserEntity, userId);
        await orm.em.populate(user, ['posts'], { refresh: true });
        return [insideCount, user.posts.length];
      });

      expect(inside).toBe(0);
      expect(outside).toBe(1);
    });
  });
});
