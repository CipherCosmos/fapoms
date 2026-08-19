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
  { key: 'certificates', label: 'Certificates & expiries', hint: 'Certificates and ID papers that have lapsed or lapse within 30 days' },
] as const;

type ViewKey = (typeof VIEWS)[number]['key'];

const KEYS = VIEWS.map((v) => v.key) as ReadonlyArray<ViewKey>;

export const HrPaperworkPage: React.FC = () => {
  const { data: d } = useHr();
  const [view, setView] = useViewParam<ViewKey>(KEYS, 'details');

  // Per-chip counts, so choosing a chip is an informed choice rather than three blind guesses.
  // These are the same figures the old three tabs badged with — they have just stopped being
  // three competing navigation targets.
  const missingIds = Math.max(d.compliance.roster - d.compliance.governmentDocuments.withGovDoc, 0);
  const counts: Record<ViewKey, number> = {
    details: d.compliance.incompleteCount,
    ids: missingIds,
    /*
     * Counts what has lapsed *and* what lapses within 30 days.
     *
     * It used to count only the already-expired, while the chip's own body lists everything
     * falling due inside 180 days. So the chip could read a reassuring 0 above a table of twelve
     * certificates about to run out — the number contradicting the list directly beneath it. The
     * chip now counts the thing a person would act on this month. (The *tab* badge in HrLayout is
     * deliberately not changed: expiries badge on Skills & Certificates, the only screen that can
     * record a renewal. This is a within-page filter count, not a second navigation target.)
     */
    certificates:
      d.expiries.certifications.expired + d.expiries.documents.expired +
      d.expiries.certifications.within30 + d.expiries.documents.within30,
  };

  /*
   * The position in one sentence, above the chips.
   *
   * The chips answer "which of the three do I want"; they never answered "what is actually wrong
   * right now". On the live roster every single person is missing the bank details they must have
   * to be paid, and not one identity document exists — and a reader could sit on the default chip
   * and see only a grid of field bars, with the ID gap parked silently behind a chip they had no
   * reason to press. Each line is a button onto the chip that resolves it.
   */
  const headlines: { key: ViewKey; text: string }[] = [];
  if (counts.details > 0) {
    headlines.push({
      key: 'details',
      text: `${counts.details} ${counts.details === 1 ? 'person is' : 'people are'} missing payroll or emergency-contact details — they cannot be paid until those are filled in.`,
    });
  }
  if (missingIds > 0) {
    headlines.push({
      key: 'ids',
      text: missingIds === d.compliance.roster
        ? `No identity document is on file for anyone on the roster (${missingIds} ${missingIds === 1 ? 'person' : 'people'}).`
        : `${missingIds} ${missingIds === 1 ? 'person has' : 'people have'} no identity document on file.`,
    });
  }

  return (
    <div>
      {headlines.length > 0 && (
        <div style={{
          background: 'var(--bg-card)', border: '1px solid var(--border-color)',
          borderLeft: '3px solid var(--danger)', borderRadius: 'var(--radius-md, 10px)',
          padding: '12px 14px', marginBottom: '14px',
          display: 'flex', flexDirection: 'column', gap: '6px',
        }}>
          {headlines.map((h) => (
            <button
              key={h.key}
              onClick={() => setView(h.key)}
              style={{
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                textAlign: 'left', fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.45,
              }}
            >
              {h.text}{' '}
              <span style={{ color: 'var(--accent)', fontWeight: 600 }}>Work through them →</span>
            </button>
          ))}
        </div>
      )}

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
