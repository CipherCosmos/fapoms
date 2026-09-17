import { useCallback, useEffect, useRef, useState } from 'react';
import { REGISTRATION_RECORD_FIELD_KEYS } from '@fapoms/shared';
import { api } from '../../../services/api';
import { fieldErrorKeys, userMessage } from '../../../services/errors';
import { stringifyList } from '../AssayerForms';
import { REGISTRATION_FIELDS, RATE_KEYS, type RegistrationStepKey } from './steps';
import { buildApplicationPatch, ratePayload, ratesChanged } from './persist';

/**
 * The registration's state: one form, one application, and the rule that the two stay in step.
 *
 * **What this writes to changed.** Every step used to write to a live `assayers` row, created
 * after step one — so an interrupted registration left a half-made employee on the roster, and the
 * whole interview → application → review pipeline could be walked past by anybody who pressed "Add
 * assayer". It writes to the candidate's APPLICATION now: the same row they fill in through their
 * own link, reviewed and approved once, promoted to a person exactly once.
 *
 * The desk is the second typist, not a second pipeline. The candidate still confirms their own
 * number, still accepts the declaration and still presses Submit; what this saves them is the
 * typing, for the case where they are at the desk or have sent their papers in.
 *
 * There is still no draft store — the application IS the draft, it is on the server, and the same
 * wizard reopened on it shows exactly what is there. `saved` is what the server is believed to
 * hold; every commit diffs against it and sends only what moved, which matters more here than it
 * did against the record: the candidate may be typing into the same row at the same time.
 */

/** The phone columns store `+91XXXXXXXXXX`; the boxes show ten digits under a printed `+91`. */
const TEL_KEYS = ['phone', 'alternatePhone', 'emergencyContactPhone'];

const RECORD_KEYS = new Set<string>(REGISTRATION_RECORD_FIELD_KEYS as readonly string[]);

const dateBox = (value: unknown): string => {
  if (!value) return '';
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().split('T')[0];
};

/** One candidate's application, as `GET /hr/applications/:id` returns it. */
export interface ApplicationRow {
  id: string;
  status: string;
  fullName: string | null;
  mobile: string;
  email: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  address: string | null;
  state: string | null;
  city: string | null;
  pincode: string | null;
  experienceYears: number | null;
  currentEmployer: string | null;
  expertise: string | null;
  availability: string | null;
  employmentCategory: string | null;
  consentAcceptedAt: string | null;
  /** Set the first time the candidate opens their link — see `tokenConsumedAt` on the entity. */
  tokenConsumedAt: string | null;
  extendedProfile: {
    fields?: Record<string, unknown>;
    commercial?: Record<string, unknown>;
    references?: Array<Record<string, unknown>>;
    empanelments?: Array<{ clientId: string; status: string; statusReason?: string }>;
  } | null;
}

export interface ApplicationView {
  application: ApplicationRow;
  documents: Array<{ requirement: string; filePaths: string[] }>;
  /** What is still missing, judged against the record this will become. */
  gaps: Array<{ key: string; label: string; blocks: string }>;
  /** Which scans this candidate is asked for, given the category they chose. */
  documentsRequested: string[];
  /** The number HR typed at the interview, when it differs from the one on the application. */
  invitedMobile: string | null;
}

/**
 * An application as the form's boxes.
 *
 * Two sources, one rule: a key on the registration allow-list lives under `extendedProfile.fields`;
 * everything else is a column on the application itself. The same split the server applies on the
 * way in, read back.
 *
 * The phone strip is the part worth naming: without it a resumed registration shows
 * `+919876543210` sitting behind the `+91` the field itself prints, so the box reads
 * `+91 +919876543210` and any save normalises it into a different number.
 *
 * Identity numbers are NOT blanked here, and that is a real difference from the record page. An
 * application stores them as typed — the masking and the audited reveal belong to `assayers`,
 * where they are encrypted — so the desk sees what it entered and a resumed form round-trips. The
 * value is the same one the candidate's own form shows them.
 */
export function snapshotApplication(view: ApplicationView): Record<string, string> {
  const { application } = view;
  const fields = application.extendedProfile?.fields ?? {};
  const form: Record<string, string> = {};

  for (const field of REGISTRATION_FIELDS) {
    const raw = RECORD_KEYS.has(field.key)
      ? fields[field.key]
      : (application as unknown as Record<string, unknown>)[field.key];

    if (field.type === 'date') { form[field.key] = dateBox(raw); continue; }
    if (field.vocab || field.regions) {
      form[field.key] = stringifyList(Array.isArray(raw) ? (raw as unknown[]).map(String) : []);
      continue;
    }
    if (TEL_KEYS.includes(field.key)) {
      /*
        THE NUMBER THEY WERE INVITED ON IS ALREADY A PHONE NUMBER FOR THEM.

        `phone` is read from `extendedProfile.fields`, which nothing writes when an application is
        opened — so the desk typed a mobile into "Add candidate", opened the form, and found the
        phone box empty, asking for the number it had just given. The candidate's own form has
        always shown `application.mobile` here.

        Display only. This snapshot is what `adopt()` treats as SAVED as well as what is shown, so
        an unedited box differs from nothing and is never sent — the deliberate split in
        `persist.ts`, where `record.phone` must not overwrite the `mobile` column, is untouched.
        And it is the number approval puts on the record anyway (`createDto.phone = mobile`).
      */
      const source = field.key === 'phone' && (raw === undefined || raw === null || raw === '')
        ? application.mobile
        : raw;
      const digits = String(source ?? '').replace(/\D/g, '');
      form[field.key] = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
      continue;
    }
    form[field.key] = raw === null || raw === undefined ? '' : String(raw);
  }

  // Rates are a group of their own under `extendedProfile`, applied at approval by
  // `applyExtendedProfile`. They round-trip now, where against the record they could not: they
  // lived behind a separate dated-profile endpoint the wizard never read back.
  const commercial = application.extendedProfile?.commercial ?? {};
  for (const key of RATE_KEYS) {
    const value = (commercial as Record<string, unknown>)[key];
    form[key] = value === null || value === undefined ? '' : String(value);
  }
  return form;
}

/** The two lists the wizard holds itself, sent with the step that owns them. */
export interface StaffExtras {
  empanelments?: Array<{ clientId: string; status: string; statusReason?: string }>;
  references?: Array<Record<string, unknown>>;
}

export interface RegistrationState {
  form: Record<string, string>;
  application: ApplicationRow | null;
  applicationId: string;
  /** The scans on file, and the ones this candidate is asked for. */
  documents: Array<{ requirement: string; filePaths: string[] }>;
  documentsRequested: string[];
  /** What is still missing, as the review screen and the record both count it. */
  gaps: Array<{ key: string; label: string; blocks: string }>;
  busy: boolean;
  /** A save that failed, in the server's own words. Cleared when the clerk edits anything. */
  error: string | null;
  /**
   * The boxes that failure named, if it was a field-level one — server spelling (`panNumber`).
   * Empty for everything else, which is what the banner's fallback path is for.
   */
  errorFields: readonly string[];
  /** Set when the application could not be loaded — the flow must not pretend it started fresh. */
  loadError: string | null;
  loading: boolean;
}

export interface Registration extends RegistrationState {
  set: (key: string, value: string) => void;
  merge: (values: Record<string, string>) => void;
  /**
   * Persists whatever moved. `false` means stay on this step; `error` says why.
   *
   * `extras` carries the two groups the wizard holds as lists rather than as form boxes — the
   * client standings and the references. They are sent with whichever step is being left, because
   * an application holds them under `extendedProfile` and `approve()` files them at promotion.
   */
  commit: (extras?: StaffExtras) => Promise<boolean>;
  /** Re-reads the application — after a document upload, which writes through its own route. */
  refresh: () => Promise<void>;
  dismissError: () => void;
  /**
   * Would any of these boxes be lost by leaving now? The page's "← Back" link asks this of the
   * CURRENT step's own fields before it confirms — the same "differs from last saved" test
   * `commit` itself runs, exposed so the page does not have to reach into `saved` directly.
   */
  isDirty: (keys: readonly string[]) => boolean;
}

export function useRegistration(applicationId: string): Registration {
  const [form, setForm] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, string>>(() => ({}));
  const [view, setView] = useState<ApplicationView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The boxes the last failure was about, in the server's own spelling.
   *
   * `AppError` keeps these now, so the banner's "Go to field" links are built from what the server
   * actually named rather than from re-parsing the sentence it was collapsed into. The prose path
   * still works and is still the fallback — see `mappedFieldsFromError`.
   */
  const [errorFields, setErrorFields] = useState<readonly string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Read by `commit`, which is called from event handlers that would otherwise close over the
  // render in which the button was drawn.
  const latest = useRef({ form, saved });
  latest.current = { form, saved };

  /**
   * Take the server's answer as the truth, without throwing away typing it has not seen.
   *
   * A refresh happens for reasons that have nothing to do with the boxes on screen — a document
   * upload writes through its own route, and the candidate may be filling the same application in
   * from their phone while the desk types. So a box that differs from the last saved value is
   * local work and wins; every other box takes the server's value, which is how a field the
   * candidate has just answered appears here rather than being overwritten by a stale blank.
   */
  const adopt = useCallback((fresh: ApplicationView) => {
    const snap = snapshotApplication(fresh);
    const previouslySaved = latest.current.saved;
    const noBaselineYet = Object.keys(previouslySaved).length === 0;
    setView(fresh);
    setSaved(snap);
    setForm((current) => {
      const merged = { ...snap };
      if (noBaselineYet) return merged;
      for (const key of Object.keys(current)) {
        if (current[key] !== (previouslySaved[key] ?? '')) merged[key] = current[key];
      }
      return merged;
    });
  }, []);

  const load = useCallback(async () => {
    const fresh = await api.request<ApplicationView>(`/hr/applications/${applicationId}`);
    adopt(fresh);
  }, [applicationId, adopt]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.request<ApplicationView>(`/hr/applications/${applicationId}`)
      .then((fresh) => { if (alive) { adopt(fresh); setLoadError(null); } })
      .catch((e) => { if (alive) setLoadError(userMessage(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [applicationId, adopt]);

  /** Record a failure: its sentence and the boxes it named, always together. */
  const fail = useCallback((message: string, cause?: unknown) => {
    setError(message);
    setErrorFields(fieldErrorKeys(cause));
  }, []);

  const clearError = useCallback(() => {
    setError(null);
    setErrorFields([]);
  }, []);

  const set = useCallback((key: string, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    clearError();
  }, [clearError]);

  const merge = useCallback((values: Record<string, string>) => {
    setForm((f) => ({ ...f, ...values }));
    clearError();
  }, [clearError]);

  const refresh = useCallback(async () => {
    try {
      await load();
    } catch (e) { fail(userMessage(e), e); }
  }, [load, fail]);

  /**
   * One request per step, carrying what moved.
   *
   * The rates used to be a second, separate call to `POST /assayers/:id/commercial` fired after
   * the record save had succeeded — so a failure there left a real person on the roster with no
   * rates, behind a message that named neither what had been created nor what had not. They ride
   * in the same body now, because an application holds them: `approve()` applies
   * `extendedProfile.commercial` through the same guarded service, and until the desk could send
   * one, nothing ever did.
   */
  const commit = useCallback(async (extras?: StaffExtras): Promise<boolean> => {
    const { form: f, saved: s } = latest.current;
    setBusy(true);
    clearError();
    try {
      const { body } = buildApplicationPatch(REGISTRATION_FIELDS, f, s);
      const rates = ratesChanged(f, s) ? ratePayload(f) : null;
      const lists = {
        ...(extras?.empanelments ? { empanelments: extras.empanelments } : {}),
        ...(extras?.references ? { references: extras.references } : {}),
      };
      if (!body && !rates && Object.keys(lists).length === 0) return true;

      const patch = { ...(body ?? {}), ...(rates ? { commercial: rates } : {}), ...lists };
      const updated = await api.request<ApplicationRow>(`/hr/applications/${applicationId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      // The PATCH answers with the row alone; the documents and the gap list come from the read.
      adopt({
        application: updated,
        documents: latest.current ? (view?.documents ?? []) : [],
        gaps: view?.gaps ?? [],
        documentsRequested: view?.documentsRequested ?? [],
        invitedMobile: view?.invitedMobile ?? null,
      });
      return true;
    } catch (e) {
      fail(userMessage(e), e);
      return false;
    } finally {
      setBusy(false);
    }
  }, [applicationId, adopt, clearError, fail, view]);

  const isDirty = useCallback((keys: readonly string[]): boolean => {
    const { form: f, saved: s } = latest.current;
    return keys.some((k) => (f[k] ?? '') !== (s[k] ?? ''));
  }, []);

  return {
    form,
    application: view?.application ?? null,
    applicationId,
    documents: view?.documents ?? [],
    documentsRequested: view?.documentsRequested ?? [],
    gaps: view?.gaps ?? [],
    busy,
    error,
    errorFields,
    loadError,
    loading,
    set,
    merge,
    commit,
    refresh,
    dismissError: clearError,
    isDirty,
  };
}

export type { RegistrationStepKey };
