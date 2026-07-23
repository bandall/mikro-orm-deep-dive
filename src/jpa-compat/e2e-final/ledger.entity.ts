import { EntityRepositoryType } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { LedgerRepository } from './ledger.repository';

/** roamings me/cards·inbound-trade 류 원장 미러 (e2e) */
@Entity({ tableName: 'e2e_ledger', repository: () => LedgerRepository })
export class LedgerEntity {
  [EntityRepositoryType]?: LedgerRepository;

  @PrimaryKey({ autoincrement: true })
  id!: number;

  @Property()
  signature!: string;

  @Property()
  status!: string;

  /** onUpdate 훅 — dirty UPDATE 경로만 갱신, upsert/nativeUpdate 는 우회 */
  @Property({ nullable: true, onUpdate: () => new Date() })
  updatedAt?: Date;
}
