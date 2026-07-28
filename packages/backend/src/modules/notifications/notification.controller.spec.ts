import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { PushNotificationService } from './push-notification.service';

describe('NotificationController', () => {
  let controller: NotificationController;
  let pushService: PushNotificationService;

  const mockNotifService = {
    findByUser: jest.fn().mockResolvedValue([]),
    markAsRead: jest.fn().mockResolvedValue({}),
  };

  const mockPushService = {
    registerToken: jest.fn().mockResolvedValue(undefined),
    unregisterToken: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [NotificationController],
      providers: [
        { provide: NotificationService, useValue: mockNotifService },
        { provide: PushNotificationService, useValue: mockPushService },
      ],
    }).compile();

    controller = module.get<NotificationController>(NotificationController);
    pushService = module.get<PushNotificationService>(PushNotificationService);
    jest.clearAllMocks();
  });

  describe('registerDeviceToken', () => {
    it('should throw if token is missing', async () => {
      await expect(controller.registerDeviceToken({ user: { id: 'u1' } }, { token: '', platform: 'android' }))
        .rejects.toThrow(BadRequestException);
    });

    it('should throw if platform is invalid', async () => {
      await expect(controller.registerDeviceToken({ user: { id: 'u1' } }, { token: 'tok-1', platform: 'windows' as any }))
        .rejects.toThrow(BadRequestException);
    });

    it('should register a valid device token', async () => {
      const result = await controller.registerDeviceToken(
        { user: { id: 'u1' } },
        { token: 'tok-1', platform: 'android' },
      );
      expect(result.success).toBe(true);
      expect(mockPushService.registerToken).toHaveBeenCalledWith('u1', 'tok-1', 'android');
    });

    it('should register iOS token', async () => {
      const result = await controller.registerDeviceToken(
        { user: { id: 'u1' } },
        { token: 'ios-tok', platform: 'ios' },
      );
      expect(result.success).toBe(true);
      expect(mockPushService.registerToken).toHaveBeenCalledWith('u1', 'ios-tok', 'ios');
    });
  });

  describe('unregisterDeviceToken', () => {
    it('should throw if token is missing', async () => {
      await expect(controller.unregisterDeviceToken({ user: { id: 'u1' } }, { token: '' }))
        .rejects.toThrow(BadRequestException);
    });

    it('should unregister a device token', async () => {
      const result = await controller.unregisterDeviceToken(
        { user: { id: 'u1' } },
        { token: 'tok-1' },
      );
      expect(result.success).toBe(true);
      expect(mockPushService.unregisterToken).toHaveBeenCalledWith('u1', 'tok-1');
    });
  });

  describe('findMyNotifications', () => {
    it('should return notifications for current user', async () => {
      const result = await controller.findMyNotifications({ user: { id: 'u1' } });
      expect(result.success).toBe(true);
      expect(mockNotifService.findByUser).toHaveBeenCalledWith('u1');
    });
  });
});
