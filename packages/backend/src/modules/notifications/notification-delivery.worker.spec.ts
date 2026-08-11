import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationCategory, NotificationChannel, NotificationStatus } from '@fapoms/shared';
import { NotificationDeliveryWorker } from './notification-delivery.worker';
import { NotificationEntity } from './notification.entity';
import { DeviceTokenEntity } from './device-token.entity';
import { NotificationPreferenceEntity } from './notification-preference.entity';
import { FcmProvider } from '../../infrastructure/notifications/fcm-provider';
import { NotificationSweeper } from './notification.sweeper';

const baseNotification = (over: Partial<NotificationEntity> = {}): any => ({
  id: 'n-1',
  userId: 'user-1',
  assayerId: null,
  title: 'Assignment escalated',
  message: 'Thrissur has been marked critical.',
  category: NotificationCategory.ASSIGNMENT,
  status: NotificationStatus.PENDING,
  channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH],
  attempts: 0,
  type: 'ASSIGNMENT_ESCALATED',
  entityType: 'ASSIGNMENT',
  entityId: 'asn-1',
  link: '/assignments/asn-1',
  ...over,
});

describe('NotificationDeliveryWorker', () => {
  let worker: NotificationDeliveryWorker;
  let updates: any[];

  const notifRepo = {
    findOne: jest.fn(),
    update: jest.fn(async (id: any, patch: any) => { updates.push({ id, ...patch }); return { affected: 1 }; }),
  };
  const tokenRepo = { find: jest.fn(), update: jest.fn() };
  const prefRepo = { findOne: jest.fn() };
  const fcm = { sendMulticast: jest.fn() };
  const sweeper = { requeueStranded: jest.fn(), failAbandonedSends: jest.fn() };

  const lastStatus = () => [...updates].reverse().find((u) => u.status)?.status;

  beforeEach(async () => {
    updates = [];
    jest.clearAllMocks();
    prefRepo.findOne.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationDeliveryWorker,
        { provide: getRepositoryToken(NotificationEntity), useValue: notifRepo },
        { provide: getRepositoryToken(DeviceTokenEntity), useValue: tokenRepo },
        { provide: getRepositoryToken(NotificationPreferenceEntity), useValue: prefRepo },
        { provide: FcmProvider, useValue: fcm },
        { provide: NotificationSweeper, useValue: sweeper },
      ],
    }).compile();

    worker = module.get(NotificationDeliveryWorker);
  });

  const run = (job = { data: { notificationId: 'n-1' } }) => worker.deliver(job as any);

  it('marks DELIVERED when at least one device accepts the push', async () => {
    notifRepo.findOne.mockResolvedValue(baseNotification());
    tokenRepo.find.mockResolvedValue([{ id: 't1', token: 'tok-1' }, { id: 't2', token: 'tok-2' }]);
    fcm.sendMulticast.mockResolvedValue([{ success: true }, { success: false, error: 'timeout' }]);

    await run();

    expect(lastStatus()).toBe(NotificationStatus.DELIVERED);
  });

  it('retries a transient failure by throwing back to the queue', async () => {
    notifRepo.findOne.mockResolvedValue(baseNotification());
    tokenRepo.find.mockResolvedValue([{ id: 't1', token: 'tok-1' }]);
    fcm.sendMulticast.mockResolvedValue([{ success: false, error: 'UNAVAILABLE', errorCode: 'messaging/server-unavailable' }]);

    await expect(run()).rejects.toThrow('UNAVAILABLE');
    // Not terminal — a later attempt may still succeed.
    expect(lastStatus()).not.toBe(NotificationStatus.FAILED);
  });

  it('does not retry when every device token is permanently dead', async () => {
    notifRepo.findOne.mockResolvedValue(baseNotification());
    tokenRepo.find.mockResolvedValue([{ id: 't1', token: 'tok-1' }]);
    fcm.sendMulticast.mockResolvedValue([
      { success: false, error: 'not registered', errorCode: 'messaging/registration-token-not-registered' },
    ]);

    await expect(run()).resolves.toBeUndefined();
    expect(lastStatus()).toBe(NotificationStatus.FAILED);
  });

  it('retires dead tokens so they stop being retried forever', async () => {
    notifRepo.findOne.mockResolvedValue(baseNotification());
    tokenRepo.find.mockResolvedValue([{ id: 't1', token: 'dead' }, { id: 't2', token: 'live' }]);
    fcm.sendMulticast.mockResolvedValue([
      { success: false, errorCode: 'messaging/registration-token-not-registered' },
      { success: true },
    ]);

    await run();

    expect(tokenRepo.update).toHaveBeenCalledWith(
      { id: expect.objectContaining({ _value: ['t1'] }) },
      { isActive: false },
    );
  });

  it('honours an explicit push opt-out without treating it as a failure', async () => {
    notifRepo.findOne.mockResolvedValue(baseNotification());
    prefRepo.findOne.mockResolvedValue({ push: false });

    await run();

    expect(lastStatus()).toBe(NotificationStatus.SUPPRESSED);
    expect(fcm.sendMulticast).not.toHaveBeenCalled();
  });

  it('treats a missing preference row as consent, not as opt-out', async () => {
    notifRepo.findOne.mockResolvedValue(baseNotification());
    prefRepo.findOne.mockResolvedValue(null);
    tokenRepo.find.mockResolvedValue([{ id: 't1', token: 'tok' }]);
    fcm.sendMulticast.mockResolvedValue([{ success: true }]);

    await run();

    expect(fcm.sendMulticast).toHaveBeenCalled();
    expect(lastStatus()).toBe(NotificationStatus.DELIVERED);
  });

  it('a recipient with no device still counts as delivered when in-app carried it', async () => {
    notifRepo.findOne.mockResolvedValue(baseNotification());
    tokenRepo.find.mockResolvedValue([]);

    await run();

    expect(lastStatus()).toBe(NotificationStatus.DELIVERED);
    expect(updates.at(-1).failureReason).toMatch(/No registered device/);
  });

  it('a push-only notification with no device is suppressed, not silently delivered', async () => {
    notifRepo.findOne.mockResolvedValue(baseNotification({ channels: [NotificationChannel.PUSH] }));
    tokenRepo.find.mockResolvedValue([]);

    await run();

    expect(lastStatus()).toBe(NotificationStatus.SUPPRESSED);
  });

  it('sends deep-link data so a tap can open the right record', async () => {
    notifRepo.findOne.mockResolvedValue(baseNotification());
    tokenRepo.find.mockResolvedValue([{ id: 't1', token: 'tok' }]);
    fcm.sendMulticast.mockResolvedValue([{ success: true }]);

    await run();

    expect(fcm.sendMulticast).toHaveBeenCalledWith(
      ['tok'],
      expect.objectContaining({
        data: expect.objectContaining({
          notificationId: 'n-1', entityType: 'ASSIGNMENT', entityId: 'asn-1', link: '/assignments/asn-1',
        }),
      }),
    );
  });

  it('ignores a job whose notification has since been deleted', async () => {
    notifRepo.findOne.mockResolvedValue(null);
    await expect(run()).resolves.toBeUndefined();
    expect(fcm.sendMulticast).not.toHaveBeenCalled();
  });

  it('skips a notification that carries no push channel', async () => {
    notifRepo.findOne.mockResolvedValue(baseNotification({ channels: [NotificationChannel.IN_APP] }));
    await run();
    expect(fcm.sendMulticast).not.toHaveBeenCalled();
  });
});
