import { EntityRepositoryType, Collection, Cascade } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property, OneToMany } from '@mikro-orm/decorators/legacy';
import { BookEntity } from './book.entity';
import { AuthorRepository } from '../repositories/author.repository';

@Entity({ tableName: 'authors', repository: () => AuthorRepository })
export class AuthorEntity {
  [EntityRepositoryType]?: AuthorRepository;

  @PrimaryKey({ autoincrement: true })
  id!: number;

  @Property()
  name!: string;

  @Property({ nullable: true })
  email?: string;

  @Property({ nullable: true })
  createdAt?: Date;

  @OneToMany(() => BookEntity, (book) => book.author, { cascade: [Cascade.PERSIST, Cascade.REMOVE], orphanRemoval: true })
  books = new Collection<BookEntity>(this);
}
