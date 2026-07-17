/**
 * FAPOMS — Zone Entity
 *
 * Groups states and districts to coordinate regional assignments (Part 2 §9, Part 5 §11).
 */

import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { ClientEntity } from '../client/client.entity';

@Entity('zones')
@Index(['clientId'])
export class ZoneEntity extends BaseEntity {
  @Column({ length: 150 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'client_id', type: 'uuid', nullable: true })
  clientId: string | null;

  @ManyToOne(() => ClientEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'client_id' })
  client: ClientEntity | null;

  @Column({
    type: 'jsonb',
    nullable: true,
    comment: 'List of state codes grouped under this zone',
  })
  states: string[] | null;

  @Column({
    type: 'jsonb',
    nullable: true,
    comment: 'List of district names grouped under this zone',
  })
  districts: string[] | null;
}
