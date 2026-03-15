import { Injectable } from '@nestjs/common';
import { Transactional } from '@mikro-orm/decorators/legacy';
import { EntityManager } from '@mikro-orm/mysql';
import { AuthorEntity } from '../entities/author.entity';
import { AuthorRepository } from '../repositories/author.repository';

@Injectable()
export class InnerService {
  constructor(
    readonly em: EntityManager,
    private readonly authorRepo: AuthorRepository,
  ) {}

  @Transactional()
  async createAuthor(name: string): Promise<AuthorEntity> {
    const author = this.authorRepo.create({ name });
    this.authorRepo.getEntityManager().persist(author);
    return author;
  }

  @Transactional()
  async createAuthorAndThrow(name: string): Promise<void> {
    const author = this.authorRepo.create({ name });
    this.authorRepo.getEntityManager().persist(author);
    await this.authorRepo.getEntityManager().flush();
    throw new Error('Inner error');
  }
}
