import { Injectable } from '@nestjs/common';
import { Transactional } from '../transactional.decorator';
import { UserEntity } from '../entities/user.entity';
import { UserRepository } from '../repositories/user.repository';
import { UserService } from './user.service';

/**
 * 서비스 간 트랜잭션 전파 테스트용.
 * em을 constructor에 주입하지 않음 — Explorer가 자동 주입.
 */
@Injectable()
export class OrderService {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly userService: UserService,
  ) {}

  // Outer @Transactional → Inner @Transactional (UserService.createUser)
  @Transactional()
  async createOrderWithUser(userName: string): Promise<void> {
    await this.userService.createUser(userName);
    // 추가 작업 (여기서는 생략)
  }

  // Outer @Transactional → Inner 예외 → 전체 rollback
  @Transactional()
  async createOrderWithUserThrow(userName: string): Promise<void> {
    this.userRepo.create({ name: 'Order Owner' });
    await this.userService.createUserAndThrow(userName);
  }
}
