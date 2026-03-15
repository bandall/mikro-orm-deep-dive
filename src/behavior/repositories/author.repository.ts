import { EntityRepository } from '@mikro-orm/mysql';
import { Transactional } from '@mikro-orm/decorators/legacy';
import { AuthorEntity } from '../entities/author.entity';

export class AuthorRepository extends EntityRepository<AuthorEntity> {
  @Transactional()
  async save(entity: AuthorEntity): Promise<void> {
    this.em.persist(entity);
  }
}
