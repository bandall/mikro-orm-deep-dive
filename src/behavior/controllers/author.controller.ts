import { Controller, Get, Post, Body, Param, ParseIntPipe } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import { AuthorEntity } from '../entities/author.entity';

/**
 * e2e 테스트용 컨트롤러.
 * registerRequestContext: true가 HTTP 요청마다 fork EM을 제공하는지 검증.
 */
@Controller('authors')
export class AuthorController {
  constructor(private readonly em: EntityManager) {}

  @Post()
  async create(@Body() body: { name: string }) {
    const author = this.em.create(AuthorEntity, { name: body.name });
    this.em.persist(author);
    await this.em.flush();
    return { id: author.id, name: author.name };
  }

  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const author = await this.em.findOne(AuthorEntity, id);
    if (!author) return { found: false };
    return { found: true, id: author.id, name: author.name };
  }

  @Get()
  async findAll() {
    const authors = await this.em.find(AuthorEntity, {});
    return authors.map((a) => ({ id: a.id, name: a.name }));
  }
}
