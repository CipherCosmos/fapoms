import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PushNotificationService } from './push-notification.service';
import { DeviceTokenEntity } from './device-token.entity';
import { FcmProvider } from '../../infrastructure/notifications/fcm-provider';

describe('PushNotificationService', () => {
  let service: PushNotificationService;
  let deviceTokenRepo: Repository<DeviceTokenEntity>;
  let fcmProvider: FcmProvider;

  const mockDeviceTokenRepo = {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
  };

  const mockFcmProvider = {
    send: jest.fn().mockResolvedValue({ success: true }),
    sendMulticast: jest.fn().mockResolvedValue([{ success: true }]),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PushNotificationService,
        { provide: getRepositoryToken(DeviceTokenEntity), useValue: mockDeviceTokenRepo },
        { provide: FcmProvider, useValue: mockFcmProvider },
      ],
    }).compile();

    service = module.get<PushNotificationService>(PushNotificationService);
    deviceTokenRepo = module.get<Repository<DeviceTokenEntity>>(getRepositoryToken(DeviceTokenEntity));
    fcmProvider = module.get<FcmProvider>(FcmProvider);
    jest.clearAllMocks();
    // Nobody else holds the token unless a test says so.
    mockDeviceTokenRepo.find.mockResolvedValue([]);
  });

  describe('registerToken', () => {
    it('should create a new device token when none exists', async () => {
      mockDeviceTokenRepo.findOne.mockResolvedValue(null);
      mockDeviceTokenRepo.create.mockReturnValue({ userId: 'user-1', token: 'tok-1', platform: 'android' });
      mockDeviceTokenRepo.save.mockResolvedValue({ id: 'dt-1', userId: 'user-1', token: 'tok-1', platform: 'android' });

      await service.registerToken('user-1', 'tok-1', 'android');

      expect(mockDeviceTokenRepo.create).toHaveBeenCalledWith({
        userId: 'user-1', token: 'tok-1', platform: 'android',
        isActive: true, createdBy: 'user-1', updatedBy: 'user-1',
      });
      expect(mockDeviceTokenRepo.save).toHaveBeenCalled();
    });

    it('should update existing token if it changed', async () => {
      mockDeviceTokenRepo.findOne.mockResolvedValue({ id: 'dt-1', userId: 'user-1', token: 'old-tok', platform: 'android' });
      mockDeviceTokenRepo.save.mockResolvedValue({ id: 'dt-1', userId: 'user-1', token: 'new-tok', platform: 'android' });

      await service.registerToken('user-1', 'new-tok', 'android');

      expect(mockDeviceTokenRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'dt-1', token: 'new-tok' })
      );
    });

    it('should skip save if token is unchanged', async () => {
      mockDeviceTokenRepo.findOne.mockResolvedValue({ id: 'dt-1', userId: 'user-1', token: 'tok-1', platform: 'android', isActive: true });

      await service.registerToken('user-1', 'tok-1', 'android');

      expect(mockDeviceTokenRepo.save).not.toHaveBeenCalled();
    });

    it('reactivates the row a sign-out deactivated instead of inserting a second one', async () => {
      // The (user, platform) index is unique whatever isActive says: an insert here was refused,
      // and the phone silently stopped receiving pushes after signing back in.
      mockDeviceTokenRepo.findOne.mockResolvedValue({ id: 'dt-1', userId: 'user-1', token: 'tok-1', platform: 'android', isActive: false });

      await service.registerToken('user-1', 'tok-1', 'android');

      expect(mockDeviceTokenRepo.findOne).toHaveBeenCalledWith({ where: { userId: 'user-1', platform: 'android' } });
      expect(mockDeviceTokenRepo.create).not.toHaveBeenCalled();
      expect(mockDeviceTokenRepo.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'dt-1', isActive: true }));
    });

    it('takes the device away from whoever held it before, so their pushes stop reaching this phone', async () => {
      const previous = { id: 'dt-a', userId: 'user-a', token: 'shared-tok', platform: 'android', isActive: true };
      mockDeviceTokenRepo.find.mockResolvedValue([previous]);
      mockDeviceTokenRepo.findOne.mockResolvedValue(null);
      mockDeviceTokenRepo.create.mockReturnValue({ userId: 'user-b', token: 'shared-tok', platform: 'android' });

      await service.registerToken('user-b', 'shared-tok', 'android');

      expect(mockDeviceTokenRepo.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'dt-a', isActive: false }));
      expect(mockDeviceTokenRepo.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-b', token: 'shared-tok' }));
    });
  });

  describe('unregisterToken', () => {
    it('should mark token as inactive', async () => {
      mockDeviceTokenRepo.update.mockResolvedValue({ affected: 1 });

      await service.unregisterToken('user-1', 'tok-1');

      expect(mockDeviceTokenRepo.update).toHaveBeenCalledWith(
        { userId: 'user-1', token: 'tok-1' },
        { isActive: false, updatedBy: 'user-1' }
      );
    });
  });

  describe('sendToUser', () => {
    it('should skip if user has no device tokens', async () => {
      mockDeviceTokenRepo.find.mockResolvedValue([]);

      await service.sendToUser('user-1', 'Title', 'Body');

      expect(mockFcmProvider.sendMulticast).not.toHaveBeenCalled();
    });

    it('should send push via FCM provider', async () => {
      mockDeviceTokenRepo.find.mockResolvedValue([
        { id: 'dt-1', userId: 'user-1', token: 'tok-1', platform: 'android', isActive: true },
      ]);

      await service.sendToUser('user-1', 'Title', 'Body', { key: 'val' });

      expect(mockFcmProvider.sendMulticast).toHaveBeenCalledWith(
        ['tok-1'],
        { title: 'Title', body: 'Body', data: { key: 'val' } },
      );
    });
  });
});
