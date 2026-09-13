import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationCategory } from '@fapoms/shared';
import { NotificationService } from './notification.service';
import { NotificationEntity } from './notification.entity';
import { NotificationPreferenceEntity } from './notification-preference.entity';
import { UserEntity } from '../user/user.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { PushNotificationService } from './push-notification.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';

/**
 * `notifyAssayer` — the hand-rolled, no-catalog-entry-needed send used by `bulkNotify` (a
 * caller-authored broadcast, addressed to a specific assayer id, so there is no template to
 * categorise it by) and, until recently, by two other now-migrated callers — sent push
 * unconditionally, with no check at all for whether the assayer had turned push off. Bucketed
 * under `NotificationCategory.SYSTEM`, the closest fit for a broadcast with no domain of its own,
 * using the same `preferenceRepository.findOne({assayerId, category})` lookup
 * `notification-delivery.worker.ts` already uses for the catalog-routed path.
 */
describe('NotificationService.notifyAssayer — preference check', () => {
  let service: NotificationService;
  const notificationSave = jest.fn();
  const preferenceFindOne = jest.fn();
  const sendToUser = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationService,
        {
          provide: getRepositoryToken(NotificationEntity),
          useValue: { save: notificationSave, create: (v: any) => v },
        },
        {
          provide: getRepositoryToken(NotificationPreferenceEntity),
          useValue: { findOne: preferenceFindOne, find: jest.fn().mockResolvedValue([]) },
        },
        { provide: getRepositoryToken(UserEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerEntity), useValue: {} },
        { provide: PushNotificationService, useValue: { sendToUser } },
        { provide: DomainEventPublisher, useValue: { publish: jest.fn() } },
      ],
    }).compile();

    service = module.get(NotificationService);
  });

  it('sends push when the assayer has no preference row at all — absence means opted in', async () => {
    preferenceFindOne.mockResolvedValue(null);

    await service.notifyAssayer('a-1', 'a@x.in', { title: 'T', message: 'M' });

    expect(preferenceFindOne).toHaveBeenCalledWith({
      where: { assayerId: 'a-1', category: NotificationCategory.SYSTEM },
    });
    expect(sendToUser).toHaveBeenCalledWith('a-1', 'T', 'M', undefined);
  });

  it('sends push when the assayer has a preference row that has not turned push off', async () => {
    preferenceFindOne.mockResolvedValue({ push: true });

    await service.notifyAssayer('a-1', 'a@x.in', { title: 'T', message: 'M' });

    expect(sendToUser).toHaveBeenCalled();
  });

  it('does NOT send push when the assayer has turned it off for this category', async () => {
    preferenceFindOne.mockResolvedValue({ push: false });

    await service.notifyAssayer('a-1', 'a@x.in', { title: 'T', message: 'M' });

    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('still writes the in-app row even when push is suppressed — the mute is push-only', async () => {
    preferenceFindOne.mockResolvedValue({ push: false });

    const { inAppDelivered } = await service.notifyAssayer('a-1', 'a@x.in', { title: 'T', message: 'M' });

    expect(inAppDelivered).toBe(true);
    expect(notificationSave).toHaveBeenCalled();
  });

  it('a failed preference lookup is swallowed like every other error in this method — the method still resolves, but the send it would have gated does not go out', async () => {
    preferenceFindOne.mockRejectedValue(new Error('db down'));

    const result = await service.notifyAssayer('a-1', 'a@x.in', { title: 'T', message: 'M' });

    expect(result).toEqual({ inAppDelivered: true });
    // The throw happens before the guarded sendToUser call is reached, so this is a genuine miss
    // (no push sent), not a silent success — consistent with this method's existing convention of
    // never letting a push-side failure surface to the caller or block the in-app row above it.
    expect(sendToUser).not.toHaveBeenCalled();
  });
});
