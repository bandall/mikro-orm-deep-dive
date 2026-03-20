import { Injectable } from '@nestjs/common';
import { Transactional } from '../transactional.decorator';
import { UserEntity } from '../entities/user.entity';
import { UserRepository } from '../repositories/user.repository';

/**
 * em을 constructor에 주입하지 않은 서비스.
 * TransactionalExplorer가 자동으로 em을 주입해주므로 @Transactional() 동작.
 */
@Injectable()
export class UserService {
  constructor(private readonly userRepo: UserRepository) {}

  // em 없이 @Transactional() — Explorer가 해결
  @Transactional()
  async createUser(name: string, email?: string): Promise<UserEntity> {
    return this.userRepo.create({ name, email });
  }

  // em 없이 @Transactional() — 예외 시 rollback
  @Transactional()
  async createUserAndThrow(name: string): Promise<void> {
    this.userRepo.create({ name });
    throw new Error('Rollback test');
  }

  // @Transactional() 없이 — save()의 자체 트랜잭션에 의존
  async createUserWithSave(name: string): Promise<UserEntity> {
    const user = this.userRepo.create({ name });
    return this.userRepo.save(user);
  }

  // @Transactional() 안에서 delete 후 throw → rollback 테스트
  @Transactional()
  async deleteUserAndThrow(id: number): Promise<void> {
    await this.userRepo.deleteById(id);
    throw new Error('Rollback after delete');
  }

  // DI 주입 레포지토리로 load + save — Case 1 (dirty checking) 검증용
  @Transactional()
  async loadAndUpdateUser(id: number, name: string): Promise<UserEntity> {
    const user = await this.userRepo.findOneOrFail(id);
    user.name = name;
    return this.userRepo.save(user);
  }

  // save() 호출 없이 필드 수정만 — dirty checking으로 UPDATE 되는지 검증용
  @Transactional()
  async loadAndMutateWithoutSave(id: number, name: string): Promise<void> {
    const user = await this.userRepo.findOneOrFail(id);
    user.name = name;
    // save() 호출 없음 — @Transactional() flush 시 dirty checking이 UPDATE 발행해야 함
  }
}
