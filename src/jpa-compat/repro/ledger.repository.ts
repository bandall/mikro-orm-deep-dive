import { EntityRepository, helper } from '@mikro-orm/core';
import { Transactional } from '../transactional.decorator';
import { LedgerEntity } from './ledger.entity';
import { dumpState } from './em-state';

/**
 * @plug-link/commons BaseRepository.save() 를 그대로 복제한 리포지토리.
 *
 * commons dist/database/mikro-orm/base.repository.js 의 save() 와 분기/순서가 동일:
 *   Case1 __managed && __em===ctxEm → return (dirty)
 *   Case2 !hasPrimaryKey            → persist
 *   Case3 __originalEntityData      → em.upsert(entityName, entity)   ← 버그 지점
 *   Case4                           → persist (수동 PK)
 * save 자체가 @Transactional (commons 와 동일).
 */
export class LedgerRepository extends EntityRepository<LedgerEntity> {
  async findBySignature(signature: string): Promise<LedgerEntity | null> {
    return this.findOne({ signature });
  }

  @Transactional()
  async save(entity: LedgerEntity): Promise<LedgerEntity> {
    const em = (this.em as any).getContext(false) as typeof this.em;
    const wrapped = helper(entity);

    console.log(dumpState('save() 진입', entity, em));

    // Case 1: 이미 이 EM 에서 managed → dirty checking
    if (wrapped.__managed && (wrapped as any).__em === em) {
      console.log('       → Case1: managed, dirty checking 위임 (쿼리 없음, 커밋 시 UPDATE)');
      return entity;
    }

    // Case 2: PK 없음 → 새 엔티티
    if (!wrapped.hasPrimaryKey()) {
      console.log('       → Case2: persist (INSERT)');
      em.persist(entity);
      return entity;
    }

    // Case 3: detached → upsert (commons 원본). Postgres GENERATED ALWAYS 에선 INSERT(id) 거부.
    if ((wrapped as any).__originalEntityData) {
      console.log('       → Case3: em.upsert() — INSERT..ON CONFLICT(id 포함). PG 라면 여기서 IDENTITY 에러');
      return (await em.upsert(LedgerEntity, entity)) as LedgerEntity;
    }

    // Case 4: 수동 PK
    console.log('       → Case4: persist (수동 PK)');
    em.persist(entity);
    return entity;
  }
}
