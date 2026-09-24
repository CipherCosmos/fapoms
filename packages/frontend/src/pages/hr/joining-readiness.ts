import {
  IDENTITY_GATE_DOCUMENTS, ONBOARDING_DOCUMENT_LABELS, payoutBlockingGaps, type OnboardingDocument,
} from '@fapoms/shared';
import { ADVERSE_BACKGROUND_VERDICTS, VERDICT_LABELS } from './AssayerVettingTab';
import { missingCriticalFields, type Assayer } from './assayer-shared';
import type { AssayerDossier, PaperworkDocument } from './record/record-types';

/**
 * Whether somebody is ready to be made Active — one rule, for the three screens that ask.
 *
 * It lived inside the joining drawer, which was fine while the drawer's Training step was the only
 * way to Active. Since approving can make somebody Active straight away (2026-09-24), the approval
 * panel on the record and the approver's review ask the same question — and the record and the
 * drawer already import from each other, so it moved here rather than deepen that circle.
 */

/** Where the desk fixes a checklist item, in the joining drawer's work areas. */
export type WorkArea = 'documents' | 'background' | 'bank';

export interface ChecklistItem {
  label: string;
  done: boolean;
  /** When false the item is shown for information and never holds the button back. */
  blocking: boolean;
  /** Where the clerk fixes it. */
  area?: WorkArea;
}

export const hasScan = (d?: PaperworkDocument) => !!d && (d.filePaths ?? []).length > 0;

/** "Checked" for one identity document, in the words the checklist uses. */
export function identityItem(label: string, doc: PaperworkDocument | undefined): ChecklistItem {
  if (!doc || !hasScan(doc)) return { label: `${label}: scan uploaded and checked`, done: false, blocking: true, area: 'documents' };
  if (doc.verificationStatus === 'REJECTED') return { label: `${label}: sent back — a new scan is needed`, done: false, blocking: true, area: 'documents' };
  return { label: `${label}: checked against the original`, done: doc.verificationStatus === 'VERIFIED', blocking: true, area: 'documents' };
}

/**
 * WHAT MAKING SOMEBODY ACTIVE NEEDS — the same gates `doTransitionLifecycle` runs at ACTIVE, in the
 * order it runs them: the identity documents, then the bank account, IFSC and home location, and no
 * adverse background check.
 *
 * One list for every place that asks: the Training step's checklist here, and — since approving can
 * make somebody Active straight away (owner, 2026-09-24) — the approver's "Approve — make Active" on
 * the approval panel and the review screen. Written twice, the approver would be offered a button
 * the server then refuses for a reason neither list mentioned.
 */
export function activationChecklist(candidate: Assayer, dossier: AssayerDossier | undefined): ChecklistItem[] {
  const docs = dossier?.onboarding ?? [];
  const verdict = dossier?.currentCheck?.verdict ?? null;
  const adverse = !!verdict && ADVERSE_BACKGROUND_VERDICTS.includes(verdict);
  const gaps = payoutBlockingGaps(candidate as unknown as Record<string, unknown>).map((f) => f.key);
  /*
    ONE PAN, IN ONE PLACE.

    This list used to open with a bare "PAN" that sent the desk to a PAN box in the bank form,
    while the Documents step had its own PAN — the card, its number, its verification. Same
    number, two forms, two steps, two different things both called "PAN". The number now lives
    with the card it is printed on, and the one item here says which half is still missing.
  */
  const identityItems: ChecklistItem[] = IDENTITY_GATE_DOCUMENTS.map((requirement) => {
    const row = docs.find((d) => d.requirement === requirement);
    const label = row?.label ?? ONBOARDING_DOCUMENT_LABELS[requirement as OnboardingDocument] ?? requirement;
    if (requirement === 'PAN_CARD' && gaps.includes('panNumber')) {
      return { label: `${label}: its number is not recorded yet`, done: false, blocking: true, area: 'documents' };
    }
    return identityItem(label, row);
  });
  const items: ChecklistItem[] = [
    ...identityItems,
    { label: 'Bank account number', done: !gaps.includes('bankAccountNumber'), blocking: true, area: 'bank' },
    { label: 'IFSC', done: !gaps.includes('ifscCode'), blocking: true, area: 'bank' },
    { label: 'Home location pinned', done: candidate.latitude != null && candidate.longitude != null, blocking: true, area: 'bank' },
  ];
  if (adverse) {
    items.push({ label: `Background check result: ${VERDICT_LABELS[verdict!] ?? verdict} — a new check must clear them`, done: false, blocking: true, area: 'background' });
  }
  // The rest of the record's key fields. Activation does not wait for them, but the roster
  // lists a trainee as "ready to activate" only once they are in — so say which are missing.
  for (const f of missingCriticalFields(candidate)) {
    if (['panNumber', 'bankAccountNumber', 'ifscCode', 'latitude'].includes(String(f.key))) continue;
    items.push({ label: f.label, done: false, blocking: false, area: 'bank' });
  }
  return items;
}

/** What "make Active" is still waiting on, in the checklist's own words — empty when nothing is. */
export function activationBlockers(candidate: Assayer, dossier: AssayerDossier | undefined): string[] {
  return activationChecklist(candidate, dossier).filter((i) => i.blocking && !i.done).map((i) => i.label);
}
