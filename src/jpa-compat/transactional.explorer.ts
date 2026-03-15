import { Injectable, OnModuleInit } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { EntityManager } from '@mikro-orm/core';
import { TRANSACTIONAL_KEY } from './transactional.decorator';

/**
 * @Transactional() 데코레이터를 사용하는 프로바이더에만 EntityManager를 자동 주입하는 Explorer.
 *
 * MikroORM v7의 @Transactional() 데코레이터는 this.em 또는 this.orm 프로퍼티를 요구한다.
 * Spring JPA는 AOP 프록시를 통해 자동으로 해결하지만, MikroORM은 그렇지 않다.
 *
 * 감지 방식: 커스텀 @Transactional() 래퍼 데코레이터가 클래스에 TRANSACTIONAL_KEY 메타데이터를
 * 설정하고, 이 Explorer가 Reflector를 통해 해당 메타데이터를 감지한다.
 *
 * 효과: 서비스에서 em을 constructor에 넣지 않아도 @Transactional() 사용 가능.
 */
@Injectable()
export class TransactionalExplorer implements OnModuleInit {
  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly reflector: Reflector,
    private readonly em: EntityManager,
  ) {}

  onModuleInit(): void {
    const providers = this.discoveryService.getProviders();

    for (const wrapper of providers) {
      const { instance } = wrapper;

      if (!instance || typeof instance !== 'object') continue;

      // 이미 em이 있는 경우 (직접 주입했거나 EntityRepository) 건너뜀
      if ((instance as any).em) continue;

      // Reflector로 TRANSACTIONAL_KEY 메타데이터 확인
      const hasTransactional = this.reflector.get(
        TRANSACTIONAL_KEY,
        instance.constructor,
      );
      if (!hasTransactional) continue;

      Object.defineProperty(instance, 'em', {
        value: this.em,
        writable: false,
        enumerable: false,
        configurable: true,
      });
    }
  }
}
