import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { PushNotificationService } from './push-notification.service';

describe('NotificationController', () => {
  let controller: NotificationController;
  let pushService: PushNotificationService;

  const mockNotifService = {
    findByUser: jest.fn().mockResolvedValue({ items: [], total: 0, unreadCount: 0 }),
    markAsRead: jest.fn().mockResolvedValue({}),
    markAllAsRead: jest.fn().mockResolvedValue(0),
    getUnreadCount: jest.fn().mockResolvedValue(0),
    getPreferences: jest.fn().mockResolvedValue([]),
    setPreference: jest.fn().mockResolvedValue({ category: 'ASSIGNMENT', inApp: true, push: true, email: false }),
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
    it('should return a page of notifications with pagination metadata', async () => {
      mockNotifService.findByUser.mockResolvedValueOnce({ items: [{ id: 'n1' }], total: 1, unreadCount: 1 });

      const result: any = await controller.findMyNotifications({ user: { id: 'u1' } }, undefined, false, 25, 0);

      expect(result.success).toBe(true);
      expect(result.data).toEqual([{ id: 'n1' }]);
      expect(result.meta).toEqual({ total: 1, unreadCount: 1, limit: 25, offset: 0 });
      expect(mockNotifService.findByUser).toHaveBeenCalledWith('u1', {
        category: undefined, unreadOnly: false, limit: 25, offset: 0,
      });
    });

    it('passes the category filter through unchanged', async () => {
      await controller.findMyNotifications({ user: { id: 'u1' } }, 'ASSIGNMENT' as any, true, 10, 0);
      expect(mockNotifService.findByUser).toHaveBeenCalledWith('u1', {
        category: 'ASSIGNMENT', unreadOnly: true, limit: 10, offset: 0,
      });
    });
  });

  describe('unreadCount', () => {
    it('returns just the count', async () => {
      mockNotifService.getUnreadCount.mockResolvedValueOnce(4);
      const result: any = await controller.unreadCount({ user: { id: 'u1' } });
      expect(result.data).toEqual({ count: 4 });
    });
  });

  describe('markAllAsRead', () => {
    it('reports how many were updated', async () => {
      mockNotifService.markAllAsRead.mockResolvedValueOnce(7);
      const result: any = await controller.markAllAsRead({ user: { id: 'u1' } });
      expect(result.data).toEqual({ updated: 7 });
      expect(mockNotifService.markAllAsRead).toHaveBeenCalledWith('u1');
    });
  });

  describe('preferences', () => {
    it('resolves staff users as non-assayer recipients', async () => {
      await controller.getPreferences({ user: { id: 'u1', roles: [{ name: 'OPERATIONS_MANAGER' }] } });
      expect(mockNotifService.getPreferences).toHaveBeenCalledWith('u1', false);
    });

    it('resolves an assayer token by its synthetic ASSAYER role', async () => {
      await controller.getPreferences({ user: { id: 'a1', roles: [{ name: 'ASSAYER' }] } });
      expect(mockNotifService.getPreferences).toHaveBeenCalledWith('a1', true);
    });

    it('rejects a category outside the known set', async () => {
      await expect(
        controller.setPreference('NOT_REAL' as any, { user: { id: 'u1', roles: [] } }, { push: false }),
      ).rejects.toThrow(BadRequestException);
    });

    it('updates a real category', async () => {
      const result: any = await controller.setPreference(
        'ASSIGNMENT' as any, { user: { id: 'u1', roles: [] } }, { push: false },
      );
      expect(result.success).toBe(true);
      expect(mockNotifService.setPreference).toHaveBeenCalledWith('u1', false, 'ASSIGNMENT', { push: false });
    });
  });
});
