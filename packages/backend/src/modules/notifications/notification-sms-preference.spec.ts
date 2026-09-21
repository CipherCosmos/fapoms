import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { NotificationCategory } from '@fapoms/shared';
import { NotificationService, ALL_NOTIFICATION_CATEGORIES } from './notification.service';
import { NotificationController } from './notification.controller';

/**
 * The per-person SMS switch, on the same opt-out terms as every other channel.
 *
 * Two traps this pins, both of which the email switch fell into once. A recipient who has never
 * opened the settings screen has no row, and must read as opted in — otherwise the first event an
 * administrator switches SMS on for texts nobody. And saving any OTHER switch creates the row, which
 * must not arrive with SMS off: the `email` column's old `false` default silently muted every email
 * in a category for anyone who had turned push off.
 */
describe('Notification preferences — the SMS switch', () => {
  let saved: any[];
  const prefRepo = {
    find: jest.fn(async () => saved),
    findOne: jest.fn(async () => saved[0] ?? null),
    create: jest.fn((row: any) => ({ ...row })),
    save: jest.fn(async (row: any) => row),
  };
  const service = new NotificationService({} as any, prefRepo as any, {} as any, {} as any, {} as any, {} as any);

  beforeEach(() => {
    saved = [];
    jest.clearAllMocks();
  });

  it('reads SMS as on for every category when nothing has been saved', async () => {
    const prefs = await service.getPreferences('u-1', false);

    expect(prefs).toHaveLength(ALL_NOTIFICATION_CATEGORIES.length);
    expect(prefs.every((p) => p.sms === true)).toBe(true);
  });

  it('reports a saved SMS opt-out for that category and leaves the others on', async () => {
    saved = [{ category: NotificationCategory.ASSIGNMENT, inApp: true, push: true, email: true, sms: false }];

    const prefs = await service.getPreferences('as-1', true);

    expect(prefs.find((p) => p.category === NotificationCategory.ASSIGNMENT)!.sms).toBe(false);
    expect(prefs.filter((p) => p.category !== NotificationCategory.ASSIGNMENT).every((p) => p.sms)).toBe(true);
  });

  it('does not create a row with SMS off when somebody only turned push off', async () => {
    const result = await service.setPreference('u-1', false, NotificationCategory.ASSIGNMENT, { push: false });

    expect(prefRepo.create).toHaveBeenCalledWith(expect.objectContaining({ sms: true }));
    expect(result).toEqual({ category: NotificationCategory.ASSIGNMENT, inApp: true, push: false, email: true, sms: true });
  });

  it('saves an SMS opt-out and hands it back', async () => {
    saved = [{ userId: 'u-1', category: NotificationCategory.ASSIGNMENT, inApp: true, push: true, email: true, sms: true }];

    const result = await service.setPreference('u-1', false, NotificationCategory.ASSIGNMENT, { sms: false });

    expect(prefRepo.save).toHaveBeenCalledWith(expect.objectContaining({ sms: false }));
    expect(result.sms).toBe(false);
  });

  /**
   * The API runs a ValidationPipe with `forbidNonWhitelisted` (main.ts). Without `sms` declared on
   * the request body, every SMS toggle on the settings screen would come back 400.
   */
  it('accepts sms in the request body the settings screen sends, and still refuses a non-boolean', async () => {
    const [, , Dto] = Reflect.getMetadata('design:paramtypes', NotificationController.prototype, 'setPreference');
    const options = { whitelist: true, forbidNonWhitelisted: true };

    expect(await validate(plainToInstance(Dto, { sms: false }), options)).toEqual([]);
    expect(await validate(plainToInstance(Dto, { sms: 'no' }), options)).not.toEqual([]);
  });
});
