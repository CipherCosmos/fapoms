/**
 * Turns whatever the server (or the network) produced into something a
 * non-technical user can act on.
 *
 * This application is used by field and back-office staff, not engineers. Left
 * alone, the API layer surfaced things like `API Endpoint /projects returned
 * status 500`, and NestJS validation errors arrive as an *array*, which renders
 * as `name should not be empty,projectNumber must be a string`. Neither tells
 * someone what to do next.
 *
 * Rules followed here:
 *  - Say what happened, in one sentence, in plain words.
 *  - Say what to do next whenever there is a sensible next step.
 *  - Never show a status code, endpoint path, UUID or stack to the user.
 *  - Keep the technical text on the error object for the console and logs, so
 *    debuggability is not traded away for friendliness.
 */

export class AppError extends Error {
  /** Plain-language sentence shown in the UI. */
  readonly userMessage: string;
  /** The original server/network text — for console and bug reports only. */
  readonly technical?: string;
  readonly status?: number;

  constructor(userMessage: string, technical?: string, status?: number) {
    super(userMessage);
    this.name = 'AppError';
    this.userMessage = userMessage;
    this.technical = technical;
    this.status = status;
  }
}

/** NestJS sends `message` as a string, or an array of validation failures. */
function joinServerMessage(raw: unknown): string {
  if (Array.isArray(raw)) {
    const parts = raw.filter((m) => typeof m === 'string') as string[];
    if (parts.length === 0) return '';
    if (parts.length === 1) return simplifyEnumMessage(parts[0]) ?? sentence(parts[0]);
    return `${parts.length} fields need attention: ${parts.map(fieldOf).filter(Boolean).join(', ')}.`;
  }
  return typeof raw === 'string' ? raw : '';
}

/** "projectNumber should not be empty" -> "Project Number" */
function fieldOf(msg: string): string {
  const first = msg.trim().split(/\s+/)[0];
  if (!first) return '';
  return first
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

function sentence(s: string): string {
  const t = s.trim();
  if (!t) return t;
  const capped = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}

/**
 * Server text that is already written for a human gets shown as-is — several
 * backend messages in this system deliberately explain a business rule
 * ("Cannot cancel a completed project", "Target date is a holiday in KERALA")
 * and rewriting those would lose real information.
 */
function isHumanReadable(msg: string): boolean {
  if (!msg) return false;

  // Framework noise and runtime crashes. Matched on shape, not just on the word
  // "TypeError" — a real crash message reads
  // "Cannot read properties of undefined (reading 'id')" and never names its own
  // type, so keying off the type name alone let genuine crashes reach the user.
  const TECHNICAL = [
    /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i,
    /QueryFailedError|SequelizeError|TypeORM/i,
    /null value in column|violates .*constraint|duplicate key value|invalid input syntax/i,
    /Cannot read propert|is not a function|is not defined|undefined is not/i,
    /^\s*at\s|\bstack\b/i,
    /Request failed with status|Network ?Error|Failed to fetch/i,
  ];
  if (TECHNICAL.some((re) => re.test(msg))) return false;

  // Generic server phrasing that carries no information — the status-based
  // sentence is strictly more useful than echoing these back.
  const GENERIC = new Set([
    'internal server error', 'bad request', 'unauthorized', 'forbidden',
    'not found', 'insufficient permissions', 'insufficient role permissions',
    'error', 'something went wrong', 'unknown error', 'conflict',
  ]);
  if (GENERIC.has(msg.trim().replace(/[.!]$/, '').toLowerCase())) return false;

  if (/^[A-Z_]+$/.test(msg)) return false;             // bare enum-ish token
  if (msg.length > 200) return false;                   // stack or dump
  return /\s/.test(msg);                                // more than one word
}

/**
 * "status must be one of the following values: INVITED, ACTIVE, …" is accurate
 * but reads like a database error. Field name plus a short list is enough.
 */
function simplifyEnumMessage(msg: string): string | null {
  const m = msg.match(/^(\w+) must be one of the following values:\s*(.+)$/i);
  if (!m) return null;
  const field = fieldOf(m[1]);
  const values = m[2].split(',').map((v) => v.trim()).filter(Boolean);
  const shown = values.slice(0, 4).join(', ');
  const more = values.length > 4 ? `, or ${values.length - 4} other options` : '';
  return `${field} must be one of: ${shown}${more}.`;
}

const BY_STATUS: Record<number, string> = {
  400: 'Some of the details entered are not valid. Please check the highlighted fields and try again.',
  401: 'Your session has expired. Please sign in again.',
  403: 'You do not have permission to do this. If you believe you should, ask an administrator to update your role.',
  404: 'That record could not be found. It may have been removed or renamed.',
  409: 'Someone else changed this record while you were working on it. Refresh the page and try again.',
  413: 'That file is too large to upload. Try a smaller file.',
  422: 'Some of the details entered are not valid. Please check the highlighted fields and try again.',
  429: 'Too many requests at once. Please wait a moment and try again.',
  500: 'Something went wrong on our side. Your work has not been saved — please try again in a moment.',
  502: 'The server is not reachable right now. Please try again shortly.',
  503: 'The system is temporarily unavailable, usually during a restart. Please try again in a minute.',
  504: 'The server took too long to respond. Please try again.',
};

/** Builds the error thrown by the API client for a failed HTTP response. */
export function fromResponse(status: number, body: any): AppError {
  const serverText = joinServerMessage(body?.message);
  const friendly =
    (isHumanReadable(serverText) ? sentence(serverText) : '') ||
    BY_STATUS[status] ||
    'Something went wrong. Please try again.';
  return new AppError(friendly, serverText || `HTTP ${status}`, status);
}

/** Builds the error for a fetch that never reached the server at all. */
export function fromNetwork(err: unknown): AppError {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  return new AppError(
    offline
      ? 'You appear to be offline. Check your internet connection — your work has not been lost.'
      : 'Could not reach the server. Check your connection and try again.',
    err instanceof Error ? err.message : String(err),
  );
}

/**
 * What any component should render. Accepts anything caught, including errors
 * from code that does not use the API client.
 */
export function userMessage(err: unknown): string {
  if (err instanceof AppError) return err.userMessage;
  if (err instanceof Error) {
    const isRuntimeCrash = ['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'].includes(err.name);
    return !isRuntimeCrash && isHumanReadable(err.message)
      ? sentence(err.message)
      : 'Something went wrong. Please try again.';
  }
  return 'Something went wrong. Please try again.';
}
