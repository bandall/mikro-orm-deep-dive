import { Injectable } from '@nestjs/common';
import { Transactional } from '../transactional.decorator';
import { LedgerEntity } from './ledger.entity';
import { LedgerRepository } from './ledger.repository';
import { dumpState } from './em-state';

export type MarkMode = 'save-no-clear' | 'clear-then-save' | 'dirty-flush' | 'native-update';

/**
 * roamings InboundTradeService 미러.
 * recordPending(@Transactional) → (ME HTTP 가정) → markResult(@Transactional) 를
 * 하나의 RequestContext(EnsureRequestContext) 안에서 순차 호출하는 구조를 재현한다.
 *
 * em 은 constructor 에 주입하지 않는다 — TransactionalExplorer 가 @Transactional 클래스에
 * this.em 을 자동 주입한다 (UserService 와 동일 패턴, commons 런타임과 동일).
 */
@Injectable()
export class LedgerService {
  constructor(private readonly repo: LedgerRepository) {}

  /** 1단계: 멱등키(signature) PENDING 기록 — 신규 INSERT */
  @Transactional()
  async recordPending(signature: string): Promise<void> {
    const ctx = (this.repo.getEntityManager() as any).getContext(false);
    console.log(`\n--- recordPending() 진입: ctxEm=EM#${ctx._id} ---`);

    const existing = await this.repo.findBySignature(signature);
    if (existing) {
      console.log(dumpState('recordPending 재처리(existing)', existing, ctx));
      existing.status = 'PENDING';
      existing.registeredAt = null;
      return; // dirty-flush
    }

    const entity = this.repo.create({ signature, status: 'PENDING', registeredAt: null });
    console.log(dumpState('recordPending create 직후', entity, ctx));
    await this.repo.save(entity);
    console.log(dumpState('recordPending save 직후', entity, ctx));
    // @Transactional 커밋 시 flush → INSERT, 그리고 mergeEntitiesToParent → entity.__em = EM_req
  }

  /** 2단계: ME 등록 결과 반영 — SENT 면 registeredAt 기록 */
  @Transactional()
  async markResult(signature: string, mode: MarkMode): Promise<void> {
    const ctx = (this.repo.getEntityManager() as any).getContext(false);
    console.log(`\n--- markResult(mode=${mode}) 진입: ctxEm=EM#${ctx._id} ---`);

    if (mode === 'native-update') {
      // find 불필요 — 자연키로 직접 UPDATE. UnitOfWork/identity map/onUpdate 훅 모두 우회.
      const affected = await this.repo
        .getEntityManager()
        .nativeUpdate(LedgerEntity, { signature }, { status: 'SENT', registeredAt: new Date() });
      console.log(`   [native-update] nativeUpdate 실행 — affected=${affected} (updatedAt onUpdate 훅 우회됨)`);
      return;
    }

    if (mode === 'clear-then-save') {
      console.log('   [clear] em.clear() 호출 — identity map 비움');
      this.repo.getEntityManager().clear();
    }

    const existing = await this.repo.findBySignature(signature);
    if (!existing) {
      console.log('   markResult: existing 없음 → return');
      return;
    }
    console.log(dumpState('markResult find 직후', existing, ctx));

    existing.status = 'SENT';
    existing.registeredAt = new Date();

    if (mode === 'dirty-flush') {
      console.log('   [dirty-flush] save() 호출 안 함 — 커밋 시 UnitOfWork change-set 이 UPDATE');
      return;
    }

    console.log('   [save] repo.save(existing) 호출');
    await this.repo.save(existing);
    console.log(dumpState('markResult save 직후', existing, ctx));
  }
}
