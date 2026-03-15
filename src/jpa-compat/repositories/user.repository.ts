import { BaseRepository } from '../base.repository';
import { UserEntity } from '../entities/user.entity';

export class UserRepository extends BaseRepository<UserEntity> {
  async findByName(name: string): Promise<UserEntity | null> {
    return this.findOne({ name });
  }
}
