import { Platform } from 'react-native';
import type { EmploymentCategory } from '@fapoms/shared';
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

export type ApplicationStatus = 'DRAFT' | 'PENDING_VALIDATION' | 'AWAITING_INFO' | 'REJECTED' | 'APPROVED';

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
  status: ApplicationStatus;
  reviewNotes: string | null;
}

export interface RegistrationDocument {
  requirement: string;
  filePaths: string[];
}

export interface RegistrationHydration {
  application: RegistrationApplication;
  documents: RegistrationDocument[];
  documentsRequested: string[];
}

/** Mirrors `UpdateApplicationDraftDto` on the backend. Every field optional; only what changed is sent. */
export interface DraftPatch {
  fullName?: string;
  email?: string;
  /** ISO date string, e.g. '1990-04-21'. */
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

export type SelfRegResult<T> = { success: true; data: T } | { success: false; error: string };

const TIMEOUT_MS = 20_000;

async function call<T>(path: string, options: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<SelfRegResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
    const headers: Record<string, string> = { ...(options.headers as Record<string, string> | undefined) };
    // A multipart body needs the runtime to set its own boundary; forcing JSON here corrupts
    // the upload, the same trap `MobileApiService.fetchWithAuthOnce` documents.
    if (!isForm) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${getApiBaseUrl()}${path}`, { ...options, headers, signal: controller.signal });
    const body = await response.json().catch(() => ({}) as any);
    if (response.ok && body?.success !== false) {
      return { success: true, data: body?.data as T };
    }
    const message = Array.isArray(body?.message)
      ? body.message.join(', ')
      : body?.message || `Request failed (${response.status})`;
    return { success: false, error: message };
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

  requestOtp(token: string, phone: string): Promise<SelfRegResult<{ sent: boolean }>> {
    return call<{ sent: boolean }>(`${base(token)}/otp/request`, {
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

  /**
   * Uploads one document scan for one requirement.
   *
   * Same `{uri, name, type}` multipart shape `MobileApiService.uploadChatAttachment` and
   * `uploadFeedbackAttachments` already use for a native RN FormData part — deliberately NOT
   * the resumable/chunked path `uploadAuditPdfResumable` uses, since a registration document is
   * a single small image or PDF, not a multi-megabyte audit packet.
   */
  uploadDocument(
    token: string,
    requirement: string,
    file: { uri: string; name: string; mimeType?: string },
  ): Promise<SelfRegResult<RegistrationDocument>> {
    const form = new FormData();
    if (Platform.OS === 'web') {
      form.append('file', file as unknown as Blob, file.name);
    } else {
      form.append('file', {
        uri: file.uri,
        name: file.name,
        type: file.mimeType || 'application/octet-stream',
      } as unknown as Blob);
    }
    return call<RegistrationDocument>(
      `${base(token)}/documents/${encodeURIComponent(requirement)}`,
      { method: 'POST', body: form },
      60_000,
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
