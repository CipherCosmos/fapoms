import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';

export type DevicePlatform = 'ios' | 'android';

@Entity('device_tokens')
@Index(['userId', 'platform'], { unique: true })
@Index(['token'])
export class DeviceTokenEntity extends BaseEntity {
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 500 })
  token: string;

  @Column({ type: 'varchar', length: 10 })
  platform: DevicePlatform;
}
