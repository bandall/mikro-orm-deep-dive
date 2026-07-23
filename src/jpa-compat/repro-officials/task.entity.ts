import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

// officials 재현용 "부모" — managements ProjectTask 미러 (autoincrement id).
@Entity({ tableName: 'repro_tasks' })
export class TaskEntity {
  @PrimaryKey({ autoincrement: true })
  id!: number;

  @Property()
  name!: string;
}
