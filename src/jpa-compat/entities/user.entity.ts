import { EntityRepositoryType, Collection, Cascade } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property, OneToMany } from '@mikro-orm/decorators/legacy';
import { PostEntity } from './post.entity';
import { UserRepository } from '../repositories/user.repository';

@Entity({ tableName: 'jpa_users', repository: () => UserRepository })
export class UserEntity {
  [EntityRepositoryType]?: UserRepository;

  @PrimaryKey({ autoincrement: true })
  id!: number;

  @Property()
  name!: string;

  @Property({ nullable: true })
  email?: string;

  @Property({ nullable: true })
  age?: number;

  @OneToMany(() => PostEntity, (post) => post.user, {
    cascade: [Cascade.PERSIST, Cascade.REMOVE],
    orphanRemoval: true,
  })
  posts = new Collection<PostEntity>(this);
}
