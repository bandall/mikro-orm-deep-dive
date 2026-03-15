import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';

/**
 * Spring @Service + @Transactional 사용감을 제공하는 추상 서비스.
 *
 * 이 클래스를 상속하면 @Transactional() 데코레이터가 자동으로 em을 찾는다.
 * MikroORM v7에서 @Transactional()은 this.em 또는 this.orm 프로퍼티를 요구하는데,
 * NestJS의 @Inject() 프로퍼티 주입을 활용해 자동 해결한다.
 */
@Injectable()
export abstract class TransactionalService {
  @Inject(EntityManager)
  readonly em!: EntityManager;
}
