import { EntityRepositoryType } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { LedgerStepRepository } from './ledger-step.repository';

/** managements officials 자식(스칼라 FK) 미러 (e2e) */
@Entity({ tableName: 'e2e_ledger_step', repository: () => LedgerStepRepository })
export class LedgerStepEntity {
  [EntityRepositoryType]?: LedgerStepRepository;

  @PrimaryKey({ autoincrement: true })
  id!: number;

  /** 부모 id 를 "값"으로 복사하는 스칼라 FK (준공 탭 버그 형태) */
  @Property({ nullable: true })
  ledgerId?: number;

  @Property()
  label!: string;
}
