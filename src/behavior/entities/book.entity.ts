import { EntityRepositoryType } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property, ManyToOne } from '@mikro-orm/decorators/legacy';
import { AuthorEntity } from './author.entity';
import { BookRepository } from '../repositories/book.repository';

@Entity({ tableName: 'books', repository: () => BookRepository })
export class BookEntity {
  [EntityRepositoryType]?: BookRepository;

  @PrimaryKey({ autoincrement: true })
  id!: number;

  @Property()
  title!: string;

  @Property({ nullable: true })
  status?: string;

  @ManyToOne(() => AuthorEntity)
  author!: AuthorEntity;

  @Property({ nullable: true })
  createdAt?: Date;
}
