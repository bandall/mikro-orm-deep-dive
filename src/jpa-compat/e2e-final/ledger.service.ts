import { Injectable } from '@nestjs/common';
import { Transactional } from '../transactional.decorator';
import { LedgerEntity } from './ledger.entity';
import { LedgerRepository } from './ledger.repository';
import { LedgerStepRepository } from './ledger-step.repository';

/**
 * em 을 constructor 에 안 넣음 — TransactionalExplorer 가 자동 주입 (프로덕션 서비스와 동일 조건).
 * @Transactional 은 commons 래퍼(../transactional.decorator) — 실 배선과 동일.
 */
@Injectable()
export class LedgerService {
  constructor(
    private readonly ledgerRepo: LedgerRepository,
    private readonly stepRepo: LedgerStepRepository,
  ) {}

  /** HTTP POST — 신규 생성. Case2 flush 로 응답 전 id 확보 (Spring parity). */
  @Transactional()
  async create(signature: string): Promise<LedgerEntity> {
    const ledger = this.ledgerRepo.create({ signature, status: 'PENDING' });
    await this.ledgerRepo.save(ledger);
    return ledger;
  }

  /** HTTP POST — 부모+자식(스칼라 FK) nested @Transactional (officials 준공 패턴). */
  @Transactional()
  async createWithStep(signature: string): Promise<{ ledgerId: number; stepLinked: boolean }> {
    const ledger = this.ledgerRepo.create({ signature, status: 'PENDING' });
    await this.ledgerRepo.save(ledger, { flush: true }); // 스칼라 FK 로 부모 id 를 같은 tx 에서 써야 함 → 즉시 flush
    const step = this.stepRepo.create({ ledgerId: ledger.id, label: 'step-1' });
    await this.stepRepo.save(step);
    const found = await this.stepRepo.findOne({ ledgerId: ledger.id });
    return { ledgerId: ledger.id, stepLinked: found !== null };
  }

  /** HTTP POST — 생성 후 throw → 롤백 (원자성). */
  @Transactional()
  async createThenThrow(signature: string): Promise<void> {
    const ledger = this.ledgerRepo.create({ signature, status: 'PENDING' });
    await this.ledgerRepo.save(ledger);
    throw new Error('force rollback (http)');
  }

  /** HTTP PATCH — @Transactional 안에서 로드+수정+save (Case1 in-tx). */
  @Transactional()
  async updateInTx(id: number, status: string): Promise<void> {
    const ledger = await this.ledgerRepo.findOneOrFail(id);
    ledger.status = status;
    await this.ledgerRepo.save(ledger);
  }

  /**
   * HTTP PATCH — users.upsertCredential 패턴 미러:
   * @Transactional **없이** 요청 컨텍스트(EM_req)에서 로드·수정한 뒤,
   * @Transactional 이 붙은 repo.save() 하나만 호출 → save 가 자체 tx fork 를 만든다(fork-split).
   * OLD 라면 __em(EM_req) != tx-fork em → Case3 upsert(+훅 우회). FIXED 는 멤버십으로 dirty UPDATE.
   */
  async updateOutsideTx(id: number, status: string): Promise<void> {
    const ledger = await this.ledgerRepo.findOne(id); // EM_req 에서 로드 (tx 아님)
    if (!ledger) return;
    ledger.status = status;
    await this.ledgerRepo.save(ledger); // @Transactional → tx fork
  }

  // --- SQS(@EnsureRequestContext) 아래 형제 @Transactional 2개 ---
  @Transactional()
  async recordPending(signature: string): Promise<void> {
    const ledger = this.ledgerRepo.create({ signature, status: 'PENDING' });
    await this.ledgerRepo.save(ledger);
  }

  @Transactional()
  async markSent(signature: string): Promise<void> {
    const ledger = await this.ledgerRepo.findOneOrFail({ signature });
    ledger.status = 'SENT';
    await this.ledgerRepo.save(ledger);
  }
}
