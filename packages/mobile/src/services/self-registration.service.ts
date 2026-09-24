import { Platform } from 'react-native';
import {
  ApplicationStatus, type ApplicationInfoRequestItem, type ConsentNotice, type EmploymentCategory, type SourceReferral,
} from '@fapoms/shared';
import { getApiBaseUrl } from './api.service';

/**
 * The mobile client for the Appraiser Recruitment self-registration API.
 *
 * Deliberately separate from `MobileApiService`: every call here is unauthenticated — a
 * candidate has no account yet, only the one-time token in the invite link — so none of
 * `MobileApiService`'s session machinery (bearer header, 401→refresh→retry, the password/
 * registration gates) applies, and reusing it would risk an Authorization header from a
 * DIFFERENT signed-in session (e.g. an HR staffer testing on the same handset) leaking onto a
 * request that must stand on the token alone. See `public-registration.controller.ts` on the
 * backend for the routes this mirrors — no `@Roles`/`JwtAuthGuard` there either.
 */

export interface RegistrationApplication {
  id: string;
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
  employmentCategory: EmploymentCategory | null;
  consentAcceptedAt: string | null;
  consentVersion: string | null;
  status: ApplicationStatus;
  reviewNotes: string | null;
  /**
   * The rest of the person, keyed by the assayer record's own field names — identity numbers,
   * bank details, emergency contact, qualification. Same shape the web form and the desk use.
   * `references` rides beside the fields: people who can vouch for the candidate, replayed
   * onto the record at approval.
   */
  extendedProfile: {
    fields?: Record<string, string | number | null>;
    references?: RegistrationReference[];
    /** Who referred them — HR's entry (shown, not changed here) or their own. */
    sourceReferral?: SourceReferral | null;
  } | null;
}

export interface RegistrationDocument {
  requirement: string;
  filePaths: string[];
  /** HR's verdict on this requirement — `NEEDS_RESUBMIT` flags it until a fresh scan lands. */
  reviewStatus?: string | null;
  rejectionReason?: string | null;
  rejectionNote?: string | null;
}

/** Somebody who can vouch for the candidate — name plus a number that dials. Email where known. */
export interface RegistrationReference {
  fullName: string;
  phone?: string;
  relationship?: string;
  email?: string;
}

export interface RegistrationHydration {
  application: RegistrationApplication;
  documents: RegistrationDocument[];
  documentsRequested: string[];
  /** The server's own record that this link's number was confirmed, so a reopen does not ask again. */
  otpVerified?: boolean;
  /** Exactly what HR asked for — the to-do list this link renders instead of one note. */
  infoRequests?: ApplicationInfoRequestItem[];
  /**
   * What must be shown, and agreed to, before the form collects anything. Served rather than
   * bundled: the version is stamped on the acceptance, so the words read and the words recorded
   * must be the same ones.
   */
  consentNotice: ConsentNotice & { grievanceContact: string };
  /**
   * The link has expired and this is only how the candidate is getting on (2026-09-24): the
   * application is its id and status, there is no consent notice, and nothing can be changed.
   */
  statusOnly?: boolean;
}

export interface RegistrationPincodeLookup {
  status: 'found' | 'not-found' | 'unavailable';
  state?: string;
  district?: string;
  city?: string | null;
  /** `directory` is India Post, which defines a pincode; `map` is OpenStreetMap standing in. */
  source?: 'directory' | 'map';
}

export interface RegistrationIfscLookup {
  bankName: string;
  branchName: string;
  city: string | null;
  state: string | null;
  address: string | null;
}

/** Mirrors `UpdateApplicationDraftDto` on the backend. Every field optional; only what changed is sent. */
export interface DraftPatch {
  fullName?: string;
  /** Their own number. Verifying the code is what makes it the number on the record. */
  mobile?: string;
  email?: string;
  /** ISO date string, e.g. '1990-04-21'. */
  dateOfBirth?: string;
  gender?: string;
  address?: string;
  state?: string;
  city?: string;
  pincode?: string;
  /** `null` clears a saved value. */
  experienceYears?: number | null;
  currentEmployer?: string;
  expertise?: string;
  availability?: string;
  employmentCategory?: EmploymentCategory;
  /**
   * Record-shaped answers, filtered server-side against the one shared allow-list.
   *
   * The phone asked for none of these, so anybody who registered from it arrived on the roster
   * with no PAN to deduct tax against, no account to pay into and nobody to call — while having
   * dutifully photographed the PAN card. See `REGISTRATION_RECORD_FIELD_KEYS` in the shared
   * package for what the server will keep.
   */
  record?: Record<string, string | number>;
  /**
   * People who can vouch for the candidate — up to three. Normalized server-side; submit
   * refuses an application with nobody ringable on it.
   */
  references?: Array<{ fullName?: string; phone?: string; relationship?: string; email?: string }>;
  /** Who referred them — only while HR has not recorded it. `null` clears their own entry. */
  sourceReferral?: { type: string; name: string; mobile: string; email: string } | null;
}

/**
 * Where a verification code went: `SMS` to the mobile being verified, or `EMAIL` to the invite's
 * address when texts are not available. `sentTo` arrives masked ("••••• 4455", "r•••@example.com").
 */
export interface OtpDelivery {
  channel: 'SMS' | 'EMAIL';
  sentTo: string;
  /** Seconds before another code may be asked for — the server's setting, not a number of ours. */
  cooldownSeconds?: number;
  /** Seconds this code stays usable. */
  expiresInSeconds?: number;
}

export type SelfRegResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; code?: string; status?: number };

/** The server saying the number has to be confirmed (again) before this can go through. */
export function isVerificationLost(result: SelfRegResult<unknown>): boolean {
  return !result.success && result.status === 403;
}

const TIMEOUT_MS = 20_000;

/**
 * The server this registration is on, when it is not the one the app signs in to.
 *
 * Set only by `open`, in development builds, from the link the candidate pasted. A token exists on
 * exactly one server; a browser follows the link's host automatically, and the app used to ignore
 * it, so a link from any other stack reported "not valid" on mobile while opening fine on the web.
 */
let linkApiRoot: string | null = null;

async function call<T>(path: string, options: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<SelfRegResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
    const headers: Record<string, string> = { ...(options.headers as Record<string, string> | undefined) };
    // A multipart body needs the runtime to set its own boundary; forcing JSON here corrupts
    // the upload, the same trap `MobileApiService.fetchWithAuthOnce` documents.
    if (!isForm) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${linkApiRoot ?? getApiBaseUrl()}${path}`, { ...options, headers, signal: controller.signal });
    const body = await response.json().catch(() => ({}) as any);
    if (response.ok && body?.success !== false) {
      return { success: true, data: body?.data as T };
    }
    const message = Array.isArray(body?.message)
      ? body.message.join(', ')
      : body?.message || `Request failed (${response.status})`;
    return { success: false, error: message, code: body?.code, status: response.status };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return { success: false, error: 'The request timed out. Check your connection and try again.' };
    }
    return { success: false, error: err?.message || 'Could not reach the server. Check your connection.' };
  } finally {
    clearTimeout(timer);
  }
}

const base = (token: string) => `/public/registration/${encodeURIComponent(token)}`;

export const SelfRegistrationApi = {
  hydrate(token: string): Promise<SelfRegResult<RegistrationHydration>> {
    return call<RegistrationHydration>(base(token));
  },

  /**
   * Opens the registration behind whatever the candidate pasted, and pins the server it is on
   * for every later call in this registration.
   *
   * The app's own server is always asked first. Only a development build falls back to the
   * server named in the link: a release build must never be steered by a pasted link into
   * sending identity numbers and bank details to a host nobody configured.
   */
  async open(pasted: string): Promise<{ token: string; result: SelfRegResult<RegistrationHydration> }> {
    linkApiRoot = null;
    const token = extractRegistrationToken(pasted);
    const result = await SelfRegistrationApi.hydrate(token);
    if (result.success || !__DEV__) return { token, result };
    // Any other refusal (an expired link, say) means this server does hold the token.
    if (result.code !== undefined && result.code !== 'NOT_FOUND') return { token, result };

    const fromLink = registrationLinkApiRoot(pasted);
    if (!fromLink || fromLink === getApiBaseUrl().replace(/\/+$/, '')) return { token, result };
    linkApiRoot = fromLink;
    const retried = await SelfRegistrationApi.hydrate(token);
    if (retried.success) return { token, result: retried };
    linkApiRoot = null;
    return { token, result };
  },

  /** Texted to `phone` when the server has SMS set up, emailed otherwise; the answer says which. */
  requestOtp(token: string, phone: string): Promise<SelfRegResult<OtpDelivery>> {
    return call<OtpDelivery>(`${base(token)}/otp/request`, {
      method: 'POST',
      body: JSON.stringify({ phone }),
    });
  },

  verifyOtp(token: string, phone: string, code: string): Promise<SelfRegResult<{ verified: boolean }>> {
    return call<{ verified: boolean }>(`${base(token)}/otp/verify`, {
      method: 'POST',
      body: JSON.stringify({ phone, code }),
    });
  },

  updateDraft(token: string, patch: DraftPatch): Promise<SelfRegResult<RegistrationApplication>> {
    return call<RegistrationApplication>(`${base(token)}/draft`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },

  acceptConsent(token: string, consentVersion: string): Promise<SelfRegResult<RegistrationApplication>> {
    return call<RegistrationApplication>(`${base(token)}/consent`, {
      method: 'POST',
      body: JSON.stringify({ consentVersion }),
    });
  },

  /** Taking it back: the server stops the application and erases what was given. */
  withdrawConsent(token: string, reason?: string): Promise<SelfRegResult<RegistrationApplication>> {
    return call<RegistrationApplication>(`${base(token)}/consent/withdraw`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },

  /** Whether this number already belongs to somebody else; `message` is the server's own sentence. */
  checkPhone(token: string, phone: string): Promise<SelfRegResult<{ conflict: boolean; message?: string }>> {
    return call(`${base(token)}/check-phone/${encodeURIComponent(phone.trim())}`);
  },

  lookupPincode(token: string, pincode: string): Promise<SelfRegResult<RegistrationPincodeLookup | null>> {
    return call(`${base(token)}/lookup/pincode/${encodeURIComponent(pincode.trim())}`);
  },

  lookupIfsc(token: string, code: string): Promise<SelfRegResult<RegistrationIfscLookup | null>> {
    return call(`${base(token)}/lookup/ifsc/${encodeURIComponent(code.trim().toUpperCase())}`);
  },

  /** Where one attached scan can be read back from; the token in the path is its only credential. */
  documentFileUrl(token: string, requirement: string, index: number): string {
    return `${linkApiRoot ?? getApiBaseUrl()}${base(token)}/documents/${encodeURIComponent(requirement)}/file/${index}`;
  },

  /**
   * Uploads one document scan for one requirement.
   *
   * Same `{uri, name, type}` multipart shape `MobileApiService.uploadChatAttachment` and
   * `uploadFeedbackAttachments` already use for a native RN FormData part — deliberately NOT
   * the resumable/chunked path `uploadAuditPdfResumable` uses, since a registration document is
   * a single small image or PDF, not a multi-megabyte audit packet.
   */
  async uploadDocument(
    token: string,
    requirement: string,
    file: { uri: string; name: string; mimeType?: string },
    /**
     * `true` replaces every file this requirement holds (a retake); otherwise the file is added
     * after them (another page). The server answers with the document as it now stands.
     */
    options: { replace?: boolean } = {},
  ): Promise<SelfRegResult<RegistrationDocument>> {
    const form = new FormData();
    if (Platform.OS === 'web') {
      // A browser FormData takes bytes, not `{uri}` — appending the descriptor sent "[object Object]".
      try {
        form.append('file', await (await fetch(file.uri)).blob(), file.name);
      } catch {
        return { success: false, error: 'Could not read that file. Choose it again.' };
      }
    } else {
      form.append('file', {
        uri: file.uri,
        name: file.name,
        type: file.mimeType || 'application/octet-stream',
      } as unknown as Blob);
    }
    return call<RegistrationDocument>(
      `${base(token)}/documents/${encodeURIComponent(requirement)}${options.replace ? '?replace=true' : ''}`,
      { method: 'POST', body: form },
      60_000,
    );
  },

  /** Takes one file off a requirement; the answer is the document with what is left (maybe none). */
  deleteDocumentFile(token: string, requirement: string, index: number): Promise<SelfRegResult<RegistrationDocument>> {
    return call<RegistrationDocument>(
      `${base(token)}/documents/${encodeURIComponent(requirement)}/file/${index}`,
      { method: 'DELETE' },
    );
  },

  submit(token: string): Promise<SelfRegResult<RegistrationApplication>> {
    return call<RegistrationApplication>(`${base(token)}/submit`, { method: 'POST' });
  },
};

/**
 * Pulls a raw token out of whatever the candidate pasted.
 *
 * The invite email links to `<web origin>/register/<token>` (see
 * `RegistrationApplicationService.sendInviteEmail`); there is no mobile deep link registered
 * for it (no `scheme` in app.config.js, no `expo-linking` dependency), so a candidate reaches
 * this screen by copying that same link, or just the token, into a plain text field. Accepts
 * either form.
 */
export function extractRegistrationToken(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/\/register\/([^/?#\s]+)/i);
  if (match) return match[1];
  // Otherwise assume the whole pasted value is the token itself; strip anything a link's query
  // string or trailing slash could have left behind.
  return trimmed.split(/[?#]/)[0].replace(/\/+$/, '');
}

/** The API root on the host a pasted invite link names, or null for a bare token. */
export function registrationLinkApiRoot(raw: string): string | null {
  const match = raw.trim().match(/^(https?:\/\/[^/?#\s]+)\/(?:[^?#\s]*\/)?register\//i);
  return match ? `${match[1]}/api/v1` : null;
}
