// 실서비스에 넣은 read replica 드라이버의 사본. 수정하지 않고 동작만 관찰한다 (docs/18).
import { RequestContext, TransactionContext, type Configuration } from '@mikro-orm/core';
import { MySqlDriver, type MySqlConnection } from '@mikro-orm/mysql';

type BeginOptions = NonNullable<Parameters<MySqlConnection['begin']>[0]>;
type Transaction = Awaited<ReturnType<MySqlConnection['begin']>>;

/**
 * 읽기 전용 트랜잭션 → 그 트랜잭션을 연 최상위 트랜잭션. SAVEPOINT 도 최상위를 가리킨다.
 * Kysely 는 SAVEPOINT 를 해제해도 종료 표시를 남기지 않아, 끝났는지는 최상위 트랜잭션으로 본다.
 */
const readOnlyRoots = new WeakMap<Transaction, Transaction>();

/**
 * 읽기 전용 트랜잭션을 reader 에서 여는 MySQL 드라이버 (docs/18).
 *
 * `@Transactional({ readOnly: true })` 가 여는 트랜잭션을 reader(`replicas`)로 보낸다. Spring 이 readOnly
 * 트랜잭션이면 라우팅 DataSource 가 reader 커넥션을 주는 것과 같은 자리다. MikroORM 은 readOnly 트랜잭션도
 * writer 연결의 `begin()` 으로 연다. 연결 클래스는 MySqlDriver 가 고정해 바꿀 수 없어, writer 연결의
 * `begin()` 만 감싼다.
 *
 * - 트랜잭션 안의 조회·flush·raw SQL(`em.execute`)은 그 트랜잭션을 따라 reader 로 간다.
 * - `SET TRANSACTION READ ONLY` 뒤 `BEGIN` 으로 열려, 안에서 쓰면 DB 가 거부한다(MySQL 1792). reader 가 없는
 *   설정(로컬·테스트)은 writer 에서 같은 읽기 전용 트랜잭션이 열리므로 쓰기는 그래도 막힌다.
 * - 바깥에 트랜잭션이 이미 열려 있으면 MikroORM 이 begin 없이 합류시킨다(REQUIRED). 그때는 바깥 트랜잭션을 쓴다.
 * - 트랜잭션에 묶이지 않는 쿼리(`em.fork()` 로 새로 만든 EM, ctx 없이 `getConnection().execute()`)는 writer 로 간다.
 * - 트랜잭션 안의 쿼리는 writer 연결 객체를 거쳐 reader 트랜잭션에서 실행된다. 그래서 MikroORM 쿼리 로그에는
 *   writer 연결 이름이 찍힌다. reader 로 갔는지는 reader 인스턴스의 Performance Insights 로 본다.
 */
export class ReadReplicaMySqlDriver extends MySqlDriver {
  constructor(config: Configuration) {
    super(config);
    const writer = this.connection;

    writer.begin = async (options: BeginOptions = {}): Promise<Transaction> => {
      // 지금 설치된 begin 을 부른다. 생성 시점에 잡아 두면 이후 바뀐 구현(테스트 대역 등)을 비켜 간다
      const begin = (connection: MySqlConnection) =>
        Object.getPrototypeOf(connection).begin.call(connection, options) as Promise<Transaction>;

      // 열린 트랜잭션 안의 begin 은 그 트랜잭션의 SAVEPOINT 다. 읽기 전용 트랜잭션 안이면 그대로 읽기 전용이다
      if (options.ctx) {
        const savepoint = await begin(writer);
        const root = readOnlyRoots.get(options.ctx);
        if (root) readOnlyRoots.set(savepoint, root);
        return savepoint;
      }
      if (!options.readOnly) return begin(writer);

      // replica 가 없으면 MikroORM 이 read 요청에도 writer 를 준다
      const trx = await begin(this.getConnection('read'));
      readOnlyRoots.set(trx, trx);
      return trx;
    };
  }
}

/** 지금 비동기 흐름이 아직 끝나지 않은 읽기 전용 트랜잭션 안인가. 이벤트 발행 차단이 쓴다. */
export function isInReadOnlyTransaction(): boolean {
  const em = TransactionContext.getEntityManager() ?? RequestContext.getEntityManager();
  const trx = em?.getTransactionContext<Transaction>();
  const root = trx && readOnlyRoots.get(trx);
  return !!root && !root.isCommitted && !root.isRolledBack;
}
