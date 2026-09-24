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

  /**
   * One row per person per platform, and one person per device token.
   *
   * The row is looked up whatever its `isActive`: sign-out deactivates it rather than deleting it,
   * and the (user, platform) index is unique regardless of that flag — so looking only for an
   * active row and inserting when none was found hit the unique index on the next sign-in, the
   * registration failed, and that phone silently stopped getting any push at all.
   *
   * And a token is a device, not a person. On a phone two people share, the previous person's row
   * kept this device's token whenever their sign-out never reached the server (no signal), so
   * their job offers and office questions went on arriving on the phone somebody else was now
   * signed in to. Registering a token therefore takes it away from anyone else holding it.
   */
  async registerToken(userId: string, token: string, platform: DevicePlatform): Promise<void> {
    const others = await this.deviceTokenRepo.find({ where: { token, isActive: true } });
    for (const row of others) {
      if (row.userId === userId && row.platform === platform) continue;
      row.isActive = false;
      row.updatedBy = userId;
      await this.deviceTokenRepo.save(row);
    }

    const existing = await this.deviceTokenRepo.findOne({ where: { userId, platform } });
    if (existing) {
      if (existing.token === token && existing.isActive) return;
      existing.token = token;
      existing.isActive = true;
      existing.updatedBy = userId;
      await this.deviceTokenRepo.save(existing);
      return;
    }
    await this.deviceTokenRepo.save(this.deviceTokenRepo.create({
      userId,
      token,
      platform,
      isActive: true,
      createdBy: userId,
      updatedBy: userId,
    }));
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

  /**
   * A silent, data-only message to every active device of one person (see
   * `FcmProvider.sendDataOnlyMulticast`). Used by `AssignmentRefreshPushService`; nothing is shown.
   * Returns how many devices it was handed to, for the caller's log line.
   */
  async sendDataToUser(userId: string, data: Record<string, string>): Promise<number> {
    const tokens = await this.deviceTokenRepo.find({ where: { userId, isActive: true } });
    if (tokens.length === 0) return 0;
    const results = await this.fcmProvider.sendDataOnlyMulticast(tokens.map((t) => t.token), data);
    const failures = results.filter((r) => !r.success);
    if (failures.length > 0) {
      this.logger.debug(`${failures.length}/${results.length} refresh pushes failed for ${userId}`);
    }
    return tokens.length;
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
