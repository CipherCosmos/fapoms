import React from 'react';
import { CheckCircle2, Circle, XCircle } from 'lucide-react';
import {
  CourtCheckResult, CibilBand,
  ADDRESS_CHECK_METHOD_LABELS, ADDRESS_CHECK_RESULT_LABELS, COURT_CHECK_RESULT_LABELS, CIBIL_BAND_LABELS,
  BGV_PART_LABELS, bgvPartStates, addressCheckSummary, cibilSummary, type BgvPart, type BgvPartState,
} from '@fapoms/shared';
import { Select } from '../../components/ui';
import { Field, fieldInput, label } from './hr-ui';

/**
 * THE THREE PARTS OF A BACKGROUND VERIFICATION, ON SCREEN (owner, 2026-09-24: "address check
 * (physical/digital), cibil check, court check should present before making that done").
 *
 * The boxes in the check dialog, and the same three read back wherever the check is shown — the
 * Background tab and the approver's review. The rule ("clear needs all three, and none of them
 * found anything") is `bgv-parts.ts` in shared; this only asks and shows.
 */

export interface BgvPartsDraft {
  addressCheckMethod: string;
  addressCheckResult: string;
  cibilBand: string;
  cibilScore: string;
  courtCheckResult: string;
}

const choose = (placeholder: string, labels: Record<string, string>) => [
  { value: '', label: placeholder },
  ...Object.entries(labels).map(([value, text]) => ({ value, label: text })),
];

// "Not checked" is what an empty box already says, so it is not offered a second time.
const CIBIL_OPTIONS = choose('Not done yet', Object.fromEntries(
  Object.entries(CIBIL_BAND_LABELS).filter(([band]) => band !== CibilBand.NOT_CHECKED),
));

const PartMark: React.FC<{ state: BgvPartState }> = ({ state }) => (
  state.clear
    ? <CheckCircle2 size={14} color="var(--success)" aria-label="done" />
    : state.recorded
      ? <XCircle size={14} color="var(--danger)" aria-label="found something" />
      : <Circle size={14} color="var(--text-muted)" aria-label="not done yet" />
);

const PartHeading: React.FC<{ state: BgvPartState }> = ({ state }) => (
  <div style={{ flex: '1 1 100%', display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
    <PartMark state={state} />
    <span style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-primary)' }}>{BGV_PART_LABELS[state.part]}</span>
  </div>
);

/** The boxes, for the check dialog. Every part can be left empty — only a clear result needs all three. */
export const BgvPartsFields: React.FC<{
  draft: BgvPartsDraft;
  onChange: (patch: Partial<BgvPartsDraft>) => void;
}> = ({ draft, onChange }) => {
  const states = Object.fromEntries(bgvPartStates(draft).map((s) => [s.part, s])) as Record<BgvPart, BgvPartState>;
  return (
    <div
      data-testid="bgv-parts"
      style={{
        flex: '1 1 100%', display: 'flex', flexWrap: 'wrap', gap: '10px 14px',
        padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'var(--bg-surface-2)',
      }}
    >
      <div style={{ flex: '1 1 100%' }}>
        <div style={{ ...label, marginBottom: '2px' }}>What the agency checked</div>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          All three are needed before the result can be Clear.
        </div>
      </div>

      <PartHeading state={states.address} />
      <Field title="How">
        <Select
          aria-label="How the address was checked"
          value={draft.addressCheckMethod}
          onChange={(v) => onChange({ addressCheckMethod: String(v) })}
          options={choose('Choose…', ADDRESS_CHECK_METHOD_LABELS)}
        />
      </Field>
      <Field title="What it found">
        <Select
          aria-label="What the address check found"
          value={draft.addressCheckResult}
          onChange={(v) => onChange({ addressCheckResult: String(v) })}
          options={choose('Not done yet', ADDRESS_CHECK_RESULT_LABELS)}
        />
      </Field>

      <PartHeading state={states.cibil} />
      <Field title="Band">
        <Select
          aria-label="CIBIL band"
          value={draft.cibilBand}
          onChange={(v) => onChange({ cibilBand: String(v) })}
          options={CIBIL_OPTIONS}
        />
      </Field>
      <Field title="Score">
        <input style={fieldInput} inputMode="numeric" placeholder="e.g. 747" aria-label="CIBIL score"
          value={draft.cibilScore}
          onChange={(e) => onChange({ cibilScore: e.target.value })} />
      </Field>

      <PartHeading state={states.court} />
      <Field title="What it found" wide>
        <Select
          aria-label="What the court check found"
          value={draft.courtCheckResult}
          onChange={(v) => onChange({ courtCheckResult: String(v) })}
          options={choose('Not done yet', COURT_CHECK_RESULT_LABELS)}
        />
      </Field>
    </div>
  );
};

/** One part of a recorded check, in words — "Not recorded" for a check from before the parts were asked for. */
export function bgvPartText(part: BgvPart, check: {
  addressCheckMethod?: string | null; addressCheckResult?: string | null;
  cibilBand?: string | null; cibilScore?: number | null; courtCheckResult?: string | null;
}): string {
  const said = part === 'address' ? addressCheckSummary(check)
    : part === 'cibil' ? cibilSummary(check)
      : check.courtCheckResult ? COURT_CHECK_RESULT_LABELS[check.courtCheckResult as CourtCheckResult] ?? check.courtCheckResult : null;
  return said ?? 'Not recorded';
}

/** The three parts of a recorded check, as the label-over-value blocks of the Background check card. */
export const BgvPartsReadout: React.FC<{
  check: Parameters<typeof bgvPartText>[1];
}> = ({ check }) => (
  <>
    {bgvPartStates(check).map((s) => (
      <div key={s.part} data-testid={`bgv-part-${s.part}`}>
        <div style={label}>{BGV_PART_LABELS[s.part]}</div>
        <div style={{
          fontSize: 'var(--text-sm)', display: 'flex', alignItems: 'center', gap: '5px',
          color: s.recorded ? (s.clear ? 'var(--text-primary)' : 'var(--danger)') : 'var(--text-muted)',
        }}>
          <PartMark state={s} />
          {bgvPartText(s.part, check)}
        </div>
      </div>
    ))}
  </>
);
