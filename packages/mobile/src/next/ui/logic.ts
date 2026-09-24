/**
 * The decisions the UI kit makes, kept out of the components so node can test them.
 *
 *  - `createTapGuard`: a button that is busy ignores a second tap (the double-submit that used to
 *    file two check-ins or two claims).
 *  - `filterOptions`: what a long picker list shows for what was typed.
 *  - `fieldIssueKey` / `normaliseField`: a field's inline problem, from the SAME shared rules the
 *    web form and the server use (`@fapoms/shared` identifier-entry), worded by the catalogue.
 *  - `stepStates`: which steps of the job's step bar are done / now / to do.
 */
import {
  PHONE_FIELD_KEYS,
  identifierFormatIssue,
  mobileNumberLooksWrong,
  normaliseIdentifierOnBlur,
} from '@fapoms/shared';

// ── Tap guard ────────────────────────────────────────────────────────────────────────────────

export interface TapGuard {
  /** Runs `fn` unless a previous run is still going. Resolves true if it ran. */
  run: (fn: () => unknown) => Promise<boolean>;
  isBusy: () => boolean;
}

export function createTapGuard(onBusyChange?: (busy: boolean) => void): TapGuard {
  let busy = false;
  return {
    isBusy: () => busy,
    run: async (fn) => {
      if (busy) return false;
      busy = true;
      onBusyChange?.(true);
      try {
        await fn();
      } finally {
        busy = false;
        onBusyChange?.(false);
      }
      return true;
    },
  };
}

// ── Picker search ────────────────────────────────────────────────────────────────────────────

export interface PickerOption<V extends string = string> {
  value: V;
  label: string;
  /** Other words that should find this option (an English name under a Hindi label, a code). */
  keywords?: readonly string[];
}

/** Show a search box once a list is longer than this. */
export const SEARCH_THRESHOLD = 8;

/** Lower-case, strip Latin accents and punctuation, squash spaces. Indic text is left as typed. */
export function normaliseSearch(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()'"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Options matching `query`: every typed word must appear in the label or a keyword. Options whose
 * label STARTS with the query come first; otherwise the original order is kept (it is usually
 * meaningful — months, years).
 */
export function filterOptions<V extends string>(options: readonly PickerOption<V>[], query: string): PickerOption<V>[] {
  const q = normaliseSearch(query);
  if (!q) return [...options];
  const words = q.split(' ');
  const scored: { option: PickerOption<V>; index: number; prefix: boolean }[] = [];
  options.forEach((option, index) => {
    const haystacks = [option.label, ...(option.keywords ?? [])].map(normaliseSearch);
    const all = haystacks.join(' ');
    if (!words.every((w) => all.includes(w))) return;
    scored.push({ option, index, prefix: haystacks.some((h) => h.startsWith(q)) });
  });
  scored.sort((a, b) => (a.prefix === b.prefix ? a.index - b.index : a.prefix ? -1 : 1));
  return scored.map((s) => s.option);
}

/** Index to scroll to so the chosen option is visible on open; 0 when nothing is chosen. */
export function selectedIndex<V extends string>(options: readonly PickerOption<V>[], value: V | null | undefined): number {
  if (value == null) return 0;
  const i = options.findIndex((o) => o.value === value);
  return i < 0 ? 0 : i;
}

// ── Field rules ──────────────────────────────────────────────────────────────────────────────

/** The catalogue key for a field's current problem, or null. */
export type FieldIssueKey =
  | 'field.required'
  | 'field.tooLong'
  | 'field.issue.pan'
  | 'field.issue.ifsc'
  | 'field.issue.aadhaarLength'
  | 'field.issue.aadhaarChecksum'
  | 'field.issue.pincode'
  | 'field.issue.bankAccount'
  | 'field.issue.phone';

/**
 * What to say under a field. `ruleKey` names the shared rule (`panNumber`, `ifscCode`,
 * `aadhaarNumber`, `pincode`, `bankAccountNumber`, or a phone key such as `phone`); other keys get
 * only the required / length checks. Advisory — the server stays the authority.
 */
export function fieldIssueKey(
  value: string,
  opts: { ruleKey?: string; required?: boolean; maxLength?: number } = {},
): FieldIssueKey | null {
  const v = value ?? '';
  if (!v.trim()) return opts.required ? 'field.required' : null;
  if (opts.maxLength != null && v.length > opts.maxLength) return 'field.tooLong';
  if (!opts.ruleKey) return null;
  if (PHONE_FIELD_KEYS.has(opts.ruleKey)) return mobileNumberLooksWrong(v) ? 'field.issue.phone' : null;
  const issue = identifierFormatIssue(opts.ruleKey, v);
  return issue ? (`field.issue.${issue}` as FieldIssueKey) : null;
}

/** The tidy-up leaving a field does (spaces out of an Aadhaar, PAN upper-cased), or the value unchanged. */
export function normaliseField(value: string, ruleKey?: string): string {
  if (!ruleKey) return value;
  return normaliseIdentifierOnBlur(ruleKey, value) ?? value;
}

// ── Step bar ─────────────────────────────────────────────────────────────────────────────────

export type StepState = 'done' | 'current' | 'todo';

/**
 * `current` is the index of the step being worked on; every earlier step is done. A `current`
 * equal to the number of steps means all are done.
 */
export function stepStates(count: number, current: number): StepState[] {
  const c = Math.max(0, Math.min(current, count));
  return Array.from({ length: count }, (_, i) => (i < c ? 'done' : i === c ? 'current' : 'todo'));
}
