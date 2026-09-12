import { ApplicationStatus, EmploymentCategory, OnboardingDocument } from '@fapoms/shared';
import { AppError, fromNetwork, fromResponse } from './errors';
import { fetchWithTimeout, DEFAULT_TIMEOUT_MS, LONG_TIMEOUT_MS } from './http';

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
  status: ApplicationStatus;
  reviewNotes: string | null;
}

export interface RegistrationApplicationDocument {
  id: string;
  applicationId: string;
  requirement: OnboardingDocument;
  filePaths: string[];
}

export interface RegistrationHydrateResult {
  application: RegistrationApplication;
  documents: RegistrationApplicationDocument[];
  documentsRequested: OnboardingDocument[];
}

export interface UpdateRegistrationDraftInput {
  fullName?: string;
  email?: string;
  dateOfBirth?: string;
  gender?: string;
  address?: string;
  state?: string;
  city?: string;
  pincode?: string;
  experienceYears?: number;
  currentEmployer?: string;
  expertise?: string;
  availability?: string;
  employmentCategory?: EmploymentCategory;
}

const basePath = (token: string) => `/api/v1/public/registration/${encodeURIComponent(token)}`;

/**
 * `fetch`, a deadline, envelope-unwrapping and error translation — everything `ApiClient.send`
 * does, minus the auth header and the 401→refresh→redirect dance neither applies here.
 */
async function call<T>(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const isForm = init?.body instanceof FormData;
  const timeoutMs = init?.timeoutMs ?? (isForm ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  const headers: Record<string, string> = {
    ...(isForm ? {} : { 'Content-Type': 'application/json' }),
    ...((init?.headers as Record<string, string>) || {}),
  };

  let response: Response;
  try {
    response = await fetchWithTimeout(path, { ...init, headers, timeoutMs });
  } catch (err) {
    throw fromNetwork(err);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw fromResponse(response.status, body);
  }

  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return undefined as unknown as T;
  }

  const json = await response.json();
  const enveloped = json !== null && typeof json === 'object' && !Array.isArray(json)
    && 'success' in json && 'data' in json;
  return (enveloped ? json.data : json) as T;
}

export function hydrateRegistration(token: string): Promise<RegistrationHydrateResult> {
  return call<RegistrationHydrateResult>(basePath(token));
}

export function requestRegistrationOtp(token: string, phone: string): Promise<{ sent: boolean }> {
  return call(`${basePath(token)}/otp/request`, {
    method: 'POST',
    body: JSON.stringify({ phone }),
  });
}

export function verifyRegistrationOtp(token: string, phone: string, code: string): Promise<{ verified: boolean }> {
  return call(`${basePath(token)}/otp/verify`, {
    method: 'POST',
    body: JSON.stringify({ phone, code }),
  });
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

export function uploadRegistrationDocument(
  token: string,
  requirement: OnboardingDocument | string,
  file: File,
): Promise<RegistrationApplicationDocument> {
  const body = new FormData();
  body.append('file', file);
  return call<RegistrationApplicationDocument>(
    `${basePath(token)}/documents/${encodeURIComponent(requirement)}`,
    { method: 'POST', body },
  );
}

export function submitRegistration(token: string): Promise<RegistrationApplication> {
  return call<RegistrationApplication>(`${basePath(token)}/submit`, { method: 'POST' });
}

/** Was this failure the server saying "verify your mobile number before continuing"? */
export function isOtpVerificationLost(err: unknown): boolean {
  return err instanceof AppError && err.status === 403;
}
