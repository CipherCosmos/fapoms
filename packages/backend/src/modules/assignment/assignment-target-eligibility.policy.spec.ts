import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  AssignmentTargetEligibilityService,
  EligibilityReasonCode,
  STRICTLY_NON_OVERRIDABLE_STANDINGS,
  type EligibilityBlocked,
} from './assignment-target-eligibility.policy';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { RuleBypassService } from '../platform/rule-bypass/rule-bypass.service';

/**
 * One policy, asked the same questions the two write paths ask it.
 *
 * These tests exist because `createAssignment` and `reassignAssignment` used to answer this
 * question separately — create enforced client eligibility, reassign enforced nothing — so the
 * documented way around every empanelment control was to create an assignment for someone
 * eligible and then reassign it. The point of the extraction is that there is now one
 * implementation to test, and both callers are wired to it.
 */
describe('AssignmentTargetEligibilityService', () => {
  let service: AssignmentTargetEligibilityService;

  const ASSAYER = 'aa000000-0000-4000-a000-000000000001';
  const CLIENT = 'cc000000-0000-4000-c000-000000000001';
  const ACTOR = 'uu000000-0000-4000-u000-000000000001';

  const query = jest.fn();
  const mockDataSource = { query };
  const settingsGet = jest.fn();
  const isBypassedSync = jest.fn();

  const target = { id: ASSAYER, status: 'ACTIVE', isActive: true, displayName: 'A. Assayer', assayerCode: 'ASY-1' };

  /** Empanelment lookup answers with `rows`; the role lookup that follows answers with `roles`. */
  const withEmpanelment = (rows: any[]) => query.mockResolvedValueOnce(rows);
  const withRoles = (roles: any[]) => query.mockResolvedValueOnce(roles);

  beforeEach(async () => {
    jest.clearAllMocks();
    settingsGet.mockResolvedValue('BLOCK');
    isBypassedSync.mockReturnValue(false);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AssignmentTargetEligibilityService,
        { provide: getDataSourceToken(), useValue: mockDataSource },
        { provide: PlatformSettingsService, useValue: { get: settingsGet } },
        { provide: RuleBypassService, useValue: { isBypassedSync } },
      ],
    }).compile();
    service = module.get(AssignmentTargetEligibilityService);
  });

  describe('evaluate', () => {
    it('allows an ACTIVE standing', async () => {
      withEmpanelment([{ id: 'e1', status: 'ACTIVE', created_at: '2026-01-01T00:00:00Z' }]);
      const d = await service.evaluate({ assayer: target, clientId: CLIENT });
      expect(d.outcome).toBe('ALLOWED');
      expect(d.standing).toBe('ACTIVE');
      expect(d.empanelmentId).toBe('e1');
    });

    it('allows a RECOMMENDED standing', async () => {
      withEmpanelment([{ id: 'e1', status: 'RECOMMENDED', created_at: null }]);
      expect((await service.evaluate({ assayer: target, clientId: CLIENT })).outcome).toBe('ALLOWED');
    });

    it('refuses an assayer who is not operationally active, before asking about the client', async () => {
      const d = await service.evaluate({
        assayer: { ...target, status: 'SUSPENDED' },
        clientId: CLIENT,
      });
      expect(d.outcome).toBe('BLOCKED');
      expect((d as EligibilityBlocked).reasonCode).toBe(EligibilityReasonCode.ASSAYER_NOT_ACTIVE);
      expect((d as EligibilityBlocked).overridable).toBe(false);
      // No empanelment lookup happened — the assayer is out regardless of the client.
      expect(query).not.toHaveBeenCalled();
    });

    it('refuses an assayer on the client’s restricted list, and offers no override', async () => {
      const d = await service.evaluate({
        assayer: target,
        clientId: CLIENT,
        restrictedAssayers: [ASSAYER],
      });
      expect(d.outcome).toBe('BLOCKED');
      expect((d as EligibilityBlocked).reasonCode).toBe(EligibilityReasonCode.ASSAYER_RESTRICTED_BY_CLIENT);
      expect((d as EligibilityBlocked).overridable).toBe(false);
    });

    it.each(STRICTLY_NON_OVERRIDABLE_STANDINGS)(
      'refuses standing %s as non-overridable',
      async (standing) => {
        withEmpanelment([{ id: 'e1', status: standing, created_at: null }]);
        const d = await service.evaluate({ assayer: target, clientId: CLIENT });
        expect(d.outcome).toBe('BLOCKED');
        expect((d as EligibilityBlocked).reasonCode)
          .toBe(EligibilityReasonCode.EMPANELMENT_STANDING_NON_OVERRIDABLE);
        expect((d as EligibilityBlocked).overridable).toBe(false);
      },
    );

    it('treats a lower-cased hard-blocked standing the same way', async () => {
      withEmpanelment([{ id: 'e1', status: 'terminated', created_at: null }]);
      const d = await service.evaluate({ assayer: target, clientId: CLIENT });
      expect((d as EligibilityBlocked).overridable).toBe(false);
    });

    it('marks a non-plannable standing as overridable, and names the permission', async () => {
      withEmpanelment([{ id: 'e1', status: 'DOCUMENTS_PENDING', created_at: null }]);
      const d = await service.evaluate({ assayer: target, clientId: CLIENT }) as EligibilityBlocked;
      expect(d.outcome).toBe('BLOCKED');
      expect(d.reasonCode).toBe(EligibilityReasonCode.EMPANELMENT_STANDING_NOT_PLANNABLE);
      expect(d.overridable).toBe(true);
      expect(d.requiredPermission).toBe('ASSIGNMENT:OVERRIDE');
    });

    it('blocks a missing empanelment record by default', async () => {
      withEmpanelment([]);
      const d = await service.evaluate({ assayer: target, clientId: CLIENT }) as EligibilityBlocked;
      expect(d.reasonCode).toBe(EligibilityReasonCode.NO_EMPANELMENT_RECORD);
      expect(d.overridable).toBe(true);
    });

    it('allows a missing empanelment record when the platform setting says ALLOW', async () => {
      settingsGet.mockResolvedValue('ALLOW');
      withEmpanelment([]);
      expect((await service.evaluate({ assayer: target, clientId: CLIENT })).outcome).toBe('ALLOWED');
    });

    it('asks nothing about empanelment when the work has no client', async () => {
      expect((await service.evaluate({ assayer: target, clientId: null })).outcome).toBe('ALLOWED');
      expect(query).not.toHaveBeenCalled();
    });

    it('locks the empanelment row when asked to', async () => {
      withEmpanelment([{ id: 'e1', status: 'ACTIVE', created_at: null }]);
      await service.evaluate({ assayer: target, clientId: CLIENT, lockEmpanelment: true });
      expect(query.mock.calls[0][0]).toContain('FOR SHARE');
    });

    it('does not lock when not asked to', async () => {
      withEmpanelment([{ id: 'e1', status: 'ACTIVE', created_at: null }]);
      await service.evaluate({ assayer: target, clientId: CLIENT });
      expect(query.mock.calls[0][0]).not.toContain('FOR SHARE');
    });
  });

  describe('resolveBlock', () => {
    const hardBlock: EligibilityBlocked = {
      outcome: 'BLOCKED',
      reasonCode: EligibilityReasonCode.EMPANELMENT_STANDING_NON_OVERRIDABLE,
      message: 'Standing REJECTED is strictly non-overridable.',
      overridable: false,
      requiredPermission: null,
      standing: 'REJECTED',
      empanelmentId: 'e1',
      empanelmentEffectiveAt: null,
    };
    const softBlock: EligibilityBlocked = {
      ...hardBlock,
      reasonCode: EligibilityReasonCode.EMPANELMENT_STANDING_NOT_PLANNABLE,
      message: 'Standing DOCUMENTS_PENDING is not plannable.',
      overridable: true,
      requiredPermission: 'ASSIGNMENT:OVERRIDE',
      standing: 'DOCUMENTS_PENDING',
    };

    it('refuses a hard block outright, however long the reason', async () => {
      await expect(
        service.resolveBlock(hardBlock, { userId: ACTOR, overrideReason: 'a'.repeat(500) }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Neither the permission nor the bypass window was even consulted.
      expect(query).not.toHaveBeenCalled();
      expect(isBypassedSync).not.toHaveBeenCalled();
    });

    it('refuses a hard block even inside an active bypass window', async () => {
      isBypassedSync.mockReturnValue(true);
      await expect(
        service.resolveBlock(hardBlock, { userId: ACTOR, overrideReason: 'operations approved this' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses a soft block with no reason', async () => {
      await expect(service.resolveBlock(softBlock, { userId: ACTOR }))
        .rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a soft block with a reason under ten characters', async () => {
      await expect(service.resolveBlock(softBlock, { userId: ACTOR, overrideReason: 'too short' }))
        .rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a soft block when the actor holds no override permission', async () => {
      withRoles([{ role_name: 'DESK', resource: 'ASSIGNMENT', action: 'READ' }]);
      await expect(
        service.resolveBlock(softBlock, { userId: ACTOR, overrideReason: 'client confirmed by email' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses a soft block when the actor has no roles at all', async () => {
      withRoles([]);
      await expect(
        service.resolveBlock(softBlock, { userId: ACTOR, overrideReason: 'client confirmed by email' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('accepts a soft block override from a privileged role, and reports what was recorded', async () => {
      withRoles([{ role_name: 'OPERATIONS', resource: 'ASSIGNMENT', action: 'CREATE' }]);
      const out = await service.resolveBlock(softBlock, {
        userId: ACTOR,
        overrideReason: 'client confirmed by email',
      });
      expect(out).toEqual({
        used: true,
        reason: 'client confirmed by email',
        by: ACTOR,
        viaBypassWindow: false,
      });
    });

    it('accepts a soft block from an explicit ASSIGNMENT:OVERRIDE permission without a privileged role', async () => {
      withRoles([{ role_name: 'DESK', resource: 'ASSIGNMENT', action: 'OVERRIDE' }]);
      const out = await service.resolveBlock(softBlock, {
        userId: ACTOR,
        overrideReason: 'client confirmed by email',
      });
      expect(out.used).toBe(true);
    });

    it('records a bypass window as a bypass, not as somebody’s written reason', async () => {
      isBypassedSync.mockReturnValue(true);
      const out = await service.resolveBlock(softBlock, { userId: ACTOR });
      expect(out.viaBypassWindow).toBe(true);
      expect(out.reason).toBe(softBlock.message);
      // No permission lookup: the window is the authority, and it is audited separately.
      expect(query).not.toHaveBeenCalled();
    });
  });
});
