import 'reflect-metadata';
import { RequestContext, type ConnectionOptions } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/mysql';
import { TsMorphMetadataProvider } from '@mikro-orm/reflection';
import { createConnection, type Connection } from 'mysql2/promise';
import { expect } from 'vitest';
import { ReadReplicaMySqlDriver } from '../../src/read-replica/read-replica.driver';
import { UserEntity } from '../../src/jpa-compat/entities/user.entity';
import { PostEntity } from '../../src/jpa-compat/entities/post.entity';

/** `./scripts/replica-up.sh` 로 띄운 primary(3317) → replica(3318). RR_TEST=1 일 때만 돈다. */
export const RR_ENABLED = !!process.env.RR_TEST;

const PRIMARY = { host: '127.0.0.1', port: 3317, user: 'root', password: 'test' };
const REPLICA: ConnectionOptions = { host: '127.0.0.1', port: 3318 };
const DB_NAME = 'rr_test';

export type Em = MikroORM['em'];
export type Where = 'primary' | 'replica';

export async function bootOrm(replicas: ConnectionOptions[] | undefined = [REPLICA]): Promise<MikroORM> {
  return MikroORM.init({
    driver: ReadReplicaMySqlDriver,
    ...PRIMARY,
    dbName: DB_NAME,
    replicas,
    // readOnly 트랜잭션만 reader 로 보낸다. 트랜잭션 밖 조회는 writer
    preferReadReplicas: false,
    entities: [UserEntity, PostEntity],
    metadataProvider: TsMorphMetadataProvider,
    discovery: { warnWhenNoEntities: false },
    allowGlobalContext: false,
    debug: !!process.env.RR_DEBUG,
  } as never) as unknown as Promise<MikroORM>;
}

/** 요청 하나. 앱처럼 전역 EM 이 요청 EM 을 찾아가게 한다. */
export function inRequest<T>(orm: MikroORM, fn: () => Promise<T>): Promise<T> {
  return RequestContext.create(orm.em as never, fn);
}

/** 지금 문맥의 쿼리가 실제로 어느 인스턴스에서 실행되는가. */
export async function where(em: Em): Promise<Where> {
  const [row] = (await em.execute('select @@server_id as id')) as { id: number }[];
  return Number(row.id) === 1 ? 'primary' : 'replica';
}

/** replica 가 거부(1290 super_read_only)하든 트랜잭션 READ ONLY(1792)가 거부하든 쓰기 거부로 본다. */
export async function expectWriteRejected(work: Promise<unknown>): Promise<number> {
  const error = (await work.then(
    () => null,
    (e: unknown) => e,
  )) as { errno?: number } | null;
  expect(error, '쓰기가 거부되지 않았다').not.toBeNull();
  expect([1290, 1792]).toContain(error?.errno);
  return error?.errno ?? 0;
}

/** replica 적용을 멈추고 풀어 primary 와 replica 의 데이터를 일부러 갈라 놓는다. */
export class ReplicaControl {
  private constructor(
    private readonly replicaRoot: Connection,
    private readonly primaryRoot: Connection,
  ) {}

  static async connect(): Promise<ReplicaControl> {
    const replicaRoot = await createConnection({ ...REPLICA, user: 'root', password: 'test' } as never);
    const primaryRoot = await createConnection(PRIMARY);
    return new ReplicaControl(replicaRoot, primaryRoot);
  }

  pause(): Promise<unknown> {
    return this.replicaRoot.query('stop replica sql_thread');
  }

  async resume(): Promise<void> {
    await this.replicaRoot.query('start replica sql_thread');
    await this.catchUp();
  }

  async catchUp(): Promise<void> {
    const [[{ gtid }]] = (await this.primaryRoot.query(
      'select @@global.gtid_executed as gtid',
    )) as unknown as [[{ gtid: string }]];
    await this.replicaRoot.query('select wait_for_executed_gtid_set(?, 10)', [gtid]);
  }

  /** primary 에 직접 SQL. ORM 문맥과 무관한 "다른 요청의 쓰기" 를 흉내낸다. */
  async primaryRows<T>(sql: string): Promise<T[]> {
    const [rows] = await this.primaryRoot.query(sql.replace(/\bjpa_/g, `${DB_NAME}.jpa_`));
    return rows as T[];
  }

  async primaryExec(sql: string, params: unknown[] = []): Promise<void> {
    await this.primaryRoot.query(sql.replace(/\bjpa_/g, `${DB_NAME}.jpa_`), params);
  }

  async close(): Promise<void> {
    await this.replicaRoot.query('start replica sql_thread').catch(() => undefined);
    await this.replicaRoot.end();
    await this.primaryRoot.end();
  }
}

export async function resetSchema(orm: MikroORM, replica: ReplicaControl): Promise<void> {
  await replica.resume();
  const conn = orm.em.getConnection('write');
  await conn.execute('set foreign_key_checks = 0');
  await conn.execute('truncate table jpa_posts');
  await conn.execute('truncate table jpa_users');
  await conn.execute('set foreign_key_checks = 1');
  await replica.catchUp();
}

export async function createSchema(orm: MikroORM, replica: ReplicaControl): Promise<void> {
  await orm.schema.drop();
  await orm.schema.create();
  await replica.catchUp();
}
