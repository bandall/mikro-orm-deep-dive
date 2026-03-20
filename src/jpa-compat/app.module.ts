import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { MikroOrmModule, type MikroOrmModuleAsyncOptions } from '@mikro-orm/nestjs';
import { EntityManager as CoreEntityManager } from '@mikro-orm/core';
import { EntityManager as MysqlEntityManager, MySqlDriver } from '@mikro-orm/mysql';
import { TsMorphMetadataProvider } from '@mikro-orm/reflection';
import { UserEntity } from './entities/user.entity';
import { PostEntity } from './entities/post.entity';
import { TransactionalExplorer } from './transactional.explorer';
import { UserService } from './services/user.service';
import { OrderService } from './services/order.service';
import { UserController } from './controllers/user.controller';

@Global()
@Module({
  imports: [
    DiscoveryModule,
    MikroOrmModule.forRootAsync({
      driver: MySqlDriver,
      useFactory: () => ({
        host: 'localhost',
        port: 3307,
        user: 'root',
        password: 'test',
        dbName: 'mikro_orm_test',
        driver: MySqlDriver,
        debug: true,
        entities: [UserEntity, PostEntity],
        metadataProvider: TsMorphMetadataProvider,
        discovery: { warnWhenNoEntities: false },
        registerRequestContext: true,
        allowGlobalContext: false,
      }),
    } as unknown as MikroOrmModuleAsyncOptions),
    MikroOrmModule.forFeature([UserEntity, PostEntity]),
  ],
  controllers: [UserController],
  providers: [
    {
      provide: MysqlEntityManager,
      useExisting: CoreEntityManager,
    },
    TransactionalExplorer,
    UserService,
    OrderService,
  ],
  exports: [MysqlEntityManager],
})
export class JpaCompatModule {}
