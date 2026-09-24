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
  /**
   * Whether a text message can be set up as a factor on this server. False until an administrator
   * configures SMS; the panel then shows the option as unavailable instead of letting someone type a
   * number only to be refused.
   */
  smsAvailable: boolean;
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

/**
 * Proof that the person is the account holder, not just someone holding their session. The server
 * requires one of these before anything that weakens the account (turning a factor off, replacing
 * the recovery codes): the current password, or a fresh code from the authenticator app.
 */
export interface MfaStepUpProof {
  currentPassword?: string;
  code?: string;
}

/** Only the fields that were actually filled in go to the server. */
function proofBody(proof: MfaStepUpProof): string {
  const body: MfaStepUpProof = {};
  if (proof.currentPassword) body.currentPassword = proof.currentPassword;
  if (proof.code?.trim()) body.code = proof.code.trim();
  return JSON.stringify(body);
}

/** Remove one factor, or (with no factor) all of them. Needs the password or an authenticator code. */
export function disableMfa(factor: MfaFactor | undefined, proof: MfaStepUpProof): Promise<{ message: string }> {
  const q = factor ? `?factor=${encodeURIComponent(factor)}` : '';
  return api.request(`/auth/mfa${q}`, { method: 'DELETE', body: proofBody(proof) });
}

/** Replace the recovery codes; the old set stops working. Returns the new codes once. Needs proof as above. */
export function regenerateRecoveryCodes(proof: MfaStepUpProof): Promise<{ recoveryCodes: string[] }> {
  return api.request('/auth/mfa/recovery/regenerate', { method: 'POST', body: proofBody(proof) });
}

// --- Login-time challenge (no session yet) ---

/** Send a login code over a delivered factor for an open challenge. */
export function sendChallengeCode(challengeId: string, factor: 'EMAIL' | 'SMS'): Promise<{ sent: true; to: string }> {
  return api.request('/auth/mfa/send', { method: 'POST', body: JSON.stringify({ challengeId, factor }) });
}
