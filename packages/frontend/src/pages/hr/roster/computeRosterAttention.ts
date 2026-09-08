import {
  AssayerLifecycleStatus,
  cannotBePaid,
  stillWorkable,
  daysUntilExpiry,
} from '@fapoms/shared';
import type { RosterAttentionState } from '../../../config/status-registry';
import type { RosterPerson } from '../roster-filters';
import { isAwaitingDocumentCheck, isAwaitingBackgroundCheck, missingCriticalFields } from '../assayer-shared';

export interface RosterAttentionDetail {
  state: RosterAttentionState;
  reason?: string;
}

/**
 * Computes deterministic operational attention for workforce roster records.
 *
 * Deterministic Precedence:
 * 1. ACTION_REQUIRED: Joining candidates awaiting document or background verification desk review.
 * 2. PAYOUT_BLOCKED: Still-workable assayer missing PAN, IFSC, or Bank Account.
 * 3. EMPANELMENT_ISSUE: Active/workable assayer with expired certification or 0 plannable client banks.
 * 4. DEPLOYABLE: ACTIVE assayer, fully workable, no payout blocker, and plannable with at least one client.
 * 5. NORMAL: Standard or dormant record with no immediate operational blocker.
 */
export function computeRosterAttention(person: RosterPerson): RosterAttentionDetail {
  const isWorkable = stillWorkable(person);

  // Tier 1: Action Required (onboarding pipeline bottlenecks)
  if (isAwaitingDocumentCheck(person)) {
    return {
      state: 'ACTION_REQUIRED',
      reason: 'Documents submitted; awaiting reviewer verification',
    };
  }
  if (isAwaitingBackgroundCheck(person)) {
    return {
      state: 'ACTION_REQUIRED',
      reason: 'Awaiting background verification check recording',
    };
  }

  // Tier 2: Payout Blocked (Respects strict backend stillWorkable boundary)
  if (isWorkable && cannotBePaid(person as any)) {
    return {
      state: 'PAYOUT_BLOCKED',
      reason: 'Missing mandatory payout credentials (PAN, Bank, or IFSC)',
    };
  }

  // Tier 3: Empanelment Issue (Expired certification or 0 plannable client banks while ACTIVE)
  const hasExpiredCert = (person.certifications ?? []).some(
    (c) => c.expiryDate && (daysUntilExpiry(c.expiryDate) ?? 1) < 0,
  );
  if (isWorkable && person.lifecycleStatus === AssayerLifecycleStatus.ACTIVE) {
    if (hasExpiredCert) {
      return {
        state: 'EMPANELMENT_ISSUE',
        reason: 'Professional certification has expired',
      };
    }
    const empanelment = (person as any).empanelment;
    if (empanelment && empanelment.clientCount > 0 && empanelment.plannableClients === 0) {
      return {
        state: 'EMPANELMENT_ISSUE',
        reason: `Vetted by ${empanelment.clientCount} clients, but 0 currently plannable`,
      };
    }
  }

  // Tier 4: Deployable (Authoritative backend facts)
  if (isWorkable && person.lifecycleStatus === AssayerLifecycleStatus.ACTIVE) {
    const criticalMissing = missingCriticalFields(person);
    const empanelment = (person as any).empanelment;
    const isPlannable = empanelment ? empanelment.plannableClients > 0 : true; // default if not hydrated

    if (criticalMissing.length === 0 && !hasExpiredCert && isPlannable) {
      return {
        state: 'DEPLOYABLE',
        reason: empanelment?.plannableClients
          ? `Deployable across ${empanelment.plannableClients} client bank${empanelment.plannableClients === 1 ? '' : 's'}`
          : 'Active and clear for deployment',
      };
    }
  }

  // Tier 5: Normal
  return {
    state: 'NORMAL',
    reason: undefined,
  };
}
