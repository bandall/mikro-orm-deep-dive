import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  EntityManager,
  EntityRepository,
  EntitySchema,
  helper,
} from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/mysql';
import { Transactional } from '@mikro-orm/decorators/legacy';

/**
 * commons `BaseRepository` **최종 수정본**을 roamings/managements 가 실제로 쓰는 패턴으로 검증.
 *
 * spec 18 은 FixLedger 단일 엔티티 + save() 단건만 봤다. 여기서는 두 가지를 더 닫는다:
 *   (1) **제네릭 EntityRepository<T>** — 실제 BaseRepository 처럼 `this.entityName` 기반
 *       getById/upsert 경로(= isManagedHere / Case3)를 그대로 태운다.
 *   (2) **실사용 패턴** — 서비스 계층(@Transactional)에서 save/saveAll 을 호출한다:
 *        A. roamings me/cards      — create(관계) / update(managed)          → save 단건
 *        B. roamings me/charger    — status-notification: load→mutate→saveAll → Case1 배치
 *        C. roamings me/battery    — all-new saveAll                          → Case2 배치
 *        D. managements officials  — nested @Transactional + 스칼라 FK read-back (준공 탭 버그)
 *
 * 검증 repo 는 commons/src/database/mikro-orm/base.repository.ts 최종본의 **verbatim 미러**.
 * (OLD 대비군은 officials 버그가 실제로 "치유"됨을 보이기 위해서만 둔다.)
 *
 * ⚠️ 샌드박스는 MySQL — 결함 B 의 *증상*(PG GENERATED ALWAYS IDENTITY INSERT 거부)은
 *    여기서 안 터진다. 대신 **라우팅**(upsert 로 새는지 / dirty UPDATE 로 가는지)과 onUpdate 훅,
 *    id 즉시 할당(Spring parity)을 검증한다. PG 실증은 doc 16 §16.1 라이브 재현에 의존.
 */

// ===========================================================================
// 엔티티 (EntitySchema — TsMorph 불필요)
// ===========================================================================

// --- roamings me/cards ---
class Card {
  id!: number;
  signature!: string;
  channel!: string;
  departmentCode!: string;
  isStop!: boolean;
  updatedAt?: Date | null;
}
const cardSchema = new EntitySchema<Card>({
  class: Card,
  tableName: 'repro_card',
  properties: {
    id: { type: 'number', primary: true, autoincrement: true },
    signature: { type: 'string' },
    channel: { type: 'string' },
    departmentCode: { type: 'string' },
    isStop: { type: 'boolean' },
    updatedAt: { type: 'datetime', nullable: true, onUpdate: () => new Date() },
  },
});

class CardHistory {
  id!: number;
  card!: Card;
  action!: string;
  departmentCode!: string;
}
const cardHistorySchema = new EntitySchema<CardHistory>({
  class: CardHistory,
  tableName: 'repro_card_history',
  properties: {
    id: { type: 'number', primary: true, autoincrement: true },
    card: { kind: 'm:1', entity: () => Card },
    action: { type: 'string' },
    departmentCode: { type: 'string' },
  },
});

// --- roamings me/charger (status-notification) ---
class Charger {
  id!: number;
  designedDeviceId!: string;
  designedConnectorId!: number;
  status!: string;
  statusAt?: Date | null;
  updatedAt?: Date | null;
}
const chargerSchema = new EntitySchema<Charger>({
  class: Charger,
  tableName: 'repro_charger',
  properties: {
    id: { type: 'number', primary: true, autoincrement: true },
    designedDeviceId: { type: 'string' },
    designedConnectorId: { type: 'number' },
    status: { type: 'string' },
    statusAt: { type: 'datetime', nullable: true },
    updatedAt: { type: 'datetime', nullable: true, onUpdate: () => new Date() },
  },
});

// --- roamings me/battery (all-new saveAll) ---
class BatteryKeyHistory {
  id!: number;
  chargerId!: number;
  keyId!: string;
}
const batteryKeyHistorySchema = new EntitySchema<BatteryKeyHistory>({
  class: BatteryKeyHistory,
  tableName: 'repro_battery_key_history',
  properties: {
    id: { type: 'number', primary: true, autoincrement: true },
    chargerId: { type: 'number' },
    keyId: { type: 'string' },
  },
});

// --- managements officials (nested @Transactional + 스칼라 FK) ---
class Official {
  id!: number;
  name!: string;
}
const officialSchema = new EntitySchema<Official>({
  class: Official,
  tableName: 'repro_official',
  properties: {
    id: { type: 'number', primary: true, autoincrement: true },
    name: { type: 'string' },
  },
});

class OfficialDetail {
  id!: number;
  /** 관계가 아니라 **스칼라 FK** — 실제 managements 버그 형태 (부모 id 를 값으로 복사) */
  officialId?: number | null;
  content!: string;
}
const officialDetailSchema = new EntitySchema<OfficialDetail>({
  class: OfficialDetail,
  tableName: 'repro_official_detail',
  properties: {
    id: { type: 'number', primary: true, autoincrement: true },
    officialId: { type: 'number', nullable: true },
    content: { type: 'string' },
  },
});

// ===========================================================================
// 리포지토리 — commons BaseRepository 미러 (제네릭)
// ===========================================================================

/** commons/src/database/mikro-orm/base.repository.ts **최종본** verbatim 미러 */
class CommonsRepository<T extends object> extends EntityRepository<T> {
  private ctx(): EntityManager {
    return (this.em as any).getContext(false) as EntityManager;
  }

  private isManagedHere(em: EntityManager, entity: T): boolean {
    const wrapped = helper(entity);
    if (!wrapped.__managed || !wrapped.hasPrimaryKey()) return false;
    return (
      em.getUnitOfWork().getById(this.entityName as never, wrapped.getPrimaryKey() as never) ===
      entity
    );
  }

  private route(em: EntityManager, entity: T): T {
    const wrapped = helper(entity);
    if (this.isManagedHere(em, entity)) return entity; // Case 1
    if (!wrapped.hasPrimaryKey()) {
      em.persist(entity); // Case 2: 신규 → persist (flush 는 opts.flush)
      return entity;
    }
    if ((wrapped as any).__originalEntityData) {
      return em.upsert(this.entityName as any, entity as any) as unknown as T; // Case 3
    }
    em.persist(entity); // Case 4
    return entity;
  }

  @Transactional()
  async save(entity: T, opts?: { flush?: boolean }): Promise<T> {
    const em = this.ctx();
    const result = this.route(em, entity);
    if (opts?.flush) await em.flush();
    return result;
  }

  @Transactional()
  async saveAll(entities: T[], opts?: { flush?: boolean }): Promise<T[]> {
    const em = this.ctx();
    const results = entities.map((e) => this.route(em, e));
    if (opts?.flush) await em.flush();
    return results;
  }
}

/** OLD commons — officials 버그가 실제로 "치유"됨을 대비 검증하기 위한 대조군 (Case2 flush 없음) */
class OldCommonsRepository<T extends object> extends EntityRepository<T> {
  private ctx(): EntityManager {
    return (this.em as any).getContext(false) as EntityManager;
  }

  @Transactional()
  async save(entity: T, _opts?: { flush?: boolean }): Promise<T> {
    // OLD 는 opts.flush 를 무시한다 — 신규 save 가 flush 안 하는 원래 버그를 그대로 재현.
    const em = this.ctx();
    const wrapped = helper(entity);
    if (wrapped.__managed && (wrapped as any).__em === em) return entity; // Case1: __em 포인터
    if (!wrapped.hasPrimaryKey()) {
      em.persist(entity); // Case2: flush 없음 ← 버그
      return entity;
    }
    if ((wrapped as any).__originalEntityData) {
      return (await em.upsert(this.entityName as any, entity as any)) as T;
    }
    em.persist(entity);
    return entity;
  }
}

// ===========================================================================
// 서비스 계층 — 실제 서비스 미러 (@Transactional)
// ===========================================================================

/** roamings me/cards CardWriterService.upsert 미러 */
class CardWriterService {
  constructor(
    readonly em: EntityManager,
    private readonly cardRepo: CommonsRepository<Card>,
    private readonly historyRepo: CommonsRepository<CardHistory>,
  ) {}
  private ctx(): EntityManager {
    return (this.em as any).getContext(false) as EntityManager;
  }

  @Transactional()
  async create(signature: string, channel: string, departmentCode: string): Promise<number> {
    const em = this.ctx();
    const card = em.create(Card, { signature, channel, departmentCode, isStop: false });
    await this.cardRepo.save(card, { flush: true }); // card.id 를 같은 tx 에서 반환 → 즉시 flush
    const history = em.create(CardHistory, { card, action: 'CREATED', departmentCode });
    await this.historyRepo.save(history);
    return card.id;
  }

  @Transactional()
  async update(signature: string, channel: string, newDepartmentCode: string): Promise<void> {
    const em = this.ctx();
    const existing = await em.findOneOrFail(Card, { signature, channel });
    existing.departmentCode = newDepartmentCode;
    await this.cardRepo.save(existing); // Case1(멤버십) → dirty UPDATE
  }
}

/** roamings me/charger StatusNotificationHandler.applyStatusUpdate 미러 */
class StatusNotificationHandler {
  constructor(
    readonly em: EntityManager,
    private readonly chargerRepo: CommonsRepository<Charger>,
  ) {}
  private ctx(): EntityManager {
    return (this.em as any).getContext(false) as EntityManager;
  }

  @Transactional()
  async applyStatusUpdate(designedDeviceId: string, status: string): Promise<number> {
    const em = this.ctx();
    const rows = await em.find(Charger, { designedDeviceId });
    if (rows.length === 0) return 0;
    const statusAt = new Date();
    for (const row of rows) {
      row.status = status;
      row.statusAt = statusAt;
    }
    await this.chargerRepo.saveAll(rows); // load+mutate → Case1 배치 → dirty UPDATE
    return rows.length;
  }
}

/** roamings me/battery BatteryEncryptKeyWriterService 미러 (all-new saveAll) */
class BatteryKeyWriterService {
  constructor(
    readonly em: EntityManager,
    private readonly historyRepo: CommonsRepository<BatteryKeyHistory>,
  ) {}
  private ctx(): EntityManager {
    return (this.em as any).getContext(false) as EntityManager;
  }

  @Transactional()
  async recordKeys(rows: { chargerId: number; keyId: string }[]): Promise<number[]> {
    const em = this.ctx();
    const entities = rows.map((r) => em.create(BatteryKeyHistory, r));
    const saved = await this.historyRepo.saveAll(entities, { flush: true }); // id 를 같은 tx 에서 반환 → 즉시 flush
    return saved.map((e) => e.id);
  }
}

/** managements officials 생성 미러 — nested @Transactional + 스칼라 FK read-back (준공 탭 버그) */
class OfficialsService {
  constructor(
    readonly em: EntityManager,
    private readonly officialRepo: CommonsRepository<Official> | OldCommonsRepository<Official>,
    private readonly detailRepo: CommonsRepository<OfficialDetail> | OldCommonsRepository<OfficialDetail>,
  ) {}
  private ctx(): EntityManager {
    return (this.em as any).getContext(false) as EntityManager;
  }

  /** 시공 완료 → 준공 official + detail 생성. 마지막에 detail 을 부모 id 로 read-back(준공 탭 활성화). */
  @Transactional()
  async createWithDetail(
    name: string,
    content: string,
  ): Promise<{ officialId: number; detailFound: boolean }> {
    const em = this.ctx();
    const official = em.create(Official, { name });
    // 스칼라 FK 로 부모 id 를 같은 tx 에서 써야 함 → {flush:true}. OLD 는 이를 무시(버그 재현), FIXED 는 준수(치유).
    await this.officialRepo.save(official, { flush: true });

    // ⚠️ 스칼라 FK: 부모 id 를 "값"으로 복사 (OLD 는 이 시점 undefined → NULL 저장)
    const detail = em.create(OfficialDetail, { officialId: official.id, content });
    await this.detailRepo.save(detail);

    await em.flush(); // 남은 pending flush (OLD 는 여기서 official.id 확정 — 하지만 detail 은 이미 NULL)

    // "OfficialDetail for official(N) not found" — 준공 탭이 부모 id 로 detail 조회
    const found = await em.findOne(OfficialDetail, { officialId: official.id });
    return { officialId: official.id, detailFound: found !== null };
  }
}

// ===========================================================================
// 셋업
// ===========================================================================
let orm: Awaited<ReturnType<typeof MikroORM.init>>;
const sqlLog: string[] = [];
function queriesSince(mark: number): string[] {
  return sqlLog.slice(mark).map((q) => q.toLowerCase());
}

beforeAll(async () => {
  orm = await MikroORM.init({
    host: 'localhost',
    port: 3307,
    user: 'root',
    password: 'test',
    dbName: 'mikro_orm_test',
    entities: [
      cardSchema,
      cardHistorySchema,
      chargerSchema,
      batteryKeyHistorySchema,
      officialSchema,
      officialDetailSchema,
    ],
    discovery: { warnWhenNoEntities: false },
    allowGlobalContext: false,
    debug: ['query'],
    logger: (msg) => sqlLog.push(msg),
  });
  const conn = orm.em.getConnection();
  await conn.execute('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of [
    'repro_card_history',
    'repro_card',
    'repro_charger',
    'repro_battery_key_history',
    'repro_official_detail',
    'repro_official',
  ]) {
    await conn.execute(`DROP TABLE IF EXISTS \`${t}\``);
  }
  await conn.execute('SET FOREIGN_KEY_CHECKS = 1');
  await (orm as any).schema.create({ wrap: false });
});

afterAll(async () => {
  await orm.close(true);
});

beforeEach(async () => {
  const conn = orm.em.getConnection();
  await conn.execute('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of [
    'repro_card_history',
    'repro_card',
    'repro_charger',
    'repro_battery_key_history',
    'repro_official_detail',
    'repro_official',
  ]) {
    await conn.execute(`TRUNCATE TABLE \`${t}\``);
  }
  await conn.execute('SET FOREIGN_KEY_CHECKS = 1');
  sqlLog.length = 0;
});

function repo<T extends object>(schema: EntitySchema<T>): CommonsRepository<T> {
  return new CommonsRepository<T>(orm.em as unknown as EntityManager, schema);
}
function oldRepo<T extends object>(schema: EntitySchema<T>): OldCommonsRepository<T> {
  return new OldCommonsRepository<T>(orm.em as unknown as EntityManager, schema);
}

// ===========================================================================
describe('19. 실사용 패턴 × commons 최종본 (제네릭 BaseRepository)', () => {
  // -------------------------------------------------------------------------
  // A. roamings me/cards — CardWriterService
  // -------------------------------------------------------------------------
  describe('A. me/cards CardWriterService (save 단건: 관계 create / managed update)', () => {
    it('19-A1 create: 신규 카드 save → id 즉시 확보 + 관계 이력 FK 정확, upsert 없음', async () => {
      const em = orm.em as unknown as EntityManager;
      const service = new CardWriterService(em, repo(cardSchema), repo(cardHistorySchema));

      const mark = sqlLog.length;
      const cardId = await service.create('SIG-A1', 'CH1', 'DEPT-1');
      const qs = queriesSince(mark);

      expect(cardId).toBeGreaterThan(0); // FIXED Case2 flush → 부모 id 즉시 확보 (Spring parity)
      expect(qs.some((q) => q.includes('on duplicate key update'))).toBe(false); // 신규는 upsert 아님

      const verify = orm.em.fork();
      const history = await verify.findOneOrFail(CardHistory, { action: 'CREATED' }, { populate: ['card'] });
      expect(history.card.id).toBe(cardId); // 관계 FK 정확
    });

    it('19-A2 update: 로드된 managed 카드 save → dirty UPDATE(upsert 아님) + onUpdate 훅 작동', async () => {
      const em = orm.em as unknown as EntityManager;
      const service = new CardWriterService(em, repo(cardSchema), repo(cardHistorySchema));
      await service.create('SIG-A2', 'CH1', 'DEPT-1');

      const mark = sqlLog.length;
      await service.update('SIG-A2', 'CH1', 'DEPT-2');
      const qs = queriesSince(mark);

      expect(qs.some((q) => q.includes('on duplicate key update'))).toBe(false); // fork-split 오판 없음
      expect(qs.some((q) => q.includes('update `repro_card` set'))).toBe(true); // dirty UPDATE

      const verify = orm.em.fork();
      const row = await verify.findOneOrFail(Card, { signature: 'SIG-A2' });
      expect(row.departmentCode).toBe('DEPT-2');
      expect(row.updatedAt).not.toBeNull(); // dirty-flush 경로라 onUpdate 훅 작동 (upsert 였다면 null)
    });
  });

  // -------------------------------------------------------------------------
  // B. roamings me/charger — StatusNotification saveAll (load→mutate)
  // -------------------------------------------------------------------------
  describe('B. me/charger StatusNotificationHandler (saveAll: load→mutate→managed 배치)', () => {
    it('19-B1 status saveAll → 각 row dirty UPDATE, upsert 없음, onUpdate 훅 작동', async () => {
      // seed: 같은 designedDeviceId 에 커넥터 2개 (실제 externalType 별 공존 미러)
      const seed = orm.em.fork();
      seed.persist(seed.create(Charger, { designedDeviceId: 'DEV-B1', designedConnectorId: 1, status: 'Available' }));
      seed.persist(seed.create(Charger, { designedDeviceId: 'DEV-B1', designedConnectorId: 2, status: 'Available' }));
      await seed.flush();

      const em = orm.em as unknown as EntityManager;
      const handler = new StatusNotificationHandler(em, repo(chargerSchema));

      const mark = sqlLog.length;
      const n = await handler.applyStatusUpdate('DEV-B1', 'Charging');
      const qs = queriesSince(mark);

      expect(n).toBe(2);
      expect(qs.some((q) => q.includes('on duplicate key update'))).toBe(false); // 로드된 managed → upsert 아님
      expect(qs.some((q) => q.includes('update `repro_charger` set'))).toBe(true); // dirty UPDATE

      const verify = orm.em.fork();
      const rows = await verify.find(Charger, { designedDeviceId: 'DEV-B1' });
      expect(rows.every((r) => r.status === 'Charging')).toBe(true);
      expect(rows.every((r) => r.updatedAt !== null)).toBe(true); // onUpdate 훅 작동
    });
  });

  // -------------------------------------------------------------------------
  // C. roamings me/battery — all-new saveAll (Case2 배치)
  // -------------------------------------------------------------------------
  describe('C. me/battery BatteryKeyWriterService (saveAll: all-new 배치)', () => {
    it('19-C1 all-new saveAll → 모든 id 할당 + INSERT (upsert 아님), 루프 밖 flush 1회', async () => {
      const em = orm.em as unknown as EntityManager;
      const service = new BatteryKeyWriterService(em, repo(batteryKeyHistorySchema));

      const mark = sqlLog.length;
      const ids = await service.recordKeys([
        { chargerId: 101, keyId: 'K-1' },
        { chargerId: 102, keyId: 'K-2' },
        { chargerId: 103, keyId: 'K-3' },
      ]);
      const qs = queriesSince(mark);

      expect(ids).toHaveLength(3);
      expect(ids.every((id) => id > 0)).toBe(true); // 신규 배치도 id 확보
      expect(qs.some((q) => q.includes('insert into `repro_battery_key_history`'))).toBe(true);
      expect(qs.some((q) => q.includes('on duplicate key update'))).toBe(false); // 신규는 upsert 아님

      const verify = orm.em.fork();
      expect(await verify.count(BatteryKeyHistory, {})).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // D. managements officials — nested @Transactional + 스칼라 FK (준공 탭 버그)
  // -------------------------------------------------------------------------
  describe('D. managements officials nested @Transactional + 스칼라 FK (준공 탭 활성화)', () => {
    it('19-D1 [OLD 재현] 부모 save(no flush) → 부모 id undefined → 자식 officialId NULL → read-back 실패', async () => {
      const em = orm.em as unknown as EntityManager;
      const service = new OfficialsService(
        em,
        oldRepo(officialSchema),
        oldRepo(officialDetailSchema),
      );

      const result = await service.createWithDetail('오류동삼천리 준공', '준공 상세');

      expect(result.officialId).toBeGreaterThan(0); // 부모는 (outer flush 로) 결국 id 를 받지만
      expect(result.detailFound).toBe(false); // 자식 officialId 는 NULL 로 박혀 read-back 실패 = "not found"

      // 실제로 자식의 officialId 가 NULL 임을 확인
      const verify = orm.em.fork();
      const detail = await verify.findOneOrFail(OfficialDetail, { content: '준공 상세' });
      expect(detail.officialId ?? null).toBeNull();
    });

    it('19-D2 [FIXED 치유] 같은 흐름 → 부모 save 즉시 flush → 자식 officialId 유효 → read-back 성공', async () => {
      const em = orm.em as unknown as EntityManager;
      const service = new OfficialsService(em, repo(officialSchema), repo(officialDetailSchema));

      const result = await service.createWithDetail('오류동삼천리 준공', '준공 상세');

      expect(result.officialId).toBeGreaterThan(0);
      expect(result.detailFound).toBe(true); // 준공 탭 활성화 성공 (버그 해소)

      const verify = orm.em.fork();
      const detail = await verify.findOneOrFail(OfficialDetail, { content: '준공 상세' });
      expect(detail.officialId).toBe(result.officialId); // 스칼라 FK 정확
    });
  });
});
