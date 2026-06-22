import { Injectable } from '@nestjs/common';
import { EntityManager, RequestContext } from '@mikro-orm/core';
import { EnsureRequestContext } from '@mikro-orm/decorators/legacy';
import { LedgerService, MarkMode } from './ledger.service';

/**
 * roamings EventsSqsConsumer 미러.
 * handleMessage 에 @EnsureRequestContext() → 메시지마다 RequestContext(EM_req fork) 생성.
 * 그 안에서 recordPending → markResult 를 순차 호출(사이에 ME HTTP 가정).
 */
@Injectable()
export class LedgerConsumer {
  // @EnsureRequestContext 가 resolve 할 em (commons 컨슈머와 동일하게 주입)
  constructor(
    private readonly em: EntityManager,
    private readonly service: LedgerService,
  ) {}

  @EnsureRequestContext()
  async handleMessage(signature: string, mode: MarkMode): Promise<void> {
    const reqEm = (this.em as any).getContext(false);
    console.log(`\n===== handleMessage 진입: RequestContext EM#${reqEm._id} (RC active=${!!RequestContext.currentRequestContext()}) =====`);

    await this.service.recordPending(signature);
    // --- 실제로는 여기서 ME HTTP 호출(트랜잭션 밖) ---
    await this.service.markResult(signature, mode);

    const reqEm2 = (this.em as any).getContext(false);
    console.log(`===== handleMessage 종료: RequestContext EM#${reqEm2._id} =====\n`);
  }
}
