import { useCallback, useEffect, useRef, useState } from 'react';
import { isValidPan, isValidAadhaar, normalisePhone } from '@fapoms/shared';
import { api } from '../../../services/api';
import { AppError } from '../../../services/errors';
import type { DuplicateMatch } from '../AssayerForms';

/**
 * Helping the clerk avoid a second record for somebody already on the roster — never blocking one.
 *
 * `GET /assayers/identifier-check?phone=&panNumber=&aadhaarNumber=&excludeId=` is Track 1's to
 * build alongside this screen; this hook codes to that contract verbatim and degrades to silence
 * the moment it 404s, so testing this page before the endpoint lands produces no console spam and
 * no broken UI — only a warning card that never appears.
 *
 * One check per field, fired on blur once the box is already format-valid (there is nothing to
 * ask the server about a PAN that is still being typed), and debounced so a clerk blurring and
 * re-focusing the same box in quick succession — a common way to re-read what was just typed —
 * does not fire a second identical request while the first is still in flight.
 */

export type DuplicateCheckKey = 'phone' | 'panNumber' | 'aadhaarNumber';

const QUERY_PARAM: Record<DuplicateCheckKey, string> = {
  phone: 'phone', panNumber: 'panNumber', aadhaarNumber: 'aadhaarNumber',
};

const DEBOUNCE_MS = 400;

/**
 * Is this box's value even worth asking about? The same rulebook `formatHint` already shows the
 * clerk in the box itself — asking the server about a value that visibly is not a real PAN yet
 * would spend a request per keystroke on the way to a finished one, for an answer that can only
 * ever be "no match", since nothing on any roster is stored malformed.
 */
const checkableValue = (key: DuplicateCheckKey, raw: string): string | null => {
  const v = (raw || '').trim();
  if (!v) return null;
  if (key === 'phone') return normalisePhone(v);
  if (key === 'panNumber') return isValidPan(v) ? v.toUpperCase() : null;
  return isValidAadhaar(v.replace(/\s/g, '')) ? v.replace(/\s/g, '') : null;
};

interface CheckResult {
  /** The exact cleaned value this result answers for — see `dismiss` and `matchesFor`. */
  value: string;
  rows: DuplicateMatch[];
}

export interface DuplicateCheck {
  /** Call from the field's onBlur with the box's (already-cleaned) value. */
  check: (key: DuplicateCheckKey, value: string) => void;
  /** What to show under this field right now — empty once dismissed, or once nothing matched. */
  matchesFor: (key: DuplicateCheckKey) => DuplicateMatch[];
  /** "This is a different person" — dismisses the card for the value that produced it, only. */
  dismiss: (key: DuplicateCheckKey) => void;
}

export function useDuplicateCheck(excludeId: string | null): DuplicateCheck {
  const [results, setResults] = useState<Partial<Record<DuplicateCheckKey, CheckResult>>>({});
  const [dismissedValue, setDismissedValue] = useState<Partial<Record<DuplicateCheckKey, string>>>({});
  // Refs, not state: neither drives a render on its own, and reading them from a debounced
  // timeout callback needs the CURRENT value, not whatever this render closed over.
  const requested = useRef<Partial<Record<DuplicateCheckKey, string>>>({});
  const timers = useRef<Partial<Record<DuplicateCheckKey, ReturnType<typeof setTimeout>>>>({});
  const unavailable = useRef(false);

  useEffect(() => () => {
    Object.values(timers.current).forEach((t) => t && clearTimeout(t));
  }, []);

  const runCheck = useCallback(async (key: DuplicateCheckKey, value: string) => {
    if (unavailable.current) return;
    try {
      const qs = new URLSearchParams({ [QUERY_PARAM[key]]: value });
      if (excludeId) qs.set('excludeId', excludeId);
      // api.request unwraps the {success, data} envelope and hands back `data` itself — typing
      // the full envelope here silently reads undefined and eats every match (the exact bug the
      // Approvals queue shipped with, in mirror image).
      const res = await api.request<{ matches: DuplicateMatch[] }>(
        `/assayers/identifier-check?${qs.toString()}`,
      );
      setResults((r) => ({ ...r, [key]: { value, rows: res?.matches ?? [] } }));
    } catch (e) {
      if (e instanceof AppError && e.status === 404) {
        // Not built yet. Stop asking for the rest of this session rather than repeating the same
        // failed request on every blur and filling the console with it.
        unavailable.current = true;
        return;
      }
      // Any other failure — offline, a timeout, a 500 — is exactly the kind of thing this courtesy
      // check must never surface: it is not a reason to interrupt a clerk mid-form with a banner
      // about a feature they did not ask for.
    }
  }, [excludeId]);

  const check = useCallback((key: DuplicateCheckKey, rawValue: string) => {
    const existing = timers.current[key];
    if (existing) clearTimeout(existing);
    const value = checkableValue(key, rawValue);
    if (!value) return; // blank or still not a real-looking value — nothing to ask about yet
    if (requested.current[key] === value) return; // already asked (or about to) about this exact value
    requested.current[key] = value;
    timers.current[key] = setTimeout(() => { void runCheck(key, value); }, DEBOUNCE_MS);
  }, [runCheck]);

  const dismiss = useCallback((key: DuplicateCheckKey) => {
    const value = results[key]?.value;
    if (value) setDismissedValue((d) => ({ ...d, [key]: value }));
  }, [results]);

  const matchesFor = useCallback((key: DuplicateCheckKey): DuplicateMatch[] => {
    const result = results[key];
    if (!result || result.rows.length === 0) return [];
    if (dismissedValue[key] === result.value) return [];
    return result.rows;
  }, [results, dismissedValue]);

  return { check, matchesFor, dismiss };
}
