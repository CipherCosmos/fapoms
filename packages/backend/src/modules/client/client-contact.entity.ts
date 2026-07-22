import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import type { ClientEntity } from './client.entity';

@Entity('client_contacts')
@Index(['clientId'])
export class ClientContactEntity extends BaseEntity {
  @Column({ name: 'client_id', type: 'uuid' })
  clientId: string;

  @ManyToOne('ClientEntity', 'contacts', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'client_id' })
  client: ClientEntity;

  @Column({ length: 200 })
  name: string;

  @Column({ length: 255 })
  email: string;

  @Column({ length: 20 })
  phone: string;

  @Column({ length: 200 })
  designation: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  department: string | null;

  @Column({ name: 'is_primary', default: false })
  isPrimary: boolean;

  @Column({ type: 'text', nullable: true })
  notes: string | null;
}
