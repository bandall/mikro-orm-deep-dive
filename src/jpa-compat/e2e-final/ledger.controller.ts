import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { LedgerEntity } from './ledger.entity';
import { LedgerRepository } from './ledger.repository';
import { LedgerService } from './ledger.service';

@Controller('ledgers')
export class LedgerController {
  constructor(
    private readonly service: LedgerService,
    private readonly ledgerRepo: LedgerRepository,
  ) {}

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number): Promise<LedgerEntity | null> {
    return this.ledgerRepo.findOne(id);
  }

  @Post()
  create(@Body() body: { signature: string }): Promise<LedgerEntity> {
    return this.service.create(body.signature);
  }

  @Post('with-step')
  createWithStep(
    @Body() body: { signature: string },
  ): Promise<{ ledgerId: number; stepLinked: boolean }> {
    return this.service.createWithStep(body.signature);
  }

  @Post('throw')
  createThenThrow(@Body() body: { signature: string }): Promise<void> {
    return this.service.createThenThrow(body.signature);
  }

  @Patch(':id/in-tx')
  updateInTx(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { status: string },
  ): Promise<void> {
    return this.service.updateInTx(id, body.status);
  }

  @Patch(':id/outside-tx')
  updateOutsideTx(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { status: string },
  ): Promise<void> {
    return this.service.updateOutsideTx(id, body.status);
  }
}
