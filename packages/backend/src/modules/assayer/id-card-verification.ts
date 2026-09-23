import { createHmac, timingSafeEqual } from 'crypto';

/**
 * WHAT MAKES THE DIGITAL ID CARD CHECKABLE (owner, 2026-09-23).
 *
 * The app shows a QR code and a 6-digit code that both change every minute. Scanning the QR, or
 * typing the assayer's ID number and the 6 digits on the public verification page, asks the server
 * — which answers from the record as it is NOW. A screenshot of the card is worth nothing a couple
 * of minutes later: its code has expired, and the page says so.
 *
 * Nothing is stored. The QR carries a signed, short-lived token; the 6 digits are derived from the
 * person and the current minute. Both are keyed off a secret derived from the server's own signing
 * secret, so neither can be minted anywhere else.
 */

/** How often the code on the card changes. */
export const LIVE_CODE_WINDOW_SECONDS = 60;
/** How long a scanned QR stays good — the current minute, and the one before it. */
export const LIVE_TOKEN_TTL_SECONDS = 2 * LIVE_CODE_WINDOW_SECONDS;
/** How long the verification page may show the person's photo after a successful check. */
export const PHOTO_TOKEN_TTL_SECONDS = 10 * 60;

type Purpose = 'c' | 'p'; // card, photo

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** A key for this purpose only, derived from the server's signing secret. */
export function idCardKey(serverSecret: string): Buffer {
  return createHmac('sha256', serverSecret).update('fapoms/id-card-verification/v1').digest();
}

function sign(key: Buffer, body: string): string {
  return b64url(createHmac('sha256', key).update(body).digest());
}

/** A signed token naming the person, for this purpose, until `now + ttl`. */
export function signCardToken(key: Buffer, assayerId: string, nowSeconds: number, purpose: Purpose = 'c', ttlSeconds = LIVE_TOKEN_TTL_SECONDS): string {
  const body = b64url(Buffer.from(JSON.stringify({ a: assayerId, e: nowSeconds + ttlSeconds, p: purpose })));
  return `${body}.${sign(key, body)}`;
}

export type TokenCheck = { ok: true; assayerId: string } | { ok: false; why: 'invalid' | 'expired' };

/** Is this token ours, for this purpose, and still in date? */
export function verifyCardToken(key: Buffer, token: string, nowSeconds: number, purpose: Purpose = 'c'): TokenCheck {
  const [body, sig] = String(token ?? '').split('.');
  if (!body || !sig) return { ok: false, why: 'invalid' };
  const expected = Buffer.from(sign(key, body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, why: 'invalid' };
  let claims: { a?: unknown; e?: unknown; p?: unknown };
  try { claims = JSON.parse(fromB64url(body).toString('utf8')); } catch { return { ok: false, why: 'invalid' }; }
  if (typeof claims.a !== 'string' || typeof claims.e !== 'number' || claims.p !== purpose) return { ok: false, why: 'invalid' };
  if (nowSeconds > claims.e) return { ok: false, why: 'expired' };
  return { ok: true, assayerId: claims.a };
}

/** The minute a moment falls in. */
export const codeWindow = (nowSeconds: number) => Math.floor(nowSeconds / LIVE_CODE_WINDOW_SECONDS);

/** The 6 digits on the card for this person in this minute. */
export function liveCardCode(key: Buffer, assayerId: string, window: number): string {
  const mac = createHmac('sha256', key).update(`${assayerId}:${window}`).digest();
  return String(mac.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

/** Does this code match the person now, or in the minute just gone? */
export function checkLiveCardCode(key: Buffer, assayerId: string, code: string, nowSeconds: number): boolean {
  const typed = String(code ?? '').replace(/\D/g, '');
  if (typed.length !== 6) return false;
  const w = codeWindow(nowSeconds);
  return [w, w - 1].some((win) => {
    const want = Buffer.from(liveCardCode(key, assayerId, win));
    const got = Buffer.from(typed);
    return want.length === got.length && timingSafeEqual(want, got);
  });
}
