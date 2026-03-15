import { Injectable } from '@nestjs/common';
import { Transactional } from '@mikro-orm/decorators/legacy';
import { EntityManager } from '@mikro-orm/mysql';
import { AuthorEntity } from '../entities/author.entity';
import { AuthorRepository } from '../repositories/author.repository';
import { InnerService } from './inner.service';

@Injectable()
export class OuterService {
  constructor(
    readonly em: EntityManager,
    private readonly authorRepo: AuthorRepository,
    private readonly innerService: InnerService,
  ) {}

  @Transactional()
  async createWithInner(outerName: string, innerName: string): Promise<void> {
    const outer = this.authorRepo.create({ name: outerName });
    this.authorRepo.getEntityManager().persist(outer);
    await this.innerService.createAuthor(innerName);
  }

  @Transactional()
  async createWithInnerThrow(outerName: string, innerName: string): Promise<void> {
    const outer = this.authorRepo.create({ name: outerName });
    this.authorRepo.getEntityManager().persist(outer);
    await this.innerService.createAuthorAndThrow(innerName);
  }

  @Transactional()
  async createAndThrow(name: string): Promise<void> {
    const author = this.authorRepo.create({ name });
    this.authorRepo.getEntityManager().persist(author);
    await this.authorRepo.getEntityManager().flush();
    throw new Error('Outer error');
  }

  @Transactional()
  async createWithAutoFlush(name: string): Promise<void> {
    const author = this.authorRepo.create({ name });
    this.authorRepo.getEntityManager().persist(author);
    // flush 없이 메서드 종료 → auto flush
  }

  async createWithoutTransaction(name: string): Promise<void> {
    const em = this.authorRepo.getEntityManager();
    const author = this.authorRepo.create({ name });
    em.persist(author);
    // flush도 트랜잭션도 없음
  }

  async createWithManualFlush(name: string): Promise<void> {
    const em = this.authorRepo.getEntityManager();
    const author = this.authorRepo.create({ name });
    em.persist(author);
    await em.flush();
  }

  @Transactional()
  async saveWithRepo(entity: AuthorEntity): Promise<void> {
    await this.authorRepo.save(entity);
  }

  /**
   * Inner @Transactional() 예외를 catch로 삼킴.
   * Spring이라면 rollback-only 마킹 → UnexpectedRollbackException.
   * MikroORM은?
   */
  @Transactional()
  async createWithInnerCatch(outerName: string, innerName: string): Promise<void> {
    const outer = this.authorRepo.create({ name: outerName });
    this.authorRepo.getEntityManager().persist(outer);

    try {
      await this.innerService.createAuthorAndThrow(innerName);
    } catch {
      // 예외를 삼킴 — Spring이라면 이래도 rollback됨
    }
    // MikroORM은 여기까지 정상 도달 → commit 시도
  }

  /**
   * Inner 성공 후 Outer에서 throw → 전파
   * Inner가 성공적으로 persist한 데이터도 rollback되는가?
   */
  @Transactional()
  async createWithInnerSuccessThenOuterThrow(
    outerName: string,
    innerName: string,
  ): Promise<void> {
    const outer = this.authorRepo.create({ name: outerName });
    this.authorRepo.getEntityManager().persist(outer);

    await this.innerService.createAuthor(innerName); // 성공

    throw new Error('Outer error after inner success');
  }

  /**
   * Inner 성공 후 Outer 내부에서 try-catch로 자체 에러 처리
   */
  @Transactional()
  async createWithInnerSuccessThenOuterCatch(
    outerName: string,
    innerName: string,
  ): Promise<void> {
    const outer = this.authorRepo.create({ name: outerName });
    this.authorRepo.getEntityManager().persist(outer);

    await this.innerService.createAuthor(innerName); // 성공

    try {
      throw new Error('Outer internal error');
    } catch {
      // Outer 자체에서 catch — TX 래퍼는 이 예외를 보지 못함
    }
  }

  /**
   * Inner에서 flush + throw → outer에서 catch 후 다른 엔티티 persist.
   * inner가 flush한 데이터는 어떻게 되는가?
   */
  @Transactional()
  async createWithInnerCatchAndContinue(
    outerName: string,
    innerName: string,
    recoveryName: string,
  ): Promise<void> {
    const outer = this.authorRepo.create({ name: outerName });
    this.authorRepo.getEntityManager().persist(outer);

    try {
      await this.innerService.createAuthorAndThrow(innerName);
    } catch {
      // inner 실패 → recovery 데이터 추가
      const recovery = this.authorRepo.create({ name: recoveryName });
      this.authorRepo.getEntityManager().persist(recovery);
    }
  }
}
