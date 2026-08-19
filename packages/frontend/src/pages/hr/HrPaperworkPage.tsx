import React from 'react';
import { ViewChips, useViewParam } from './hr-ui';
import { useHr } from './HrLayout';
import { HrRecordsPage } from './HrRecordsPage';
import { HrCompliancePage } from './HrCompliancePage';
import { HrDocumentsPage } from './HrDocumentsPage';

/**
 * Paperwork — everything about a person's file that is missing, unverified or about to lapse.
 *
 * WHY THIS EXISTS AS ONE PAGE (please do not split it back into three):
 *
 * HR used to carry three separate tabs — Records, Compliance and Documents — and all three
 * badged off the *same* underlying number. Records and Compliance both showed
 * `compliance.incompleteCount`; Documents showed the government-document gap, which is the other
 * half of the same "this person's file is not complete" problem. So an HR manager reading
 * "26 missing bank accounts" on the Overview had three tabs to guess between and no way to tell
 * which one actually fixed it. Records was worse than ambiguous: it was built and routed but was
 * never put in the tab list, so for a long time the only way in was an old bookmark — the alert
 * literally had no reachable answer.
 *
 * The three concerns are real; three *destinations* were not. They are now one destination with
 * plain-language filter chips, so the badge points at exactly one place and the chips narrow it:
 *
 *   Bank & personal details  — which payroll / duty-of-care fields are blank, and whose
 *   ID documents             — the identity-document register: record, verify, reject, remove
 *   Certificates & expiries  — what has lapsed or is about to, plus the capability inventory
 *
 * The chip bodies are the previous page components, mounted unchanged. That is deliberate: this
 * was a re-grouping of screens, not a rewrite of them, so every query, callback and permission
 * check inside them (HR-gated verify/reject, admin-only delete, canManage on the fix links) is
 * exactly the one that was reviewed before. Old `/hr/records`, `/hr/compliance` and
 * `/hr/documents` URLs redirect here with the matching `?view=` already selected — see
 * LEGACY_PATHS in HrLayout.
 *
 * The badge on this page counts only what this page can *resolve*: incomplete personnel fields
 * plus people with no identity document on file. Expired certifications are deliberately NOT
 * added in — they are badged on Skills & Certificates, which is the only screen that can record
 * a renewal. One number, one place to go, is the whole point of the merge.
 */

const VIEWS = [
  { key: 'details', label: 'Bank & personal details', hint: 'Payroll and duty-of-care fields that are still blank' },
  { key: 'ids', label: 'ID documents', hint: 'Aadhaar, PAN, licence — record them and verify them' },
  { key: 'certificates', label: 'Certificates & expiries', hint: 'What has lapsed or falls due soon' },
] as const;

type ViewKey = (typeof VIEWS)[number]['key'];

const KEYS = VIEWS.map((v) => v.key) as ReadonlyArray<ViewKey>;

export const HrPaperworkPage: React.FC = () => {
  const { data: d } = useHr();
  const [view, setView] = useViewParam<ViewKey>(KEYS, 'details');

  // Per-chip counts, so choosing a chip is an informed choice rather than three blind guesses.
  // These are the same figures the old three tabs badged with — they have just stopped being
  // three competing navigation targets.
  const missingIds = d.compliance.roster - d.compliance.governmentDocuments.withGovDoc;
  const counts: Record<ViewKey, number> = {
    details: d.compliance.incompleteCount,
    ids: missingIds > 0 ? missingIds : 0,
    certificates: d.expiries.certifications.expired + d.expiries.documents.expired,
  };

  return (
    <div>
      <ViewChips
        value={view}
        onChange={setView}
        options={VIEWS.map((v) => ({ ...v, count: counts[v.key] }))}
      />

      {view === 'details' && <HrRecordsPage />}
      {view === 'ids' && <HrDocumentsPage />}
      {view === 'certificates' && <HrCompliancePage />}
    </div>
  );
};
