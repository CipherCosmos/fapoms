import { useCallback, useEffect, useRef, useState } from 'react';
import { todayDateKey } from '@fapoms/shared';
import { api } from '../../../services/api';
import { userMessage } from '../../../services/errors';
import { stringifyList } from '../AssayerForms';
import { isSensitiveKey, type Assayer } from '../assayer-shared';
import { REGISTRATION_FIELDS, RATE_KEYS, type RegistrationStepKey } from './steps';
import { buildCreateBody, buildUpdatePlan, ratePayload, ratesChanged } from './persist';

/**
 * The registration's state: one form, one record, and the rule that the two stay in step.
 *
 * There is no draft store. Everything the clerk types is written to the person's own row as they
 * move between steps, which is what makes an interrupted registration resumable — the half-filled
 * record IS the draft, it is on the roster, and the same wizard reopened on it shows exactly what
 * is there. The alternative, a local draft, loses the work when the tab closes and produces a
 * second, invisible idea of who has been registered.
 *
 * `saved` is what the server is believed to hold. Every commit diffs against it and sends only
 * what moved, then updates it from the response — see `buildUpdatePlan` for why sending the whole
 * form each time would let two people editing one person silently overwrite each other.
 */

/** The phone columns store `+91XXXXXXXXXX`; the boxes show ten digits under a printed `+91`. */
const TEL_KEYS = ['phone', 'alternatePhone', 'emergencyContactPhone'];

const dateBox = (value: unknown): string => {
  if (!value) return '';
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().split('T')[0];
};

/**
 * A record as the form's boxes.
 *
 * The phone strip is the part worth naming: without it a resumed registration shows
 * `+919876543210` sitting behind the `+91` the field itself prints, so the box reads
 * `+91 +919876543210` and any save normalises it into a different number. Stripping on the way in
 * and re-adding on the way out (`buildAssayerEditBody` does the latter) keeps the round trip
 * lossless, which is what makes the dirty diff able to tell "untouched" from "changed".
 */
export function snapshotRecord(record: Partial<Assayer>): Record<string, string> {
  const form: Record<string, string> = {};
  for (const field of REGISTRATION_FIELDS) {
    const raw = (record as Record<string, unknown>)[field.key];
    /**
     * A KYC identifier never comes back into a box from the record.
     *
     * PAN, Aadhaar and bank account arrive from the server masked (`••••••234F`), and a resumed
     * registration used to drop whatever the record held straight into the input. One corrected
     * digit on top of a mask saves a mask, destroying a real identifier while leaving something
     * that looks plausible on every screen afterwards.
     *
     * Blank here, and blank on every later re-read, so the box's contents are only ever what
     * somebody deliberately put there — either typed from the card, or seeded by an audited
     * reveal on the identity step. Whether one is on file is shown there, masked, beside the box.
     */
    if (isSensitiveKey(field.key)) { form[field.key] = ''; continue; }
    if (field.type === 'date') { form[field.key] = dateBox(raw); continue; }
    if (field.key === 'certifications') {
      const list = Array.isArray(raw) ? (raw as { name: string }[]).map((c) => c?.name).filter(Boolean) : [];
      form[field.key] = stringifyList(list as string[]);
      continue;
    }
    if (field.vocab || field.regions) {
      form[field.key] = stringifyList(Array.isArray(raw) ? (raw as unknown[]).map(String) : []);
      continue;
    }
    if (TEL_KEYS.includes(field.key)) {
      const digits = String(raw ?? '').replace(/\D/g, '');
      form[field.key] = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
      continue;
    }
    form[field.key] = raw === null || raw === undefined ? '' : String(raw);
  }
  const hours = record.workingHours ?? null;
  form.workingHoursStart = hours?.start ?? '';
  form.workingHoursEnd = hours?.end ?? '';
  // Rates are not on the record — they are a dated profile behind their own endpoint — so they
  // start empty on a resume rather than pretending the boxes show what is on file.
  for (const key of RATE_KEYS) form[key] = '';
  return form;
}

/**
 * What a brand-new registration opens with.
 *
 * Deliberately three values and no more. This form used to open pre-filled with Delhi, Central
 * Delhi, New Delhi, "Gold Testing" and five years of experience — correct for one hire in a
 * national roster and wrong for the rest, and wrong in the quietest way, because a pre-filled box
 * reads as already answered. What survives is only what is either true by construction (today is
 * the day this intake is happening) or a genuine majority default that is visible in the box and
 * one click from being changed.
 */
export const blankRegistrationForm = (): Record<string, string> => ({
  employmentType: 'FULL_TIME',
  joiningDate: todayDateKey(),
});

export interface RegistrationState {
  form: Record<string, string>;
  record: Assayer | null;
  assayerId: string | null;
  busy: boolean;
  /** A save that failed, in the server's own words. Cleared when the clerk edits anything. */
  error: string | null;
  /** Set when a resumed record could not be loaded — the flow must not pretend it started fresh. */
  loadError: string | null;
  loading: boolean;
}

export interface Registration extends RegistrationState {
  set: (key: string, value: string) => void;
  merge: (values: Record<string, string>) => void;
  /** A KYC identifier uncovered on purpose — fills the box without counting as an edit. */
  reveal: (key: string, full: string) => void;
  /** Persists whatever moved. `false` means stay on this step; `error` says why. */
  commit: () => Promise<boolean>;
  /** Re-reads the record — after a map pin, which is written by an endpoint of its own. */
  refresh: () => Promise<void>;
  dismissError: () => void;
}

export function useRegistration(resumeAssayerId?: string): Registration {
  const [form, setForm] = useState<Record<string, string>>(blankRegistrationForm);
  const [saved, setSaved] = useState<Record<string, string>>(() => ({}));
  const [record, setRecord] = useState<Assayer | null>(null);
  const [assayerId, setAssayerId] = useState<string | null>(resumeAssayerId ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(resumeAssayerId));

  // Read by `commit`, which is called from event handlers that would otherwise close over the
  // render in which the button was drawn — the create request in particular runs long enough for
  // a keystroke to land while it is in flight.
  const latest = useRef({ form, saved, record, assayerId });
  latest.current = { form, saved, record, assayerId };

  /**
   * Take the server's answer as the truth, without throwing away typing it has not seen.
   *
   * A refresh happens for reasons that have nothing to do with the boxes on screen: the map pin
   * writes coordinates through `/geo/precision/...`, and entering a PAN or Aadhaar number against
   * a *document* writes it onto the person (`NUMBER_LIVES_ON_THE_PERSON` in the backend). Simply
   * overwriting the form each time would discard whatever the clerk had typed ahead on a later
   * step; simply keeping the form would let the next save PUT a stale PAN back over the one the
   * documents step had just written. So a box that differs from the last saved value is local work
   * and wins; every other box takes the server's value.
   */
  const adopt = useCallback((fresh: Assayer) => {
    const snap = snapshotRecord(fresh);
    const previouslySaved = latest.current.saved;
    /**
     * The very first answer from the server needs the opposite rule, because "local work" cannot
     * be detected yet.
     *
     * The test below is "does this box differ from the last saved value?", and before the first
     * save there IS no last saved value — every box differs from nothing. So the step-one defaults
     * the form opens with (today's joining date, the employment and engagement types) counted as
     * unsaved typing and were kept over the server's answer, even though the create had just sent
     * them and the server had just stored, and possibly normalised, them.
     *
     * `joiningDate` made that visible. The box holds `2026-09-03`; the record comes back as
     * `2026-09-03T00:00:00.000Z`. Kept apart, the two never compared equal again, so the field was
     * dirty forever and every later step re-sent it — which is precisely the cross-clerk overwrite
     * the diff exists to prevent, performed by the diff itself.
     *
     * On the first adoption the whole form was just submitted, so there is nothing to protect and
     * the server's answer is authoritative for every box.
     */
    const noBaselineYet = Object.keys(previouslySaved).length === 0;
    setRecord(fresh);
    setAssayerId(fresh.id);
    setSaved(snap);
    setForm((current) => {
      const merged = { ...snap };
      for (const key of Object.keys(current)) {
        /**
         * An identity number is the one thing local work does NOT win.
         *
         * Every other box keeps what the clerk typed, because a refresh happens for reasons that
         * have nothing to do with the boxes on screen. A PAN or Aadhaar is different: leaving one
         * sitting in form state after it has been written means the value is carried around the
         * remaining steps and re-sent by each of them, and the whole point of masking is that it
         * is not held anywhere it does not have to be. Every step commits before it is left, so
         * there is no in-progress typing here for this to lose.
         */
        if (isSensitiveKey(key)) continue;
        // Rates never come back from this endpoint — they are a profile behind their own route —
        // so a snapshot would blank them every time any other step saved.
        // Rates are kept regardless: they are a profile behind their own route and never come
        // back from this endpoint, so the snapshot would blank them on every other step's save.
        if (RATE_KEYS.includes(key)) {
          merged[key] = current[key];
          continue;
        }
        if (!noBaselineYet && current[key] !== (previouslySaved[key] ?? '')) {
          merged[key] = current[key];
        }
      }
      return merged;
    });
  }, []);

  /**
   * A number uncovered by a deliberate, audited reveal, seeded into the box AND the baseline.
   *
   * Both, or the act of looking at somebody's PAN would register as a change to it and the next
   * save would re-write the column it had just revealed. The same rule the record page's
   * `revealSensitive` follows.
   */
  const reveal = useCallback((key: string, full: string) => {
    setForm((f) => ({ ...f, [key]: full }));
    setSaved((s) => ({ ...s, [key]: full }));
  }, []);

  useEffect(() => {
    if (!resumeAssayerId) return undefined;
    let alive = true;
    setLoading(true);
    api.request<Assayer>(`/assayers/${resumeAssayerId}`)
      .then((fresh) => { if (alive) { adopt(fresh); setLoadError(null); } })
      .catch((e) => { if (alive) setLoadError(userMessage(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [resumeAssayerId, adopt]);

  const set = useCallback((key: string, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setError(null);
  }, []);

  const merge = useCallback((values: Record<string, string>) => {
    setForm((f) => ({ ...f, ...values }));
    setError(null);
  }, []);

  const refresh = useCallback(async () => {
    const id = latest.current.assayerId;
    if (!id) return;
    try {
      const fresh = await api.request<Assayer>(`/assayers/${id}`);
      adopt(fresh);
    } catch (e) { setError(userMessage(e)); }
  }, [adopt]);

  const commit = useCallback(async (): Promise<boolean> => {
    const { form: f, saved: s, record: r, assayerId: id } = latest.current;
    setBusy(true);
    setError(null);
    try {
      if (!id) {
        const created = await api.request<Assayer>('/assayers', {
          method: 'POST',
          body: JSON.stringify(buildCreateBody(REGISTRATION_FIELDS, f)),
        });
        adopt(created);
        return true;
      }

      const plan = buildUpdatePlan(REGISTRATION_FIELDS, f, s, r ?? { workingHours: null, certifications: null });
      if (plan.problems.length > 0) { setError(plan.problems.join(' ')); return false; }
      if (plan.body) {
        const updated = await api.request<Assayer>(`/assayers/${id}`, {
          method: 'PUT', body: JSON.stringify(plan.body),
        });
        adopt(updated);
      }

      /**
       * The pay card, filed in the same breath as the record — and reported separately when it
       * fails.
       *
       * The old create form fired this as a second, unwatched request after `POST /assayers`
       * succeeded. A failure there left a real person on the roster with no rates behind a
       * "Could not create assayer" toast that named neither what had been created nor what had
       * not, and the clerk's only visible option was to try the whole enrolment again. Here the
       * record is already saved when this runs, the failure says so in as many words, the typed
       * rates are still in their boxes, and the step does not advance.
       */
      if (ratesChanged(f, s)) {
        const rates = ratePayload(f);
        if (rates) {
          try {
            await api.request(`/assayers/${id}/commercial`, { method: 'POST', body: JSON.stringify(rates) });
          } catch (e) {
            setError(`Their details were saved, but the pay rates were not: ${userMessage(e)} `
              + 'The rates are still in the boxes below — try again, or move on and set them later.');
            return false;
          }
        }
        setSaved((prev) => {
          const next = { ...prev };
          for (const key of RATE_KEYS) next[key] = f[key] ?? '';
          return next;
        });
      }
      return true;
    } catch (e) {
      setError(userMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, [adopt]);

  return {
    form, record, assayerId, busy, error, loadError, loading,
    set, merge, reveal, commit, refresh, dismissError: () => setError(null),
  };
}

/** One row of `GET /assayers/:id/dossier`'s `onboarding[]` — the full 21-item requirement list. */
export interface DossierDocument {
  requirement: string;
  label: string;
  identity: boolean;
  id: string | null;
  softCopyReceived: boolean | null;
  hardCopyReceived: boolean | null;
  documentNumber: string | null;
  expiryDate: string | null;
  verificationStatus: string | null;
  filePaths: string[];
}

export interface DossierReference {
  id: string;
  fullName: string;
  relationship: string | null;
  phone: string | null;
  checkedAt: string | null;
}

/**
 * One client's standing, as `GET /assayers/:id/dossier` returns it.
 *
 * `client` is null only when the row outlived the client it names, which the import can produce;
 * the screens fall back to the id rather than dropping the row, because a standing whose client
 * cannot be resolved is still a standing that governs planning.
 */
export interface DossierEmpanelment {
  id: string;
  clientId: string;
  status: string;
  statusReason: string | null;
  client: { id: string; name: string; clientCode?: string | null } | null;
}

export interface Dossier {
  onboarding: DossierDocument[];
  references: DossierReference[];
  /**
   * Absent on older responses and on any test double that predates the clients step, so every
   * reader defaults it rather than indexing into undefined — the dossier is fetched once and
   * shared by three steps, and one of them crashing takes the whole wizard with it.
   */
  empanelments?: DossierEmpanelment[];
}

/**
 * The paperwork and the referees, in one request.
 *
 * `GET /assayers/:id/dossier` synthesises the whole requirement list server-side whether or not
 * any document row exists, so a person with nothing on file shows twenty-one outstanding items
 * rather than an empty list that reads as "nothing needed". Fetched once for the wizard and
 * shared by the documents step and the references block, because they are two views of one answer.
 */
export function useDossier(assayerId: string | null) {
  const [data, setData] = useState<Dossier | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!assayerId) { setData(null); return undefined; }
    let alive = true;
    api.request<Dossier>(`/assayers/${assayerId}/dossier`)
      .then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((e) => { if (alive) setError(userMessage(e)); });
    return () => { alive = false; };
  }, [assayerId, tick]);

  return { dossier: data, dossierError: error, reloadDossier: () => setTick((t) => t + 1) };
}

export type { RegistrationStepKey };
