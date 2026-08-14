import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationChannel } from '@fapoms/shared';

import { NotificationSettingsService } from './notification-settings.service';
import { NotificationSettingEntity } from './notification-setting.entity';
import { NOTIFICATION_CATALOG } from './notification-catalog';
import { CacheService } from '../../infrastructure/cache/cache.service';

/**
 * The override model's promise: a row records only what an operator deliberately changed,
 * everything else keeps following the shipped catalog — including improvements shipped later.
 */
describe('NotificationSettingsService', () => {
  let service: NotificationSettingsService;
  let repo: any;

  const TYPE = 'ASSIGNMENT_SLA_BREACHED';

  const override = (over: Partial<NotificationSettingEntity> = {}): any => ({
    id: 's-1',
    type: TYPE,
    enabled: true,
    channels: null,
    priority: null,
    roles: null,
    titleTemplate: null,
    bodyTemplate: null,
    linkTemplate: null,
    emailSubjectTemplate: null,
    emailBodyTemplate: null,
    collapseWindowSeconds: null,
    notes: null,
    ...over,
  });

  beforeEach(async () => {
    repo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((v: any) => ({ ...v })),
      save: jest.fn(async (v: any) => v),
      delete: jest.fn(async () => ({ affected: 1 })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationSettingsService,
        { provide: getRepositoryToken(NotificationSettingEntity), useValue: repo },
        {
          provide: CacheService,
          useValue: {
            wrap: jest.fn((_k: string, _t: number, load: () => any) => load()),
            del: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get(NotificationSettingsService);
  });

  describe('resolution', () => {
    it('returns the shipped catalog untouched when nothing is overridden', async () => {
      const def = await service.defFor(TYPE);
      expect(def!.channels).toEqual(NOTIFICATION_CATALOG[TYPE].channels);
      expect(def!.title).toBe(NOTIFICATION_CATALOG[TYPE].title);
      expect(def!.overridden).toEqual([]);
    });

    it('applies only the fields an override actually sets', async () => {
      repo.find.mockResolvedValue([override({ channels: [NotificationChannel.IN_APP] })]);

      const def = await service.defFor(TYPE);

      expect(def!.channels).toEqual([NotificationChannel.IN_APP]);
      // Everything else still tracks the catalog — this is what lets a later release's
      // wording improvements reach a type whose channels somebody customised.
      expect(def!.title).toBe(NOTIFICATION_CATALOG[TYPE].title);
      expect(def!.roles).toEqual(NOTIFICATION_CATALOG[TYPE].roles);
      expect(def!.overridden).toEqual(['channels']);
    });

    it('returns null for a type switched off, so nothing is raised at all', async () => {
      repo.find.mockResolvedValue([override({ enabled: false })]);
      expect(await service.defFor(TYPE)).toBeNull();
    });

    it('still lists a disabled type in the catalog — the admin screen must show it', async () => {
      repo.find.mockResolvedValue([override({ enabled: false })]);
      const all = await service.effectiveCatalog();
      expect(all[TYPE].enabled).toBe(false);
    });

    it('falls back to code defaults when the settings table cannot be read', async () => {
      // Silence is the one unacceptable failure mode: a broken settings lookup must not stop
      // an SLA breach reaching anyone.
      repo.find.mockRejectedValue(new Error('db down'));
      const def = await service.defFor(TYPE);
      expect(def!.channels).toEqual(NOTIFICATION_CATALOG[TYPE].channels);
    });

    it('lets a zero collapse window turn burst-merging off', async () => {
      const collapsing = Object.keys(NOTIFICATION_CATALOG).find((t) => NOTIFICATION_CATALOG[t].collapse)!;
      repo.find.mockResolvedValue([override({ type: collapsing, collapseWindowSeconds: 0 })]);
      const all = await service.effectiveCatalog();
      expect(all[collapsing].collapse).toBeUndefined();
    });

    it('re-times an existing collapse window without inventing summary wording', async () => {
      const collapsing = Object.keys(NOTIFICATION_CATALOG).find((t) => NOTIFICATION_CATALOG[t].collapse)!;
      repo.find.mockResolvedValue([override({ type: collapsing, collapseWindowSeconds: 60 })]);
      const all = await service.effectiveCatalog();
      expect(all[collapsing].collapse!.windowSeconds).toBe(60);
      expect(all[collapsing].collapse!.title).toBe(NOTIFICATION_CATALOG[collapsing].collapse!.title);
    });
  });

  describe('validation', () => {
    it('refuses an unknown type rather than storing a setting nothing reads', async () => {
      await expect(service.update('NOT_A_REAL_EVENT', { enabled: false })).rejects.toThrow(/Unknown notification type/);
    });

    it('refuses an empty channel list — that generates rows nobody ever sees', async () => {
      await expect(service.update(TYPE, { channels: [] })).rejects.toThrow(/at least one channel/);
    });

    it('refuses an unknown channel', async () => {
      await expect(service.update(TYPE, { channels: ['CARRIER_PIGEON'] })).rejects.toThrow(/Unknown channel/);
    });

    it('catches an unclosed placeholder before it reaches somebody’s inbox', async () => {
      await expect(service.update(TYPE, { titleTemplate: 'SLA breach on ${branchName' }))
        .rejects.toThrow(/unclosed/);
    });

    it('rejects a collapse window beyond a day', async () => {
      await expect(service.update(TYPE, { collapseWindowSeconds: 90_000 })).rejects.toThrow(/24 hours/);
    });
  });

  describe('writes', () => {
    it('reset removes the override row rather than blanking it', async () => {
      await service.reset(TYPE);
      expect(repo.delete).toHaveBeenCalledWith({ type: TYPE });
    });

    it('treats undefined as "leave alone" and null as "clear this override"', async () => {
      repo.findOne.mockResolvedValue(override({ channels: [NotificationChannel.IN_APP], titleTemplate: 'Custom' }));
      await service.update(TYPE, { channels: null });
      const saved = repo.save.mock.calls[0][0];
      expect(saved.channels).toBeNull();
      expect(saved.titleTemplate).toBe('Custom');
    });
  });

  describe('preview', () => {
    it('renders through the real renderer, fragments and all', async () => {
      const out = service.preview(
        { title: 'SLA breach: ${branchName}', body: 'Overdue by ${hours}h. Reason: ${reason}' },
        { branchName: 'Thrissur', hours: 3 },
      );
      expect(out.title).toBe('SLA breach: Thrissur');
      // The missing reason takes its whole clause with it, exactly as in production.
      expect(out.body).toBe('Overdue by 3h.');
    });

    it('falls back to the in-app wording when no email template is set', async () => {
      const out = service.preview({ title: 'A', body: 'B' }, {});
      expect(out.emailSubject).toBe('A');
      expect(out.emailBody).toBe('B');
    });
  });

  describe('placeholders', () => {
    it('lists the vocabulary a type’s shipped templates actually use', () => {
      const found = service.placeholdersFor(TYPE);
      expect(found.length).toBeGreaterThan(0);
      for (const key of found) {
        const base = NOTIFICATION_CATALOG[TYPE];
        expect(`${base.title} ${base.body} ${base.link ?? ''}`).toContain(key);
      }
    });
  });
});
