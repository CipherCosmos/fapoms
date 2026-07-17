/**
 * FAPOMS — Geographic Reference Data Entities
 *
 * Hierarchical geographic model per Part 7 §10:
 * State → District → City
 */

import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';

@Entity('geo_states')
export class GeoStateEntity extends BaseEntity {
  @Column({ unique: true, length: 100 })
  name: string;

  @Column({ unique: true, length: 10 })
  code: string;
}

@Entity('geo_districts')
@Index(['stateId'])
export class GeoDistrictEntity extends BaseEntity {
  @Column({ length: 100 })
  name: string;

  @Column({ name: 'state_id', type: 'uuid' })
  stateId: string;

  @ManyToOne(() => GeoStateEntity)
  @JoinColumn({ name: 'state_id' })
  state: GeoStateEntity;
}

@Entity('geo_cities')
@Index(['districtId'])
export class GeoCityEntity extends BaseEntity {
  @Column({ length: 100 })
  name: string;

  @Column({ name: 'district_id', type: 'uuid' })
  districtId: string;

  @Column({ type: 'varchar', length: 10, nullable: true })
  pincode: string | null;

  @ManyToOne(() => GeoDistrictEntity)
  @JoinColumn({ name: 'district_id' })
  district: GeoDistrictEntity;
}
