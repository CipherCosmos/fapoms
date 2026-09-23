import { publicCall } from './public-fetch';

/** The server's answer to "is this ID card real, right now?" (`IdCardService`). */
export interface IdCardVerification {
  result: 'VALID' | 'NOT_VALID' | 'CODE_EXPIRED' | 'NO_MATCH';
  message: string;
  fullName?: string;
  assayerCode?: string;
  jobTitle?: string;
  organisation?: string | null;
  validTill?: string;
  clearedForNewWork?: boolean;
  photoUrl?: string | null;
  checkedAt: string;
}

/** A scanned QR — the token is the whole authorisation. */
export function verifyIdCardToken(token: string): Promise<IdCardVerification> {
  return publicCall<IdCardVerification>(`/api/v1/public/id-card/verify/${encodeURIComponent(token)}`);
}

/** The ID number and the 6-digit code, as typed from the card. */
export function verifyIdCardCode(assayerCode: string, code: string): Promise<IdCardVerification> {
  return publicCall<IdCardVerification>('/api/v1/public/id-card/verify', {
    method: 'POST',
    body: JSON.stringify({ assayerCode: assayerCode.trim(), code: code.replace(/\D/g, '') }),
  });
}
