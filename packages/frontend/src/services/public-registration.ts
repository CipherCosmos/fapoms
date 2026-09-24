import {
  ApplicationStatus, EmploymentCategory, OnboardingDocument, type ConsentNotice,
  type ApplicationInfoRequestItem,
} from '@fapoms/shared';
import { AppError, fromResponse } from './errors';
import { fetchWithTimeout, LONG_TIMEOUT_MS } from './http';
import { publicCall } from './public-fetch';

/**
 * The candidate self-registration API — public, unauthenticated, token-in-the-URL-path only.
 *
 * Deliberately NOT routed through `services/api.ts`'s `ApiClient`. That client attaches whatever
 * bearer token happens to be sitting in `localStorage` (harmless here — this controller has no
 * `JwtAuthGuard` at all and never reads it) and, more importantly, treats any `401` as "the
 * session expired" — it tries a token refresh and, failing that, forcibly navigates the tab to
 * `/login` via `window.location.replace`. A candidate filling this in from a phone's OS browser has
 * no session to expire and must never be bounced to a sign-in screen that means nothing to them.
 * `PublicRegistrationController` never issues a 401 by design, but this page has no business
 * depending on that staying true — it talks to `fetch` directly instead, the same choice
 * `pages/ViewMark.tsx` already made for the other public, link-authorised page in this app.
 *
 * Every route answers `{ success: true, data: … }` (see the controller), unwrapped here exactly
 * once, and every failure is translated through the same `fromResponse`/`fromNetwork` helpers the
 * authenticated client uses — so an error here reads in the same voice as everywhere else in the
 * app, without pulling in any of the session machinery.
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
  consentWithdrawnAt?: string | null;
  status: ApplicationStatus;
  reviewNotes: string | null;
  /**
   * Everything the person will need once they are on the roster — identity numbers, bank details,
   * emergency contact, qualification — keyed by the assayer record's own field names under
   * `fields`. One shape for the candidate's form and the desk's, because a registration that
   * collected less than the record needs is how somebody reached the roster unable to be paid.
   */
  extendedProfile: { fields?: Record<string, string | number | null> } | null;
}

export interface RegistrationApplicationDocument {
  id: string;
  applicationId: string;
  requirement: OnboardingDocument;
  filePaths: string[];
  /**
   * HR's verdict on this requirement. `NEEDS_RESUBMIT` means this file was sent back — the
   * form flags it with HR's instruction until a fresh scan lands.
   */
  reviewStatus?: string | null;
  rejectionReason?: string | null;
  rejectionNote?: string | null;
}

export interface RegistrationHydrateResult {
  application: RegistrationApplication;
  documents: RegistrationApplicationDocument[];
  documentsRequested: OnboardingDocument[];
  otpVerified?: boolean;
  /**
   * Exactly what HR asked for, when the link reopened — one entry per document or field,
   * each with its own instruction. Empty on a first fill.
   */
  infoRequests?: ApplicationInfoRequestItem[];
  /**
   * What this candidate must be shown, and agree to, before the form collects anything.
   *
   * Served by the API rather than written into this page: the wording is versioned, the version is
   * stamped on the acceptance, and the grievance contact changes with whoever holds the post. A
   * copy hard-coded here would drift out of step with what the row claims was agreed.
   */
  consentNotice: ConsentNotice & { grievanceContact: string };
  /**
   * The link has expired, and this is only how the candidate is getting on (owner, 2026-09-24):
   * `application` carries its id and status and nothing else, there is no consent notice and no
   * documents, and nothing can be changed through it. See the backend's `statusOnlyView`.
   */
  statusOnly?: boolean;
}

export interface UpdateRegistrationDraftInput {
  fullName?: string;
  /** Their own number. Verifying the code is what makes it the number on the record. */
  mobile?: string;
  email?: string;
  dateOfBirth?: string;
  gender?: string;
  address?: string;
  state?: string;
  city?: string;
  pincode?: string;
  /**
   * `null` clears a previously saved value. The backend's `@IsOptional()`
   * skips null, and the draft loop stores it — so clearing a box and leaving
   * it is a real clear, not a value that resurrects on reload.
   */
  experienceYears?: number | null;
  currentEmployer?: string;
  expertise?: string;
  availability?: string;
  employmentCategory?: EmploymentCategory;
  /** Record-shaped answers. Filtered server-side against the one shared allow-list. */
  record?: Record<string, string | number>;
  /** Who referred them — only while HR has not recorded it. `null` clears their own entry. */
  sourceReferral?: { type: string; name: string; mobile: string; email: string } | null;
  /**
   * People who can vouch for the candidate — up to three. Normalized server-side; submit
   * refuses an application with nobody ringable on it.
   */
  references?: Array<{ fullName?: string; phone?: string; relationship?: string; email?: string }>;
}

const basePath = (token: string) => `/api/v1/public/registration/${encodeURIComponent(token)}`;

const call = publicCall;

export function hydrateRegistration(token: string): Promise<RegistrationHydrateResult> {
  return call<RegistrationHydrateResult>(basePath(token));
}

/**
 * Where a verification code went. The server texts the mobile being verified when SMS is set up and
 * emails the address on the application otherwise, and says which — `sentTo` is already masked
 * ("••••• 4455", "r•••@example.com") and is shown as it comes.
 */
export interface RegistrationOtpSent {
  sent: boolean;
  channel: 'SMS' | 'EMAIL';
  sentTo: string;
  cooldownSeconds?: number;
  expiresInSeconds?: number;
}

export function requestRegistrationOtp(token: string, phone: string): Promise<RegistrationOtpSent> {
  return call(`${basePath(token)}/otp/request`, {
    method: 'POST',
    body: JSON.stringify({ phone }),
  });
}

/**
 * Said before a code is requested — one short line (owner, 2026-09-24: "keep things simple").
 *
 * Texting is how the code normally travels. When SMS is not available the server emails it
 * instead, and the line shown AFTER sending (`otpSentWords`) says exactly which one happened and
 * where, so nobody is left looking in the wrong place.
 */
export const OTP_BEFORE_SEND_WORDS = "We'll send you a 6-digit code.";

/** Said once a code is on its way: exactly where the server says it went. */
export function otpSentWords(delivery: Pick<RegistrationOtpSent, 'channel' | 'sentTo'>): string {
  const where = delivery.channel === 'SMS' ? 'texted' : 'emailed';
  return `A 6-digit code has been ${where} to ${delivery.sentTo}. It expires in 5 minutes.`;
}

export function verifyRegistrationOtp(token: string, phone: string, code: string): Promise<{ verified: boolean }> {
  return call(`${basePath(token)}/otp/verify`, {
    method: 'POST',
    body: JSON.stringify({ phone, code }),
  });
}

export interface CheckPhoneConflictResult {
  conflict: boolean;
  message?: string;
}

export function checkRegistrationPhoneConflict(
  token: string,
  phone: string,
): Promise<CheckPhoneConflictResult> {
  return call<CheckPhoneConflictResult>(
    `${basePath(token)}/check-phone/${encodeURIComponent(phone.trim())}`,
  );
}

export function updateRegistrationDraft(
  token: string,
  patch: UpdateRegistrationDraftInput,
): Promise<RegistrationApplication> {
  return call<RegistrationApplication>(`${basePath(token)}/draft`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function acceptRegistrationConsent(token: string, consentVersion: string): Promise<RegistrationApplication> {
  return call<RegistrationApplication>(`${basePath(token)}/consent`, {
    method: 'POST',
    body: JSON.stringify({ consentVersion }),
  });
}

/**
 * Taking it back — the same link, the same effort as giving it. The server erases the answers and
 * deletes the scans; this just asks.
 */
export function withdrawRegistrationConsent(token: string, reason?: string): Promise<RegistrationApplication> {
  return call<RegistrationApplication>(`${basePath(token)}/consent/withdraw`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

/**
 * Attach a file to a document row.
 *
 * `replace: true` is what "Retake" means: the server swaps out every file already on that row for
 * this one. Without it the file is added beside what is there — which is how a replacement used to
 * be sent, so a "replaced" scan quietly left the old one on the application too.
 *
 * A file the server will not take (wrong content for its name, unreadable, flagged by the scan)
 * comes back as a 400 with the code `UPLOAD_REJECTED` and a short sentence — see
 * `isUploadRejected`.
 */
export function uploadRegistrationDocument(
  token: string,
  requirement: OnboardingDocument | string,
  file: File,
  options: { replace?: boolean } = {},
): Promise<RegistrationApplicationDocument> {
  const body = new FormData();
  body.append('file', file);
  const query = options.replace ? '?replace=true' : '';
  return call<RegistrationApplicationDocument>(
    `${basePath(token)}/documents/${encodeURIComponent(requirement)}${query}`,
    { method: 'POST', body },
  );
}

/**
 * Take one file off a document row. Answers with the row as it now stands — `filePaths` may be
 * empty, which means nothing is attached for that document any more.
 */
export function removeRegistrationDocumentFile(
  token: string,
  requirement: OnboardingDocument | string,
  index: number,
): Promise<RegistrationApplicationDocument> {
  return call<RegistrationApplicationDocument>(
    `${basePath(token)}/documents/${encodeURIComponent(requirement)}/file/${index}`,
    { method: 'DELETE' },
  );
}

/** Was this the server refusing the file itself (as opposed to the network, or the link)? */
export function isUploadRejected(err: unknown): boolean {
  return err instanceof AppError && err.domainCode === 'UPLOAD_REJECTED';
}

export function submitRegistration(token: string): Promise<RegistrationApplication> {
  return call<RegistrationApplication>(`${basePath(token)}/submit`, { method: 'POST' });
}

/**
 * Three answers, not two: the directory saying "no such pincode" and nobody being able to ask are
 * different facts, and only the first one means the candidate should check their digits.
 */
export interface RegistrationPincodeLookup {
  status: 'found' | 'not-found' | 'unavailable';
  state?: string;
  district?: string;
  city?: string | null;
  /** `directory` = India Post, which defines the pincode. `map` = OpenStreetMap, worth confirming. */
  source?: 'directory' | 'map';
}

export interface RegistrationIfscLookup {
  bankName: string;
  branchName: string;
  city: string | null;
  state: string | null;
  address: string | null;
}

/**
 * Pincode → district/city/state, read through the invite token rather than a
 * session. Answers `null` when the directory has nothing for the pincode —
 * the caller degrades to hand-typing, never to a block.
 */
export function lookupRegistrationPincode(
  token: string,
  pin: string,
): Promise<RegistrationPincodeLookup | null> {
  return call<RegistrationPincodeLookup | null>(
    `${basePath(token)}/lookup/pincode/${encodeURIComponent(pin.trim())}`,
  );
}

/** IFSC → bank/branch, same terms as the pincode lookup above. */
export function lookupRegistrationIfsc(
  token: string,
  code: string,
): Promise<RegistrationIfscLookup | null> {
  return call<RegistrationIfscLookup | null>(
    `${basePath(token)}/lookup/ifsc/${encodeURIComponent(code.trim().toUpperCase())}`,
  );
}

export async function getRegistrationDocumentFileBlob(
  token: string,
  requirement: string,
  index = 0,
): Promise<Blob> {
  const path = `${basePath(token)}/documents/${encodeURIComponent(requirement)}/file/${index}`;
  const response = await fetchWithTimeout(path, { timeoutMs: LONG_TIMEOUT_MS });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw fromResponse(response.status, body);
  }
  return response.blob();
}

/** Was this failure the server saying "verify your mobile number before continuing"? */
export function isOtpVerificationLost(err: unknown): boolean {
  return err instanceof AppError && err.status === 403;
}
