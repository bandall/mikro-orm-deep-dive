import { EntityRepository, FilterQuery, Primary, helper } from '@mikro-orm/core';
import { Transactional } from '@mikro-orm/decorators/legacy';

/**
 * Spring JPA의 JpaRepository에 대응하는 BaseRepository.
 *
 * 핵심 설계:
 * - @Transactional()로 단독 호출 시 자체 트랜잭션, 바깥 트랜잭션 있으면 참여 (REQUIRED)
 * - save()는 엔티티 상태를 자동 판단: new → INSERT, managed → UPDATE, detached → merge+UPDATE
 */
export class BaseRepository<T extends object> extends EntityRepository<T> {
  /**
   * JPA save() — 엔티티 상태에 따라 적절한 전략을 선택한다.
   *
   * | 상태                    | 동작                                    |
   * |-------------------------|----------------------------------------|
   * | New (PK 없음)           | persist → INSERT                       |
   * | New (수동 PK)           | persist → INSERT                       |
   * | Managed (같은 EM)       | no-op → dirty checking UPDATE          |
   * | Detached (다른 EM)      | upsert → UPDATE                        |
   */
  @Transactional()
  async save(entity: T): Promise<T> {
    const em = this.em;
    const wrapped = helper(entity);

    // Case 1: 이미 이 EM에서 managed → dirty checking에 맡김
    if (wrapped.__managed && wrapped.__em === em) {
      return entity;
    }

    // Case 2: PK 없음 → 새 엔티티
    if (!wrapped.hasPrimaryKey()) {
      em.persist(entity);
      return entity;
    }

    // Case 3: PK 있고, DB에서 로드된 적 있음 (detached) → upsert
    // MikroORM의 merge()는 __originalEntityData를 현재 값으로 덮어쓰므로
    // dirty checking이 동작하지 않음. upsert로 DB에 직접 반영한다.
    if (wrapped.__originalEntityData) {
      return await em.upsert(this.entityName, entity as any) as T;
    }

    // Case 4: PK 있고, DB에서 로드된 적 없음 → 새 엔티티 (수동 PK)
    em.persist(entity);
    return entity;
  }

  /**
   * JPA saveAll()
   */
  @Transactional()
  async saveAll(entities: T[]): Promise<T[]> {
    return Promise.all(entities.map(async (entity) => {
      const wrapped = helper(entity);
      if (wrapped.__managed && wrapped.__em === this.em) return entity;
      if (!wrapped.hasPrimaryKey()) { this.em.persist(entity); return entity; }
      if (wrapped.__originalEntityData) return await this.em.upsert(this.entityName, entity as any) as T;
      this.em.persist(entity);
      return entity;
    }));
  }

  /**
   * JPA findById()
   */
  async findById(id: Primary<T>): Promise<T | null> {
    return this.findOne(id as FilterQuery<T>);
  }

  /**
   * JPA findById() — 없으면 에러
   */
  async findByIdOrFail(id: Primary<T>): Promise<T> {
    return this.findOneOrFail(id as FilterQuery<T>);
  }

  /**
   * JPA existsById()
   */
  async existsById(id: Primary<T>): Promise<boolean> {
    const count = await this.count(id as FilterQuery<T>);
    return count > 0;
  }

  /**
   * JPA deleteById()
   */
  async deleteById(id: Primary<T>): Promise<void> {
    const entity = await this.findOneOrFail(id as FilterQuery<T>);
    this.em.remove(entity);
    await this.em.flush();
  }

  /**
   * JPA delete(entity)
   */
  async delete(entity: T): Promise<void> {
    this.em.remove(entity);
    await this.em.flush();
  }

  /**
   * JPA deleteAll() — 여러 엔티티를 한 번의 flush로 삭제.
   * delete()를 N번 호출하면 flush N번이지만, 이 메서드는 flush 1번.
   */
  async deleteAll(entities: T[]): Promise<void> {
    for (const entity of entities) {
      this.em.remove(entity);
    }
    await this.em.flush();
  }

  /**
   * ID 배열로 벌크 삭제 — 단일 DELETE WHERE id IN (...) 쿼리.
   * Identity Map과 동기화되지 않으므로 주의.
   */
  async deleteAllByIds(ids: Primary<T>[]): Promise<number> {
    return this.nativeDelete({ id: { $in: ids } } as any);
  }
}
