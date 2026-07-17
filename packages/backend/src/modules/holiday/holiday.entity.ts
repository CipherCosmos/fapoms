/**
 * FAPOMS — Holiday Entity
 *
 * Represents national or regional holidays (Part 2 §10, Part 5 §11).
 * Used during assignment scheduling validation to prevent holiday audits.
 */

import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';

@Entity('holidays')
@Index(['date'])
@Index(['year'])
export class HolidayEntity extends BaseEntity {
  @Column({ length: 150 })
  name: string;

  @Column({ type: 'date' })
  date: Date;

  @Column({
    type: 'varchar',
    length: 20,
    default: 'NATIONAL',
    comment: 'Holiday type: NATIONAL, BANK, REGIONAL, CUSTOM',
  })
  type: string;

  @Column({
    name: 'applicable_states',
    type: 'jsonb',
    nullable: true,
    comment: 'List of state codes where this holiday is observed. Empty = nationwide.',
  })
  applicableStates: string[] | null;

  @Column({ type: 'int' })
  year: number;
}
