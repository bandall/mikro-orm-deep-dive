import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { UserService } from '../services/user.service';
import { UserRepository } from '../repositories/user.repository';
import { UserEntity } from '../entities/user.entity';

@Controller('users')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly userRepo: UserRepository,
  ) {}

  @Get()
  findAll(): Promise<UserEntity[]> {
    return this.userRepo.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number): Promise<UserEntity | null> {
    return this.userRepo.findById(id);
  }

  @Post()
  create(@Body() body: { name: string; email?: string }): Promise<UserEntity> {
    return this.userService.createUser(body.name, body.email);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { name: string },
  ): Promise<UserEntity> {
    return this.userService.loadAndUpdateUser(id, body.name);
  }

  @Patch(':id/mutate')
  mutate(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { name: string },
  ): Promise<void> {
    return this.userService.loadAndMutateWithoutSave(id, body.name);
  }

  @Delete(':id')
  @HttpCode(204)
  delete(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.userRepo.deleteById(id);
  }
}
