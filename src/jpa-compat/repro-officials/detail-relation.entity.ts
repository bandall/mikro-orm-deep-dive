import { Entity, PrimaryKey, ManyToOne } from '@mikro-orm/decorators/legacy';
import { TaskEntity } from './task.entity';

// 안전 패턴 A 비교용 "자식" — FK 를 엔티티 관계(ManyToOne)로 보관.
// 관계 대입(child.task = task) 시 flush 순서로 FK 자동 해소 → id 미할당이어도 안전.
@Entity({ tableName: 'repro_detail_relation' })
export class DetailRelationEntity {
  @PrimaryKey({ autoincrement: true })
  id!: number;

  @ManyToOne(() => TaskEntity)
  task!: TaskEntity;
}
