import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeviceTokenEntity, DevicePlatform } from './device-token.entity';
import { FcmProvider } from '../../infrastructure/notifications/fcm-provider';

@Injectable()
export class PushNotificationService {
  private readonly logger = new Logger(PushNotificationService.name);

  constructor(
    @InjectRepository(DeviceTokenEntity)
    private readonly deviceTokenRepo: Repository<DeviceTokenEntity>,
    private readonly fcmProvider: FcmProvider,
  ) {}

  async registerToken(userId: string, token: string, platform: DevicePlatform): Promise<void> {
    const existing = await this.deviceTokenRepo.findOne({
      where: { userId, platform, isActive: true },
    });

    if (existing) {
      if (existing.token === token) return;
      existing.token = token;
      existing.updatedBy = userId;
      await this.deviceTokenRepo.save(existing);
    } else {
      const entity = this.deviceTokenRepo.create({
        userId,
        token,
        platform,
        isActive: true,
        createdBy: userId,
        updatedBy: userId,
      });
      await this.deviceTokenRepo.save(entity);
    }
  }

  async unregisterToken(userId: string, token: string): Promise<void> {
    await this.deviceTokenRepo.update({ userId, token }, { isActive: false, updatedBy: userId });
  }

  async sendToUser(userId: string, title: string, body: string, data?: Record<string, string>): Promise<void> {
    const tokens = await this.deviceTokenRepo.find({
      where: { userId, isActive: true },
    });

    if (tokens.length === 0) {
      this.logger.debug(`No device tokens for user ${userId}`);
      return;
    }

    const results = await this.fcmProvider.sendMulticast(
      tokens.map((t) => t.token),
      { title, body, data },
    );

    const failures = results.filter((r) => !r.success);
    if (failures.length > 0) {
      this.logger.warn(`${failures.length}/${results.length} pushes failed for user ${userId}`);
    }
  }

  async sendToAllUsers(userIds: string[], title: string, body: string, data?: Record<string, string>): Promise<void> {
    const tokens = await this.deviceTokenRepo.find({
      where: userIds.map((uid) => ({ userId: uid, isActive: true })),
    });

    if (tokens.length === 0) return;

    await this.fcmProvider.sendMulticast(
      tokens.map((t) => t.token),
      { title, body, data },
    );
  }
}
