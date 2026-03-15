import { Global, Module } from '@nestjs/common';
import { MikroOrmModule, type MikroOrmModuleAsyncOptions } from '@mikro-orm/nestjs';
import { EntityManager as CoreEntityManager } from '@mikro-orm/core';
import { EntityManager as MysqlEntityManager, MySqlDriver } from '@mikro-orm/mysql';
import { TsMorphMetadataProvider } from '@mikro-orm/reflection';
import { AuthorEntity } from './entities/author.entity';
import { BookEntity } from './entities/book.entity';
import { OuterService } from './services/outer.service';
import { InnerService } from './services/inner.service';
import { AuthorController } from './controllers/author.controller';

@Global()
@Module({
  imports: [
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
        entities: [AuthorEntity, BookEntity],
        metadataProvider: TsMorphMetadataProvider,
        discovery: { warnWhenNoEntities: false },
        registerRequestContext: true,
        allowGlobalContext: false,
      }),
    } as unknown as MikroOrmModuleAsyncOptions),
    MikroOrmModule.forFeature([AuthorEntity, BookEntity]),
  ],
  providers: [
    {
      provide: MysqlEntityManager,
      useExisting: CoreEntityManager,
    },
    OuterService,
    InnerService,
  ],
  controllers: [AuthorController],
  exports: [MysqlEntityManager],
})
export class AppModule {}
