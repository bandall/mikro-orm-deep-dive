import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

// officials 재현용 "자식" — managements OfficialDetail 미러.
// FK 가 스칼라 컬럼(taskId)이다. (관계 아님 → id 스칼라 복사 함정 대상)
@Entity({ tableName: 'repro_detail_scalar' })
export class DetailScalarEntity {
  @PrimaryKey({ autoincrement: true })
  id!: number;

  // 부모 task 의 id 를 스칼라로 보관 (nullable — officials 와 동일하게 DB NULL 허용)
  @Property({ type: 'number', nullable: true })
  taskId?: number;
}
