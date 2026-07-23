import { FinalBaseRepository } from './final-base.repository';
import { LedgerEntity } from './ledger.entity';

export class LedgerRepository extends FinalBaseRepository<LedgerEntity> {
  async findBySignature(signature: string): Promise<LedgerEntity | null> {
    return this.findOne({ signature });
  }
}
