import { EntityManager, EntityRepository, helper, wrap } from '@mikro-orm/core';
import { Transactional } from '../transactional.decorator';

export interface SaveOptions {
  /** true 면 저장 직후 즉시 flush (id/부수효과가 같은 tx 에서 필요할 때). 기본 false = 커밋 시 일괄 flush. */
  flush?: boolean;
}

/**
 * pluglink-commons `src/database/mikro-orm/base.repository.ts` **최종본** verbatim 미러.
 * (e2e: 실제 NestJS DI + RequestContext 미들웨어 + TransactionalExplorer 배선으로 태우기 위한 소스)
 */
export class FinalBaseRepository<T extends object> extends EntityRepository<T> {
  private ctx(): EntityManager {
    return (this.em as any).getContext(false) as EntityManager;
  }

  private isManagedHere(em: EntityManager, entity: T): boolean {
    const wrapped = helper(entity);
    if (!wrapped.isManaged() || !wrapped.hasPrimaryKey()) return false;
    return (
      em
        .getUnitOfWork()
        .getById(
          this.entityName as never,
          wrapped.getPrimaryKey() as never,
          wrapped.getSchema(),
        ) === entity
    );
  }

  private warnDetached(): void {
    this.em
      .config.getLogger()
      .warn(
        'info',
        `save(): detached 엔티티(${String(this.entityName)}) upsert 경로 — IDENTITY 테이블이면 크래시/full-replace 위험.`,
      );
  }

  private route(em: EntityManager, entity: T): T {
    const wrapped = helper(entity);
    if (this.isManagedHere(em, entity)) return entity; // Case1
    if (!wrapped.hasPrimaryKey()) {
      em.persist(entity); // Case2
      return entity;
    }
    if ((wrapped as { __originalEntityData?: unknown }).__originalEntityData) {
      this.warnDetached();
      return em.upsert(this.entityName as never, entity as never) as unknown as T; // Case3
    }
    em.persist(entity); // Case4: 수동 PK persist (프로덕션 동일). autoincrement 오용은 리뷰서 차단.
    return entity;
  }

  @Transactional()
  async save(entity: T, opts?: SaveOptions): Promise<T> {
    const em = this.ctx();
    const result = this.route(em, entity);
    if (opts?.flush) await em.flush();
    return result;
  }

  @Transactional()
  async saveAll(entities: T[], opts?: SaveOptions): Promise<T[]> {
    const em = this.ctx();
    const results = entities.map((entity) => this.route(em, entity));
    if (opts?.flush) await em.flush();
    return results;
  }

  async delete(entity: T): Promise<void> {
    wrap(entity).assign({ isDeleted: true } as never);
    await this.em.flush();
  }
}
