import { SetMetadata } from '@nestjs/common';
// eslint-disable-next-line no-restricted-imports -- 래퍼 데코레이터에서만 원본 직접 참조 허용
import { Transactional as MikroTransactional } from '@mikro-orm/decorators/legacy';
import type { TransactionOptions } from '@mikro-orm/core';

/**
 * @Transactional() 데코레이터가 적용된 클래스를 식별하기 위한 메타데이터 키.
 * TransactionalExplorer가 이 키를 통해 em 자동 주입 대상을 판별한다.
 */
export const TRANSACTIONAL_KEY = Symbol('TRANSACTIONAL');

/**
 * MikroORM @Transactional()의 래퍼 데코레이터.
 *
 * 원본 @Transactional()의 모든 기능을 그대로 유지하면서,
 * 클래스 레벨에 메타데이터를 추가하여 TransactionalExplorer가
 * em 주입 대상을 식별할 수 있게 한다.
 *
 * 사용법은 MikroORM @Transactional()과 동일:
 * ```
 * @Transactional()
 * async createUser(name: string) { ... }
 *
 * @Transactional({ readOnly: true })
 * async getUser(id: number) { ... }
 * ```
 */
export function Transactional(options?: TransactionOptions): MethodDecorator {
  return (target, propertyKey, descriptor) => {
    // 1) 클래스(prototype의 constructor)에 메타데이터 마킹
    SetMetadata(TRANSACTIONAL_KEY, true)(target.constructor);

    // 2) 원본 MikroORM @Transactional() 적용
    return MikroTransactional(options)(target, propertyKey, descriptor);
  };
}
