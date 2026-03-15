import { EntityRepository } from '@mikro-orm/mysql';
import { BookEntity } from '../entities/book.entity';

export class BookRepository extends EntityRepository<BookEntity> {}
