import { api } from './api';

/**
 * Client for the second-factor (MFA) endpoints. Two audiences share this file:
 *  - the signed-in account managing its own factors (the Settings → Security panel), and
 *  - the login screen completing a challenge (send + verify), which happens BEFORE a session
 *    exists and so passes the challenge id rather than a bearer token.
 * Mirrors the backend contract in `auth/mfa.controller.ts` and `auth/auth.controller.ts`.
 */

export type MfaFactor = 'TOTP' | 'EMAIL' | 'SMS';

export interface MfaStatus {
  enrolled: boolean;
  confirmed: boolean;
  factors: MfaFactor[];
  recoveryCodesRemaining: number;
}

/** My current MFA status — which factors are active and how many recovery codes remain. */
export function getMfaStatus(): Promise<MfaStatus> {
  return api.request<MfaStatus>('/auth/mfa');
}

// --- Authenticator app (TOTP) ---

/** Begin TOTP enrolment; returns the setup key + otpauth URI. Not active until confirmed. */
export function enrolTotp(): Promise<{ otpauthUri: string; secret: string }> {
  return api.request('/auth/mfa/totp/enrol', { method: 'POST' });
}

/** Confirm & activate TOTP with a code; returns the one-time recovery codes (shown once). */
export function confirmTotp(code: string): Promise<{ recoveryCodes: string[] }> {
  return api.request('/auth/mfa/totp/confirm', { method: 'POST', body: JSON.stringify({ code }) });
}

// --- Email / SMS delivered codes ---

/** Begin email enrolment; sends a code to the address (defaults to the account email). */
export function enrolEmail(email?: string): Promise<{ sentTo: string }> {
  return api.request('/auth/mfa/email/enrol', { method: 'POST', body: JSON.stringify(email ? { email } : {}) });
}

export function confirmEmail(code: string): Promise<{ recoveryCodes: string[] }> {
  return api.request('/auth/mfa/email/confirm', { method: 'POST', body: JSON.stringify({ code }) });
}

/** Begin SMS enrolment; sends a code to the number. Rejected server-side if SMS is not configured. */
export function enrolSms(phone: string): Promise<{ sentTo: string }> {
  return api.request('/auth/mfa/sms/enrol', { method: 'POST', body: JSON.stringify({ phone }) });
}

export function confirmSms(code: string): Promise<{ recoveryCodes: string[] }> {
  return api.request('/auth/mfa/sms/confirm', { method: 'POST', body: JSON.stringify({ code }) });
}

// --- Manage ---

/** Remove one factor, or (with no argument) all of them. */
export function disableMfa(factor?: MfaFactor): Promise<{ message: string }> {
  const q = factor ? `?factor=${encodeURIComponent(factor)}` : '';
  return api.request(`/auth/mfa${q}`, { method: 'DELETE' });
}

/** Replace the recovery codes; the old set stops working. Returns the new codes once. */
export function regenerateRecoveryCodes(): Promise<{ recoveryCodes: string[] }> {
  return api.request('/auth/mfa/recovery/regenerate', { method: 'POST' });
}

// --- Login-time challenge (no session yet) ---

/** Send a login code over a delivered factor for an open challenge. */
export function sendChallengeCode(challengeId: string, factor: 'EMAIL' | 'SMS'): Promise<{ sent: true; to: string }> {
  return api.request('/auth/mfa/send', { method: 'POST', body: JSON.stringify({ challengeId, factor }) });
}
