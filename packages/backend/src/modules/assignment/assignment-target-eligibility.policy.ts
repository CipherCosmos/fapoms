import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { EntityManager, DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { SystemRole, standingAllowsPlanning, BypassableRule } from '@fapoms/shared';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { RuleBypassService } from '../platform/rule-bypass/rule-bypass.service';
import { NO_EMPANELMENT_ROW_SETTING } from '../planning/recommendation.engine';

/**
 * Whether a given assayer may hold a given assignment — asked once, answered once.
 *
 * Creating an assignment and reassigning one put the same assayer on the same client's work,
 * so they have to apply the same rule. They did not. `create()` enforced the client's restricted
 * list, the empanelment standing, the hard-blocked standings and an audited override;
 * `reassignAssignment()` enforced none of it and checked only that the incoming assayer was
 * ACTIVE. Reassignment was therefore a documented route around every eligibility control the
 * create path had: assign to someone eligible, then reassign to someone who is not.
 *
 * The rule now lives here and nowhere else. Both paths call `evaluate()` and act on the decision
 * it returns; neither re-implements a condition. A decision is data — outcome, machine-readable
 * reason code, human message, and whether an override could lift it — precisely so a caller
 * cannot quietly downgrade a hard block into a warning, and so the frontend never has to guess
 * at eligibility for itself. The panel that offers "assign anyway" is a *reflection* of
 * `overridable`, never the thing that decides it.
 */

/** Why a target was refused. Stable strings — clients and tests match on these, not on prose. */
export enum EligibilityReasonCode {
  ASSAYER_NOT_ACTIVE = 'ASSAYER_NOT_ACTIVE',
  ASSAYER_RESTRICTED_BY_CLIENT = 'ASSAYER_RESTRICTED_BY_CLIENT',
  EMPANELMENT_STANDING_NON_OVERRIDABLE = 'EMPANELMENT_STANDING_NON_OVERRIDABLE',
  EMPANELMENT_STANDING_NOT_PLANNABLE = 'EMPANELMENT_STANDING_NOT_PLANNABLE',
  NO_EMPANELMENT_RECORD = 'NO_EMPANELMENT_RECORD',
}

/**
 * Standings that no override may pass, however senior the actor.
 *
 * These are not "not yet approved" — they are decisions already taken against this pairing.
 * A rejected or terminated empanelment that an operations lead can wave through with a
 * ten-character sentence is not a control at all.
 */
export const STRICTLY_NON_OVERRIDABLE_STANDINGS = ['REJECTED', 'TERMINATED', 'EXPIRED', 'SUSPENDED'];

/** Permission an actor must hold to override a soft block. Reported so the caller can say so. */
export const EMPANELMENT_OVERRIDE_PERMISSION = 'ASSIGNMENT:OVERRIDE';

/** Minimum length of a written override reason. A reason nobody can read is not a reason. */
export const MIN_OVERRIDE_REASON_LENGTH = 10;

/** The empanelment row as it stood when the decision was taken, for the snapshot the caller keeps. */
export interface EmpanelmentSnapshot {
  standing: string | null;
  empanelmentId: string | null;
  empanelmentEffectiveAt: Date | null;
}

export interface EligibilityAllowed extends EmpanelmentSnapshot {
  outcome: 'ALLOWED';
}

export interface EligibilityBlocked extends EmpanelmentSnapshot {
  outcome: 'BLOCKED';
  reasonCode: EligibilityReasonCode;
  message: string;
  /** False means no override exists. Callers must not invent one. */
  overridable: boolean;
  /** Set only when `overridable` — the permission the overriding actor must hold. */
  requiredPermission: string | null;
}

export type EligibilityDecision = EligibilityAllowed | EligibilityBlocked;

export interface EligibilityTarget {
  id: string;
  status?: string | null;
  isActive?: boolean | null;
  displayName?: string | null;
  assayerCode?: string | null;
}

export interface EligibilityRequest {
  assayer: EligibilityTarget;
  /** Null for work with no client — then only the assayer's own status is in question. */
  clientId: string | null | undefined;
  clientLabel?: string | null;
  restrictedAssayers?: string[] | null;
  /**
   * Pass the transaction's manager to have the empanelment row read (and locked FOR SHARE)
   * inside it. Omit for the pre-flight read outside the transaction.
   */
  manager?: EntityManager;
  /** FOR SHARE the empanelment row so it cannot be revoked between decision and write. */
  lockEmpanelment?: boolean;
}

export interface OverrideAttempt {
  /** The actor asking to proceed anyway. */
  userId: string;
  /** Their written justification. */
  overrideReason?: string | null;
  /**
   * Set when an earlier evaluation in the same request already found an open bypass window.
   *
   * A request must be judged against one state of the world, not two. `create()` asks the policy
   * twice — once before the transaction so the caller gets a fast refusal, once inside it under
   * the row lock — and without this, a window that closes between the two calls turns an accepted
   * assignment into a 400 halfway through, and a window that opens between them lets one through
   * that the pre-flight refused. The first answer is the one that governs.
   */
  priorBypassGranted?: boolean;
}

/** What an accepted override produced, for the caller to persist onto the assignment. */
export interface OverrideOutcome {
  used: boolean;
  reason: string | null;
  by: string | null;
  /** True when a platform bypass window carried it, not a person. Recorded distinctly. */
  viaBypassWindow: boolean;
}

@Injectable()
export class AssignmentTargetEligibilityService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: PlatformSettingsService,
    private readonly ruleBypass: RuleBypassService,
  ) {}

  private label(a: EligibilityTarget): string {
    return a.displayName || a.assayerCode || a.id;
  }

  /**
   * The whole rule, in order of severity. Returns a decision; throws nothing.
   *
   * Callers decide what to do with a BLOCKED decision — create and reassign both refuse it
   * unless a valid override applies, but the policy does not reach into their control flow.
   */
  async evaluate(req: EligibilityRequest): Promise<EligibilityDecision> {
    const { assayer } = req;
    const who = this.label(assayer);
    const clientLabel = req.clientLabel || 'this client';
    const empty: EmpanelmentSnapshot = { standing: null, empanelmentId: null, empanelmentEffectiveAt: null };

    // An assayer who is not operationally active cannot hold work for anybody. `status` is
    // checked only when the caller supplied one — some call sites hold a partial projection.
    if (assayer.status != null && (assayer.status !== 'ACTIVE' || assayer.isActive === false)) {
      return {
        outcome: 'BLOCKED',
        reasonCode: EligibilityReasonCode.ASSAYER_NOT_ACTIVE,
        message: `${who} has status '${assayer.status}' and cannot be assigned work (must be ACTIVE).`,
        overridable: false,
        requiredPermission: null,
        ...empty,
      };
    }

    // No client on the work means no client eligibility to satisfy.
    if (!req.clientId) return { outcome: 'ALLOWED', ...empty };

    // The client has named this assayer as barred. Stated as strictly non-overridable on the
    // create path since it was written, and it stays that way here.
    if ((req.restrictedAssayers || []).includes(assayer.id)) {
      return {
        outcome: 'BLOCKED',
        reasonCode: EligibilityReasonCode.ASSAYER_RESTRICTED_BY_CLIENT,
        message: `${who} is on ${clientLabel}'s restricted list. This restriction is strictly non-overridable.`,
        overridable: false,
        requiredPermission: null,
        ...empty,
      };
    }

    const q = req.manager || this.dataSource;
    const rows = await q.query(
      `SELECT id, status, created_at FROM assayer_client_empanelments
       WHERE assayer_id = $1 AND client_id = $2 AND is_active = true
       ${req.lockEmpanelment ? 'FOR SHARE' : ''} LIMIT 1`,
      [assayer.id, req.clientId],
    );
    const row = rows?.[0] ?? null;
    const snapshot: EmpanelmentSnapshot = {
      standing: row?.status ?? null,
      empanelmentId: row?.id ?? null,
      empanelmentEffectiveAt: row?.created_at ? new Date(row.created_at) : null,
    };
    const standing: string | undefined = row?.status;

    if (standing === undefined || standing === null) {
      // Whether a missing empanelment blocks is a platform setting, not a constant. Default is
      // BLOCK: silence about a pairing is not evidence that it was approved.
      const noRowPolicy = await this.settings.get<string>(NO_EMPANELMENT_ROW_SETTING).catch(() => 'BLOCK');
      if (noRowPolicy === 'ALLOW') return { outcome: 'ALLOWED', ...snapshot };
      return {
        outcome: 'BLOCKED',
        reasonCode: EligibilityReasonCode.NO_EMPANELMENT_RECORD,
        message: `${who} has no active empanelment record with ${clientLabel}.`,
        overridable: true,
        requiredPermission: EMPANELMENT_OVERRIDE_PERMISSION,
        ...snapshot,
      };
    }

    if (STRICTLY_NON_OVERRIDABLE_STANDINGS.includes(String(standing).toUpperCase())) {
      return {
        outcome: 'BLOCKED',
        reasonCode: EligibilityReasonCode.EMPANELMENT_STANDING_NON_OVERRIDABLE,
        message: `Empanelment standing '${standing}' for ${who} with ${clientLabel} is strictly non-overridable.`,
        overridable: false,
        requiredPermission: null,
        ...snapshot,
      };
    }

    if (!standingAllowsPlanning(standing)) {
      return {
        outcome: 'BLOCKED',
        reasonCode: EligibilityReasonCode.EMPANELMENT_STANDING_NOT_PLANNABLE,
        message: `${who} has empanelment standing ${standing} with ${clientLabel} — not Active or Recommended.`,
        overridable: true,
        requiredPermission: EMPANELMENT_OVERRIDE_PERMISSION,
        ...snapshot,
      };
    }

    return { outcome: 'ALLOWED', ...snapshot };
  }

  /**
   * Apply a blocked decision: either raise it, or accept a legitimate override.
   *
   * A non-overridable block always throws, whatever the actor holds and whatever they wrote —
   * checked before the reason and before the permission, so no ordering accident can let one
   * through. An overridable block needs all three of: a written reason of real length, the
   * server-side permission (never a claim from the client), and an audit record, which is the
   * `OverrideOutcome` the caller persists onto the assignment.
   */
  async resolveBlock(
    decision: EligibilityBlocked,
    attempt: OverrideAttempt,
    manager?: EntityManager,
  ): Promise<OverrideOutcome> {
    if (!decision.overridable) {
      throw new ForbiddenException(`${decision.message} Assignment cannot proceed.`);
    }

    // A platform bypass window is a deliberate, time-boxed, separately-audited operations
    // decision. It carries the block without a per-request reason, and is recorded as itself
    // rather than being dressed up as somebody's written justification.
    if (attempt.priorBypassGranted || this.ruleBypass.isBypassedSync(BypassableRule.CLIENT_ELIGIBILITY)) {
      return { used: true, reason: decision.message, by: attempt.userId ?? null, viaBypassWindow: true };
    }

    const reason = (attempt.overrideReason ?? '').trim();
    if (reason.length < MIN_OVERRIDE_REASON_LENGTH) {
      throw new BadRequestException(
        `${decision.message} Assigning anyway requires an override reason of at least `
        + `${MIN_OVERRIDE_REASON_LENGTH} characters explaining why client eligibility is waived.`,
      );
    }

    await this.assertMayOverride(attempt.userId, manager);
    return { used: true, reason, by: attempt.userId, viaBypassWindow: false };
  }

  /**
   * Does this actor hold the authority to waive client eligibility?
   *
   * Read from the database against the actor's own roles and permissions. Nothing the request
   * carried is consulted, because an override that the caller can assert is not an override.
   */
  async assertMayOverride(userId: string, manager?: EntityManager): Promise<void> {
    if (!userId || userId === '00000000-0000-0000-0000-000000000000') {
      // System-initiated work (seeding, scheduled jobs) has no role row to read. It is already
      // inside the trust boundary; there is no user to hold a permission.
      return;
    }
    const q = manager || this.dataSource;
    const rows = await q.query(
      `SELECT r.name as role_name, p.resource, p.action
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id
       WHERE ur.user_id = $1`,
      [userId],
    );
    if (!rows || rows.length === 0) {
      throw new ForbiddenException(
        `Actor lacks ${EMPANELMENT_OVERRIDE_PERMISSION} and cannot override client eligibility.`,
      );
    }
    const roles = rows.map((r: any) => r.role_name).filter(Boolean);
    const privilegedRole = roles.some((r: string) =>
      [
        SystemRole.ADMIN,
        SystemRole.OPERATIONS,
        SystemRole.DEVELOPER,
        'SUPER_ADMINISTRATOR',
        'ADMINISTRATOR',
        'OPERATIONS_MANAGER',
        'OPERATIONS_HEAD',
      ].includes(r as any),
    );
    const explicitPermission = rows.some((r: any) =>
      (r.resource === 'ASSIGNMENT' && ['OVERRIDE', 'APPROVE', 'CREATE'].includes(r.action)) ||
      (r.resource === 'PLANNING' && ['APPROVE', 'OVERRIDE'].includes(r.action)),
    );
    if (!privilegedRole && !explicitPermission) {
      throw new ForbiddenException(
        `Actor lacks ${EMPANELMENT_OVERRIDE_PERMISSION} and cannot override client eligibility.`,
      );
    }
  }
}
