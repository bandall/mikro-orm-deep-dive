import { EntityRepositoryType } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { LedgerRepository } from './ledger.repository';

/**
 * roamings InboundTradeEntity 미러.
 * - id: AUTO_INCREMENT PK (Postgres 의 GENERATED ALWAYS IDENTITY 대응)
 * - signature: 멱등 자연키 (= transactionCode). PK 아님 → findBySignature 는 항상 SELECT.
 * - status / registeredAt: markResult 가 갱신하는 값.
 */
@Entity({ tableName: 'repro_ledger', repository: () => LedgerRepository })
export class LedgerEntity {
  [EntityRepositoryType]?: LedgerRepository;

  @PrimaryKey({ autoincrement: true, type: 'number' })
  id!: number;

  @Property({ type: 'string', unique: true })
  signature!: string;

  @Property({ type: 'string' })
  status!: string;

  @Property({ type: 'datetime', nullable: true })
  registeredAt?: Date | null;

  /** roamings BaseEntity.updatedAt 미러 — onUpdate 훅. nativeUpdate 는 이걸 우회한다. */
  @Property({ type: 'datetime', nullable: true, onUpdate: () => new Date() })
  updatedAt?: Date | null;
}
