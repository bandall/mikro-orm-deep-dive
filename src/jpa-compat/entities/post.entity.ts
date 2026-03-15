import { EntityRepositoryType } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property, ManyToOne } from '@mikro-orm/decorators/legacy';
import { UserEntity } from './user.entity';
import { PostRepository } from '../repositories/post.repository';

@Entity({ tableName: 'jpa_posts', repository: () => PostRepository })
export class PostEntity {
  [EntityRepositoryType]?: PostRepository;

  @PrimaryKey({ autoincrement: true })
  id!: number;

  @Property()
  title!: string;

  @Property({ nullable: true })
  content?: string;

  @ManyToOne(() => UserEntity)
  user!: UserEntity;
}
