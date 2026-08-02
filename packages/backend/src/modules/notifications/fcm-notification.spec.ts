import { Test, TestingModule } from '@nestjs/testing';
import { NotificationService } from './notification.service';
import { PushNotificationService } from './push-notification.service';
import { FcmProvider } from '../../infrastructure/notifications/fcm-provider';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationEntity } from './notification.entity';
import { UserEntity } from '../user/user.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { DeviceTokenEntity } from './device-token.entity';
import { NotificationPreferenceEntity } from './notification-preference.entity';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';

describe('FCM Notification & Routing E2E Test Suite', () => {
  let notificationService: NotificationService;
  let pushService: PushNotificationService;
  let fcmProvider: FcmProvider;

  const deviceTokensStore: DeviceTokenEntity[] = [];
  const notificationsStore: NotificationEntity[] = [];

  const mockDeviceTokenRepo = {
    findOne: jest.fn().mockImplementation(async ({ where }) => {
      return deviceTokensStore.find(
        (t) => t.userId === where.userId && t.platform === where.platform && t.isActive === true,
      ) || null;
    }),
    find: jest.fn().mockImplementation(async ({ where }) => {
      if (Array.isArray(where)) {
        const uids = where.map((w: any) => w.userId);
        return deviceTokensStore.filter((t) => uids.includes(t.userId) && t.isActive);
      }
      return deviceTokensStore.filter((t) => t.userId === where.userId && t.isActive === true);
    }),
    create: jest.fn().mockImplementation((dto) => ({
      id: `token-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      ...dto,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    save: jest.fn().mockImplementation(async (entity) => {
      const idx = deviceTokensStore.findIndex((t) => t.id === entity.id);
      if (idx >= 0) {
        deviceTokensStore[idx] = entity;
      } else {
        deviceTokensStore.push(entity);
      }
      return entity;
    }),
    update: jest.fn().mockImplementation(async (criteria, partial) => {
      const tokens = deviceTokensStore.filter(
        (t) => t.userId === criteria.userId && t.token === criteria.token,
      );
      tokens.forEach((t) => Object.assign(t, partial));
      return { affected: tokens.length };
    }),
  };

  const mockNotificationRepo = {
    create: jest.fn().mockImplementation((dto) => ({
      id: `notif-${Date.now()}`,
      isRead: false,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...dto,
    })),
    save: jest.fn().mockImplementation(async (entity) => {
      notificationsStore.push(entity);
      return entity;
    }),
    find: jest.fn().mockImplementation(async ({ where }) => {
      return notificationsStore.filter((n) => n.userId === where.userId && n.isActive);
    }),
  };

  const sendMulticastSpy = jest.fn().mockImplementation(async (tokens: string[], payload: any) => {
    return tokens.map((token) => ({
      success: true,
      messageId: `projects/fapoms/messages/${token}-${Date.now()}`,
    }));
  });

  beforeEach(async () => {
    deviceTokensStore.length = 0;
    notificationsStore.length = 0;
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationService,
        PushNotificationService,
        {
          provide: FcmProvider,
          useValue: {
            send: jest.fn().mockResolvedValue({ success: true, messageId: 'msg-1' }),
            sendMulticast: sendMulticastSpy,
          },
        },
        { provide: getRepositoryToken(NotificationEntity), useValue: mockNotificationRepo },
        { provide: DomainEventPublisher, useValue: { publish: jest.fn() } },
        { provide: getRepositoryToken(DeviceTokenEntity), useValue: mockDeviceTokenRepo },
        // NotificationService resolves assayer -> user for notifyAssayer(); both repos are
        // required for DI even though these tests exercise only the push path.
        { provide: getRepositoryToken(UserEntity), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(AssayerEntity), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(NotificationPreferenceEntity), useValue: { find: jest.fn(), findOne: jest.fn(), create: jest.fn(), save: jest.fn() } },
      ],
    }).compile();

    notificationService = module.get<NotificationService>(NotificationService);
    pushService = module.get<PushNotificationService>(PushNotificationService);
    fcmProvider = module.get<FcmProvider>(FcmProvider);
  });

  it('1. Should register push token for Assayer A and Assayer B separately', async () => {
    await pushService.registerToken('assayer-A-id', 'fcm-token-assayer-A', 'android');
    await pushService.registerToken('assayer-B-id', 'fcm-token-assayer-B', 'ios');

    expect(deviceTokensStore.length).toBe(2);
    expect(deviceTokensStore[0].userId).toBe('assayer-A-id');
    expect(deviceTokensStore[0].token).toBe('fcm-token-assayer-A');
    expect(deviceTokensStore[1].userId).toBe('assayer-B-id');
    expect(deviceTokensStore[1].token).toBe('fcm-token-assayer-B');
  });

  it('2. Should route notification ONLY to the assigned Assayer A', async () => {
    await pushService.registerToken('assayer-A-id', 'fcm-token-assayer-A', 'android');
    await pushService.registerToken('assayer-B-id', 'fcm-token-assayer-B', 'ios');

    await notificationService.create({
      userId: 'assayer-A-id',
      title: 'New Branch Inspection Assignment',
      message: 'You have been assigned to inspection at HDFC Bank Branch #104',
      link: '/assignments/asn-104',
    }, 'OPERATIONS_MANAGER');

    expect(notificationsStore.length).toBe(1);
    expect(notificationsStore[0].userId).toBe('assayer-A-id');

    expect(sendMulticastSpy).toHaveBeenCalledTimes(1);
    expect(sendMulticastSpy).toHaveBeenCalledWith(
      ['fcm-token-assayer-A'],
      {
        title: 'New Branch Inspection Assignment',
        body: 'You have been assigned to inspection at HDFC Bank Branch #104',
        data: { link: '/assignments/asn-104' },
      },
    );

    // Verify Assayer B tokens were NOT targeted
    expect(sendMulticastSpy).not.toHaveBeenCalledWith(
      expect.arrayContaining(['fcm-token-assayer-B']),
      expect.anything(),
    );
  });

  it('3. Should route status change notification ONLY to Assayer B when specified', async () => {
    await pushService.registerToken('assayer-A-id', 'fcm-token-assayer-A', 'android');
    await pushService.registerToken('assayer-B-id', 'fcm-token-assayer-B', 'ios');

    await notificationService.create({
      userId: 'assayer-B-id',
      title: 'Schedule Change',
      message: 'Your audit scheduled date has been updated to 2026-07-30',
      data: { assignmentId: 'asn-205', type: 'schedule_updated' },
    }, 'SYSTEM');

    expect(sendMulticastSpy).toHaveBeenCalledWith(
      ['fcm-token-assayer-B'],
      {
        title: 'Schedule Change',
        body: 'Your audit scheduled date has been updated to 2026-07-30',
        data: { assignmentId: 'asn-205', type: 'schedule_updated' },
      },
    );
  });

  it('4. Should unregister token when assayer logs out', async () => {
    await pushService.registerToken('assayer-A-id', 'fcm-token-assayer-A', 'android');
    await pushService.unregisterToken('assayer-A-id', 'fcm-token-assayer-A');

    expect(deviceTokensStore[0].isActive).toBe(false);

    // Sending notification to logged out assayer should not trigger FCM push
    await pushService.sendToUser('assayer-A-id', 'Test', 'Body');
    expect(sendMulticastSpy).not.toHaveBeenCalled();
  });
});
