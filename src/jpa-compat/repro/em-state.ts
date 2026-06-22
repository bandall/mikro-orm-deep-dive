import { helper } from '@mikro-orm/core';

/**
 * 엔티티의 영속성 상태를 한 줄로 덤프한다.
 * - emId: 엔티티가 소속됐다고 믿는 EM(__em)의 fork 고유 id
 * - ctxId: 현재 트랜잭션 컨텍스트 EM 의 fork 고유 id (save 분기 비교 대상)
 * - managed / hasPK / hasOriginalData: save() Case 판별에 쓰이는 3대 플래그
 * - sameEm: __em === 현재 컨텍스트 EM (Case 1 통과 조건)
 */
export function dumpState(label: string, entity: any, ctxEm?: any): string {
  const w = helper(entity);
  const emId = (w as any).__em?._id ?? 'null';
  const ctxId = ctxEm ? ctxEm._id : '—';
  const sameEm = ctxEm ? (w as any).__em === ctxEm : '—';
  const branch = decideBranch(w, ctxEm);
  return [
    `[STATE] ${label}`,
    `  managed=${w.__managed}`,
    `hasPK=${w.hasPrimaryKey()}`,
    `hasOriginalData=${!!(w as any).__originalEntityData}`,
    `__em=EM#${emId}`,
    `ctxEm=EM#${ctxId}`,
    `sameEm=${sameEm}`,
    `→ save()=${branch}`,
  ].join('  ');
}

/** commons save() 의 분기를 그대로 모사하여 어느 Case 를 탈지 예측한다. */
function decideBranch(w: any, ctxEm?: any): string {
  if (!ctxEm) return '?(no ctx)';
  if (w.__managed && w.__em === ctxEm) return 'Case1(dirty UPDATE)';
  if (!w.hasPrimaryKey()) return 'Case2(persist INSERT)';
  if (w.__originalEntityData) return 'Case3(UPSERT → PG IDENTITY 에러)';
  return 'Case4(persist 수동PK)';
}
