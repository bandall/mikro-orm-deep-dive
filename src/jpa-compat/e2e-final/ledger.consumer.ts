import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { EnsureRequestContext } from '@mikro-orm/decorators/legacy';
import { LedgerService } from './ledger.service';

/**
 * roamings SQS 컨슈머 미러 — 메시지 1건을 @EnsureRequestContext 로 감싸 RequestContext(EM_req) 생성.
 * (HTTP 미들웨어가 없는 SQS 환경에서 요청 스코프를 만드는 실제 방식)
 *
 * em 을 주입받아야 @EnsureRequestContext 가 컨텍스트를 해소할 수 있다 (프로덕션 컨슈머와 동일).
 */
@Injectable()
export class LedgerConsumer {
  constructor(
    readonly em: EntityManager, // @EnsureRequestContext 가 리플렉션으로 사용 (컨텍스트 해소)
    private readonly service: LedgerService,
  ) {}

  @EnsureRequestContext()
  async handle(signature: string): Promise<void> {
    await this.service.recordPending(signature); // @Transactional #1 (tx fork P)
    // --- 실제로는 여기서 ME HTTP 호출 (tx 밖) ---
    await this.service.markSent(signature); // @Transactional #2 (tx fork M) — load+save
  }
}
