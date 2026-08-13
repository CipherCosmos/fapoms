import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { BypassableRule, MAX_BYPASS_HOURS } from '@fapoms/shared';
import { RuleBypassService } from './rule-bypass.service';
import { RuleBypassWindowEntity } from './rule-bypass.entity';
import { AuditService } from '../../../core/audit/audit.service';

/**
 * This switch suspends the controls the audit product is sold on — the check-in geofence is the
 * attendance evidence, the certification gate is what lets a client accept the auditor, the
 * distance floor is a conflict-of-interest control. So the tests that matter here are not
 * "does it turn rules off"; they are the ones that stop it being left on, being turned on
 * quietly, or turning itself on when something breaks.
 */
describe('RuleBypassService', () => {
  let service: RuleBypassService;
  let saved: Partial<RuleBypassWindowEntity> | null;

  const admin = { id: 'admin-1', name: 'Priya (Admin)' };

  const repo = {
    createQueryBuilder: jest.fn(),
    create: jest.fn((dto: any) => dto),
    save: jest.fn(async (row: any) => { saved = { id: 'win-1', ...row }; return saved; }),
    update: jest.fn().mockResolvedValue(undefined),
    find: jest.fn().mockResolvedValue([]),
    // `disable` re-reads the row so the closing record reports the settled usage counts.
    findOne: jest.fn().mockResolvedValue(null),
  };

  const audit = { recordEvent: jest.fn().mockResolvedValue(undefined), recordEventSafe: jest.fn().mockResolvedValue(undefined) };

  /** Make the "is a window running?" query resolve to `window`. */
  const currentWindowIs = (window: any) => {
    repo.createQueryBuilder.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(window),
    });
  };

  const liveWindow = (rules: BypassableRule[]) => ({
    id: 'win-1',
    rules,
    reason: 'Testing the check-in flow end to end',
    enabledBy: admin.id,
    enabledByName: admin.name,
    startsAt: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() + 3_600_000),
    revokedAt: null,
    usageCounts: {},
  });

  beforeEach(async () => {
    saved = null;
    jest.clearAllMocks();
    currentWindowIs(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RuleBypassService,
        { provide: getRepositoryToken(RuleBypassWindowEntity), useValue: repo },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = module.get(RuleBypassService);
  });

  describe('by default, nothing is suspended', () => {
    it('reports every rule as enforced', async () => {
      await expect(service.isBypassed(BypassableRule.CHECK_IN_GEOFENCE)).resolves.toBe(false);
      expect((await service.getState()).active).toBe(false);
    });

    it('fails closed when the window cannot be read', async () => {
      // A control that switches itself off when the database hiccups is not a control.
      repo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockRejectedValue(new Error('connection lost')),
      });
      await expect(service.isBypassed(BypassableRule.CHECK_IN_GEOFENCE)).resolves.toBe(false);
      await expect(service.getState()).resolves.toMatchObject({ active: false });
    });

    it('fails closed on the synchronous path before the cache is warm', () => {
      // The sync reader serves call sites that cannot await. Cold, it must say "enforced" —
      // guessing the other way would suspend controls on a cache miss.
      expect(service.isBypassedSync(BypassableRule.DISTANCE_POLICY)).toBe(false);
    });
  });

  describe('while a window is open', () => {
    beforeEach(() => currentWindowIs(liveWindow([BypassableRule.CHECK_IN_GEOFENCE])));

    it('suspends only the rules that were named', async () => {
      await expect(service.isBypassed(BypassableRule.CHECK_IN_GEOFENCE)).resolves.toBe(true);
      // The one people expect to come along for the ride, and must not.
      await expect(service.isBypassed(BypassableRule.SKILLS_AND_CERTIFICATIONS)).resolves.toBe(false);
    });

    it('reports who opened it and why, for the banner', async () => {
      await expect(service.getState()).resolves.toMatchObject({
        active: true,
        rules: [BypassableRule.CHECK_IN_GEOFENCE],
        enabledByName: admin.name,
        reason: 'Testing the check-in flow end to end',
      });
    });
  });

  describe('expiry', () => {
    it('stops applying once the window has passed, without anyone acting', async () => {
      // The realistic failure: enabled on a Friday to test one screen, still on three weeks
      // later. Nothing here revokes it — it simply stops being current.
      currentWindowIs(null); // the query itself filters on expires_at > now
      await expect(service.isBypassed(BypassableRule.CHECK_IN_GEOFENCE)).resolves.toBe(false);
    });

    it('is re-checked on the synchronous path rather than trusted from the cache', async () => {
      // Warm the cache with a window, then let it expire in place. A cached row must not
      // outlive its own deadline just because the cache is still fresh.
      const expiring = liveWindow([BypassableRule.CHECK_IN_GEOFENCE]);
      currentWindowIs(expiring);
      await service.isBypassed(BypassableRule.CHECK_IN_GEOFENCE);
      expect(service.isBypassedSync(BypassableRule.CHECK_IN_GEOFENCE)).toBe(true);

      expiring.expiresAt = new Date(Date.now() - 1000);
      expect(service.isBypassedSync(BypassableRule.CHECK_IN_GEOFENCE)).toBe(false);
    });
  });

  describe('opening a window', () => {
    it('refuses a window longer than the cap', async () => {
      await expect(
        service.enable([BypassableRule.CHECK_IN_GEOFENCE], 'Testing the check-in flow', MAX_BYPASS_HOURS + 1, admin),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses a throwaway reason', async () => {
      // The reason is what someone reading the audit trail in six months has to work from.
      await expect(service.enable([BypassableRule.CHECK_IN_GEOFENCE], 'test', 2, admin))
        .rejects.toThrow(BadRequestException);
    });

    it('refuses an empty rule list', async () => {
      await expect(service.enable([], 'Testing the check-in flow end to end', 2, admin))
        .rejects.toThrow(BadRequestException);
    });

    it('refuses a rule it does not know', async () => {
      await expect(service.enable(['DELETE_EVERYTHING' as any], 'Testing the check-in flow', 2, admin))
        .rejects.toThrow(BadRequestException);
    });

    it('stamps an expiry from the requested duration', async () => {
      const before = Date.now();
      await service.enable([BypassableRule.CHECK_IN_GEOFENCE], 'Testing the check-in flow end to end', 2, admin);
      const expiresAt = (saved as any).expiresAt.getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + 2 * 3_600_000 - 5_000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 2 * 3_600_000 + 5_000);
    });

    it('records who did it, and what it covers, in the audit trail', async () => {
      await service.enable(
        [BypassableRule.CHECK_IN_GEOFENCE, BypassableRule.SKILLS_AND_CERTIFICATIONS],
        'Testing the mobile check-in flow before the pilot',
        1,
        admin,
      );
      expect(audit.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'RULE_BYPASS_ENABLED',
          userId: admin.id,
          remarks: expect.stringContaining('Testing the mobile check-in flow before the pilot'),
        }),
      );
    });

    it('replaces the running window rather than merging with it', async () => {
      // Merging would let a window grow rule by rule until nobody could say what was off.
      currentWindowIs(liveWindow([BypassableRule.HOLIDAY_CALENDAR]));
      await service.enable([BypassableRule.CHECK_IN_GEOFENCE], 'Testing the check-in flow end to end', 1, admin);
      expect((saved as any).rules).toEqual([BypassableRule.CHECK_IN_GEOFENCE]);
      // The previous window is closed, not left running alongside.
      expect(repo.update).toHaveBeenCalledWith(
        expect.objectContaining({ revokedAt: expect.anything() }),
        expect.objectContaining({ revokedBy: admin.id }),
      );
    });
  });

  describe('recording what a window was used for', () => {
    beforeEach(async () => {
      currentWindowIs(liveWindow([BypassableRule.CHECK_IN_GEOFENCE, BypassableRule.HOLIDAY_CALENDAR]));
      await service.isBypassed(BypassableRule.CHECK_IN_GEOFENCE); // warm the cache
      jest.clearAllMocks();
    });

    it('writes an audit event against the record when an evidential rule is skipped', () => {
      // The geofence IS the attendance evidence. Skipping it has to be attached to the
      // assignment, or a check-in from 600 km away is indistinguishable from a GPS failure.
      service.noteBypass(BypassableRule.CHECK_IN_GEOFENCE, {
        entityType: 'ASSIGNMENT', entityId: 'asn-1', userId: 'assayer-9', detail: '612 km from the branch',
      });
      expect(audit.recordEventSafe).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'RULE_BYPASSED',
          entityType: 'ASSIGNMENT',
          entityId: 'asn-1',
          remarks: expect.stringContaining('612 km from the branch'),
        }),
      );
    });

    it('does not raise an evidence event for a merely operational rule', () => {
      // A holiday clash changes what you can schedule, not what a finished audit means.
      service.noteBypass(BypassableRule.HOLIDAY_CALENDAR, { entityType: 'ASSIGNMENT', entityId: 'asn-2' });
      expect(audit.recordEventSafe).not.toHaveBeenCalled();
    });

    /**
     * The case that was silently broken: a rule evaluator skipping a check has no assignment or
     * assayer id to hand, and the audit column is a NOT NULL uuid. Anchoring to the window means
     * the event still writes — without this, constraint-level skips left no trace at all.
     */
    it('still records a skip that has no entity to attach to', () => {
      service.noteBypass(BypassableRule.SKILLS_AND_CERTIFICATIONS, { detail: 'missing certification: Gold L2' });
      expect(audit.recordEventSafe).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'RULE_BYPASSED',
          entityType: 'RULE_BYPASS_WINDOW',
          // A real uuid, not a placeholder string the column would reject.
          entityId: 'win-1',
        }),
      );
    });

    it('never lets recording a skip fail the operation it is recording', () => {
      audit.recordEventSafe.mockRejectedValueOnce(new Error('audit sink down'));
      expect(() =>
        service.noteBypass(BypassableRule.CHECK_IN_GEOFENCE, { entityType: 'ASSIGNMENT', entityId: 'asn-3' }),
      ).not.toThrow();
    });
  });

  it('closing a window reports what it was actually used for', async () => {
    const window = liveWindow([BypassableRule.CHECK_IN_GEOFENCE]);
    currentWindowIs(window);
    /**
     * The counts come from a re-read, not from the cached row. Usage is flushed
     * asynchronously, so the cached copy routinely predates the counts — reporting from it
     * produced a closing record that said "never used" about a window that had been.
     */
    repo.findOne.mockResolvedValue({
      ...window,
      usageCounts: { [BypassableRule.CHECK_IN_GEOFENCE]: 40 },
    });

    await service.disable(admin);

    // "We turned the geofence off for two hours" and "…and 40 check-ins used it" are a note and
    // a finding respectively. The closing record has to be the second one.
    expect(audit.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'RULE_BYPASS_DISABLED',
        remarks: expect.stringContaining('40'),
      }),
    );
  });
});
