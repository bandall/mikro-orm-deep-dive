import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { MikroORM } from '@mikro-orm/mysql';
import { Transactional } from '../../src/jpa-compat/transactional.decorator';
import { UserEntity } from '../../src/jpa-compat/entities/user.entity';
import {
  RR_ENABLED,
  ReplicaControl,
  bootOrm,
  createSchema,
  inRequest,
  resetSchema,
  where,
  type Em,
  type Where,
} from './setup';

/** 28. readOnly 트랜잭션 × 비동기 흐름·장애. Spring 은 스레드 바인딩이라 "트랜잭션 끝난 뒤 이어지는 비동기" 가 없다. */
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RR_ENABLED)('28. readOnly 트랜잭션 × 비동기·장애', () => {
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

  it('28-1: readOnly 안 Promise.all 은 한 연결에서 순차 실행되고 모두 replica', async () => {
    const results = await req(() =>
      svc.ro((em) => Promise.all([where(em), where(em), em.count(UserEntity, {}), where(em)])),
    );
    expect(results).toEqual(['replica', 'replica', 0, 'replica']);
  });

  it('28-2: readOnly 안에서 시작해 커밋 뒤에 실행되는 쿼리(await 누락·setTimeout)는 어떻게 되나', async () => {
    let late: Promise<Where | string> = Promise.resolve('not-started');
    await req(() =>
      svc.ro(async (em) => {
        late = sleep(50).then(
          () => where(em),
          (e: Error) => `error: ${e.message}`,
        );
      }),
    );
    const outcome = await late.catch((e: Error) => `error: ${e.message}`);
    // 관측값을 그대로 고정한다 (아래 문서 28 참조)
    expect(outcome).toMatchSnapshot();
  });

  it('28-3: readOnly 안에서 등록한 콜백(이벤트 리스너 흉내)이 커밋 뒤 쓰면 primary 로 가지 않고 실패한다', async () => {
    let late: Promise<unknown> = Promise.resolve();
    await req(() =>
      svc.ro(async (em) => {
        late = sleep(50).then(async () => {
          await em.insert(UserEntity, { name: 'after-commit' });
          return where(em);
        });
      }),
    );
    const outcome = await late.then(
      (w) => w,
      (e: { errno?: number; message: string }) => `error ${e.errno ?? ''}: ${e.message}`,
    );
    expect(outcome).toMatchSnapshot();
  });

  it('28-3b: 일반 RW 트랜잭션도 같다 — 커밋 뒤 같은 문맥의 쿼리는 primary 로 가지 않고 실패한다 (readOnly 고유 문제가 아님)', async () => {
    let late: Promise<unknown> = Promise.resolve();
    await req(() =>
      svc.rw(async (em) => {
        late = sleep(50).then(() => where(em));
      }),
    );
    await expect(late).rejects.toThrow('Transaction is already committed');
  });

  it('28-3c: 커밋 뒤 콜백이 em.fork() 로 새 EM 을 쓰면 primary 에서 정상 실행된다', async () => {
    let late: Promise<unknown> = Promise.resolve();
    await req(() =>
      svc.ro(async (em) => {
        late = sleep(50).then(() => where(em.fork() as Em));
      }),
    );
    expect(await late).toBe('primary');
  });

  it('28-3d: 커밋 뒤 콜백을 RequestContext.create 로 감싸도(리스너 관용 패턴) TransactionContext 가 우선해 실패한다', async () => {
    let late: Promise<unknown> = Promise.resolve();
    await req(() =>
      svc.rw(async () => {
        late = sleep(50).then(() => inRequest(orm, () => where(orm.em)));
      }),
    );
    const outcome = await late.then(
      (w) => w,
      (e: Error) => `error: ${e.message}`,
    );
    expect(outcome).toMatchSnapshot();
  });

  it('28-4: replica 에 붙지 못하면 readOnly 는 실패하고 primary 로 우회하지 않는다. 트랜잭션 밖 조회는 계속 된다', async () => {
    const broken = await bootOrm([{ host: '127.0.0.1', port: 33999 }]);
    const brokenSvc = new Svc(broken.em);
    try {
      await expect(inRequest(broken, () => brokenSvc.ro(where))).rejects.toThrow();
      expect(await inRequest(broken, () => where(broken.em))).toBe('primary');
    } finally {
      await broken.close(true);
    }
  });

  it('28-5: replica 미설정이면 readOnly 는 primary 에서 READ ONLY 로 열린다', async () => {
    const solo = await bootOrm([]);
    const soloSvc = new Svc(solo.em);
    try {
      expect(await inRequest(solo, () => soloSvc.ro(where))).toBe('primary');
      await expect(
        inRequest(solo, () => soloSvc.ro((em) => em.insert(UserEntity, { name: 'x' }))),
      ).rejects.toMatchObject({ errno: 1792 });
    } finally {
      await solo.close(true);
    }
  });
});
