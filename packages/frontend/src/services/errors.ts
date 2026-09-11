/**
 * Domain Error Translation System
 *
 * Turns backend HTTP responses, RPC exceptions, and domain violation codes into
 * clear, actionable, operator-friendly messages.
 *
 * Classifies errors into canonical behavioral categories with structured output:
 * category, title, message, action, retryable, requiresRefresh.
 */

export type ErrorTranslationCategory =
  | 'validation'
  | 'permission'
  | 'not_found'
  | 'conflict'
  | 'rate_limit'
  | 'server_failure'
  | 'network_failure'
  | 'business_rule';

export interface ErrorTranslation {
  category: ErrorTranslationCategory;
  title: string;
  message: string;
  action: string;
  retryable: boolean;
  requiresRefresh?: boolean;
  statusCode?: number;
  domainCode?: string;
  technical?: string;
}

// Backwards compatibility types
export type ErrorCategory =
  | 'retryable'
  | 'non-retryable'
  | 'user-correction-required'
  | 'permission-required'
  | 'conflict'
  | 'system-failure';

export interface ClassifiedError {
  userMessage: string;
  category: ErrorCategory;
  isConflict: boolean;
  isRetryable: boolean;
  statusCode?: number;
  domainCode?: string;
  technical?: string;
}

export class AppError extends Error {
  /** Plain-language sentence shown in the UI. */
  readonly userMessage: string;
  /** The original server/network text — for console and bug reports only. */
  readonly technical?: string;
  readonly status?: number;
  readonly category: ErrorCategory;
  readonly domainCode?: string;

  constructor(
    userMessage: string,
    technical?: string,
    status?: number,
    category: ErrorCategory = 'user-correction-required',
    domainCode?: string
  ) {
    super(userMessage);
    this.name = 'AppError';
    this.userMessage = userMessage;
    this.technical = technical;
    this.status = status;
    this.category = category;
    this.domainCode = domainCode;
  }
}

/** Specific domain error codes mapped to clear, actionable operator guidance */
const DOMAIN_ERROR_TRANSLATIONS: Record<
  string,
  {
    message: string;
    category: ErrorCategory;
    translationCategory: ErrorTranslationCategory;
    title: string;
    action: string;
    requiresRefresh?: boolean;
  }
> = {
  ASSAYER_NOT_ACTIVE: {
    message: 'This assayer is no longer active and eligible for assignment dispatch.',
    category: 'user-correction-required',
    translationCategory: 'business_rule',
    title: 'Assayer Ineligible',
    action: 'Select an active assayer or check their onboarding/leave status in Workforce.',
  },
  EMPANELMENT_BLOCKED: {
    message: 'Assignment is blocked: this assayer does not hold an active or recommended empanelment with this client bank.',
    category: 'user-correction-required',
    translationCategory: 'business_rule',
    title: 'Empanelment Required',
    action: 'Request client empanelment or managerial override before scheduling.',
  },
  EMPANELMENT_REVOKED: {
    message: 'Empanelment has been revoked or terminated by the client bank. Managerial bypass is prohibited by compliance policy.',
    category: 'non-retryable',
    translationCategory: 'business_rule',
    title: 'Empanelment Revoked',
    action: 'Assign a different qualified assayer. Revoked empanelment cannot be bypassed.',
  },
  DOCUMENT_SUPERSEDED: {
    message: 'A newer document version has already been submitted and is currently under review.',
    category: 'conflict',
    translationCategory: 'conflict',
    title: 'Document Version Superseded',
    action: 'Reload to review the latest uploaded version.',
    requiresRefresh: true,
  },
  DOCUMENT_ALREADY_REVIEWED: {
    message: 'This document version has already been reviewed and finalized by another operator.',
    category: 'conflict',
    translationCategory: 'conflict',
    title: 'Already Finalized',
    action: 'Reload the record to view the current verification verdict.',
    requiresRefresh: true,
  },
  IDENTITY_NOT_VERIFIED: {
    message: 'Mandatory KYC identity documents (PAN / Aadhaar) must be verified before this assayer can be activated.',
    category: 'user-correction-required',
    translationCategory: 'business_rule',
    title: 'KYC Verification Incomplete',
    action: 'Verify required identity documents in the assayer profile first.',
  },
  PAYOUT_NOT_ELIGIBLE: {
    message: 'This payout cannot be approved until field attendance and verified bank details are confirmed.',
    category: 'user-correction-required',
    translationCategory: 'business_rule',
    title: 'Payout Ineligible',
    action: 'Confirm on-site check-in and bank account verification before approving payout.',
  },
  IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST: {
    message: 'This request key was already submitted with different details. Please reload and submit a fresh operation.',
    category: 'conflict',
    translationCategory: 'conflict',
    title: 'Request Conflict',
    action: 'Reload the page and re-apply your changes.',
    requiresRefresh: true,
  },
  RECORD_CONCURRENTLY_MODIFIED: {
    message: 'This record was modified by another operator while you were working on it. Your changes were not applied.',
    category: 'conflict',
    translationCategory: 'conflict',
    title: 'Concurrent Modification',
    action: 'Reload authoritative data from the server to reconcile differences before retrying.',
    requiresRefresh: true,
  },
  ACCOUNT_ON_HOLD: {
    message: 'This account has been placed on hold or suspended. Operational actions are temporarily locked.',
    category: 'permission-required',
    translationCategory: 'permission',
    title: 'Account On Hold',
    action: 'Contact an administrator to resolve the compliance hold.',
  },
  ACCOUNT_CLOSED: {
    message: 'This account has been closed and archived.',
    category: 'non-retryable',
    translationCategory: 'business_rule',
    title: 'Account Closed',
    action: 'Closed records cannot accept modifications.',
  },
};

/** NestJS sends `message` as a string, or an array of validation failures. */
/**
 * The server's validation messages, kept rather than summarised away.
 *
 * ## What this used to do, and why it was worse than it looked
 *
 * Two or more errors collapsed to a count and a list of FIELD NAMES: "2 fields need attention:
 * End Date, Budget." One error kept its full text. So the moment somebody got two things wrong —
 * the common case on a form of any size — every sentence the server had carefully written was
 * discarded and replaced with a list of labels.
 *
 * The failure is worst exactly where the message matters most. The server said
 * `endDate must be on or after startDate`; the user was told "End Date". The end date is
 * perfectly well-formed, so "End Date" points at a field with nothing visibly wrong with it and
 * says nothing about the ordering, which is the actual problem. A field name can only carry the
 * message when the message is "this is missing" or "this is malformed"; it cannot carry a rule
 * about two fields, a range, or a business constraint — and those are the ones people get stuck on.
 *
 * ## What it does now
 *
 * Every message, one per line, each turned into a sentence. A short heading keeps the count
 * visible for scanning. Capped at six lines because past that a toast becomes a wall and the form
 * itself is the better place to look — and the cap says how many are hidden rather than silently
 * dropping them.
 */
const MAX_LISTED_VALIDATION_MESSAGES = 6;

function joinServerMessage(raw: unknown): string {
  if (Array.isArray(raw)) {
    const parts = raw.filter((m) => typeof m === 'string') as string[];
    if (parts.length === 0) return '';
    if (parts.length === 1) return simplifyEnumMessage(parts[0]) ?? sentence(parts[0]);

    const lines = parts
      .slice(0, MAX_LISTED_VALIDATION_MESSAGES)
      .map((m) => `• ${simplifyEnumMessage(m) ?? sentence(m)}`);
    const hidden = parts.length - lines.length;
    if (hidden > 0) lines.push(`• and ${hidden} more.`);

    return [`${parts.length} things need attention:`, ...lines].join('\n');
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

function extractDomainCode(text: string): string | undefined {
  const match = text.match(/\b([A-Z][A-Z0-9_]{3,35})\b/);
  if (match && DOMAIN_ERROR_TRANSLATIONS[match[1]]) {
    return match[1];
  }
  return undefined;
}

/**
 * Server text that is already written for a human gets shown as-is.
 */
function isHumanReadable(msg: string): boolean {
  if (!msg) return false;

  const TECHNICAL = [
    /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i,
    /QueryFailedError|SequelizeError|TypeORM/i,
    /null value in column|violates .*constraint|duplicate key value|invalid input syntax/i,
    /Cannot read propert|is not a function|is not defined|undefined is not/i,
    /^\s*at\s|\bstack\b/i,
    /Request failed with status|Network ?Error|Failed to fetch/i,
  ];
  if (TECHNICAL.some((re) => re.test(msg))) return false;

  const GENERIC = new Set([
    'internal server error',
    'bad request',
    'unauthorized',
    'forbidden',
    'not found',
    'insufficient permissions',
    'insufficient role permissions',
    'error',
    'something went wrong',
    'unknown error',
    'conflict',
  ]);
  if (GENERIC.has(msg.trim().replace(/[.!]$/, '').toLowerCase())) return false;

  if (/^[A-Z_]+$/.test(msg)) return false;
  if (msg.length > 250) return false;
  return /\s/.test(msg);
}

function simplifyEnumMessage(msg: string): string | null {
  const m = msg.match(/^(\w+) must be one of the following values:\s*(.+)$/i);
  if (!m) return null;
  const field = fieldOf(m[1]);
  const values = m[2].split(',').map((v) => v.trim()).filter(Boolean);
  const shown = values.slice(0, 4).join(', ');
  const more = values.length > 4 ? `, or ${values.length - 4} other options` : '';
  return `${field} must be one of: ${shown}${more}.`;
}

const BY_STATUS: Record<
  number,
  {
    message: string;
    category: ErrorCategory;
    translationCategory: ErrorTranslationCategory;
    title: string;
    action: string;
    requiresRefresh?: boolean;
  }
> = {
  400: {
    message: 'Some of the details entered are not valid. Please check the highlighted fields and try again.',
    category: 'user-correction-required',
    translationCategory: 'validation',
    title: 'Invalid Request',
    action: 'Check the form entries and correct invalid values.',
  },
  401: {
    message: 'Your session has expired. Please sign in again to continue.',
    category: 'permission-required',
    translationCategory: 'permission',
    title: 'Session Expired',
    action: 'Sign in again to continue working.',
  },
  403: {
    message: 'You do not have permission to perform this action. Ask an administrator if you require access.',
    category: 'permission-required',
    translationCategory: 'permission',
    title: 'Permission Denied',
    action: 'Contact an administrator if you need this role or authorization.',
  },
  404: {
    message: 'That record could not be found. It may have been removed or renamed.',
    category: 'non-retryable',
    translationCategory: 'not_found',
    title: 'Record Not Found',
    action: 'Verify the reference ID or navigate back to the main list.',
    requiresRefresh: true,
  },
  409: {
    message: 'This record was modified by another operator while you were working on it. Reload the latest version to review changes.',
    category: 'conflict',
    translationCategory: 'conflict',
    title: 'Data Conflict',
    action: 'Reload authoritative data from the server to reconcile differences before retrying.',
    requiresRefresh: true,
  },
  413: {
    message: 'The selected file exceeds the maximum allowed upload size. Please upload a smaller file.',
    category: 'user-correction-required',
    translationCategory: 'validation',
    title: 'File Too Large',
    action: 'Compress or select a file within the allowed size limit.',
  },
  422: {
    message: 'Some of the submitted values failed business validation. Please review the highlighted fields.',
    category: 'user-correction-required',
    translationCategory: 'validation',
    title: 'Validation Failed',
    action: 'Review and fix the flagged fields.',
  },
  429: {
    message: 'Too many requests in a short period. Please pause a moment before retrying.',
    category: 'retryable',
    translationCategory: 'rate_limit',
    title: 'Rate Limit Reached',
    action: 'Please wait a moment before trying again.',
  },
  500: {
    message: 'Something went wrong on the server. Your work has not been saved — please try again shortly.',
    category: 'system-failure',
    translationCategory: 'server_failure',
    title: 'Server Error',
    action: 'The server encountered an unexpected error. Please retry in a few moments.',
  },
  502: {
    message: 'The server is temporarily unreachable. Please try again shortly.',
    category: 'retryable',
    translationCategory: 'network_failure',
    title: 'Bad Gateway',
    action: 'The server gateway is restarting or unreachable. Retry shortly.',
  },
  503: {
    message: 'The service is temporarily unavailable, usually during maintenance. Please retry in a few moments.',
    category: 'retryable',
    translationCategory: 'server_failure',
    title: 'Service Unavailable',
    action: 'System maintenance may be underway. Please retry momentarily.',
  },
  504: {
    message: 'The request timed out while waiting for the server. Please check your connection and retry.',
    category: 'retryable',
    translationCategory: 'network_failure',
    title: 'Gateway Timeout',
    action: 'The request took too long. Check your network connection and retry.',
  },
};

/** Builds the error thrown by the API client for a failed HTTP response. */
export function fromResponse(status: number, body: any): AppError {
  const serverText = joinServerMessage(body?.message);
  const domainCode = extractDomainCode(serverText);

  let friendly = '';
  let category: ErrorCategory = status >= 500 ? 'system-failure' : 'user-correction-required';

  /**
   * The status decides the category; the message only decides the wording.
   *
   * These two were entangled: the `BY_STATUS` lookup lived inside `if (!friendly)`, so it was
   * consulted only when nothing else had produced a sentence. A 503 arriving with a human-readable
   * server message therefore kept the seeded `system-failure` and read as not worth retrying, while
   * the same 503 with an empty body picked up `retryable` from `BY_STATUS`. Whether a failure was
   * worth retrying depended on whether the backend had bothered to send prose, and a screen asking
   * `classifyError(...).isRetryable` offered or withheld its Retry button on that basis.
   */
  const statusEntry = BY_STATUS[status];
  if (statusEntry) {
    category = statusEntry.category;
  }

  // A domain code is more specific than the status, so it still wins both fields.
  if (domainCode && DOMAIN_ERROR_TRANSLATIONS[domainCode]) {
    friendly = DOMAIN_ERROR_TRANSLATIONS[domainCode].message;
    category = DOMAIN_ERROR_TRANSLATIONS[domainCode].category;
  } else if (isHumanReadable(serverText)) {
    friendly = sentence(serverText);
  }

  if (!friendly) {
    friendly = statusEntry ? statusEntry.message : 'Something went wrong. Please try again.';
  }

  return new AppError(friendly, serverText || `HTTP ${status}`, status, category, domainCode);
}

/** Builds the error for a fetch that never reached the server at all. */
export function fromNetwork(err: unknown): AppError {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  return new AppError(
    offline
      ? 'You appear to be offline. Please check your network connection — your work has not been lost.'
      : 'Could not reach the server. Please check your internet connection and try again.',
    err instanceof Error ? err.message : String(err),
    undefined,
    'retryable'
  );
}

/**
 * Translates any error into a canonical, structured error translation contract.
 */
export function translateError(err: unknown): ErrorTranslation {
  if (err instanceof AppError) {
    const domainDef = err.domainCode ? DOMAIN_ERROR_TRANSLATIONS[err.domainCode] : undefined;
    if (domainDef) {
      return {
        category: domainDef.translationCategory,
        title: domainDef.title,
        message: domainDef.message,
        action: domainDef.action,
        retryable: domainDef.translationCategory === 'rate_limit',
        requiresRefresh: domainDef.requiresRefresh ?? (domainDef.translationCategory === 'conflict'),
        statusCode: err.status,
        domainCode: err.domainCode,
        technical: err.technical,
      };
    }

    if (err.status && BY_STATUS[err.status]) {
      const entry = BY_STATUS[err.status];
      return {
        category: entry.translationCategory,
        title: entry.title,
        message: err.userMessage || entry.message,
        action: entry.action,
        retryable: entry.translationCategory === 'rate_limit' || entry.translationCategory === 'server_failure' || entry.translationCategory === 'network_failure',
        requiresRefresh: entry.requiresRefresh ?? (err.status === 409 || err.status === 404),
        statusCode: err.status,
        technical: err.technical,
      };
    }

    if (err.status === 409 || err.category === 'conflict') {
      return {
        category: 'conflict',
        title: 'Data Conflict',
        message: err.userMessage,
        action: 'Reload authoritative data from the server to reconcile differences before retrying.',
        retryable: false,
        requiresRefresh: true,
        statusCode: err.status,
        technical: err.technical,
      };
    }

    if (err.category === 'permission-required') {
      return {
        category: 'permission',
        title: 'Permission Denied',
        message: err.userMessage,
        action: 'Contact an administrator if you require authorization.',
        retryable: false,
        requiresRefresh: false,
        statusCode: err.status,
        technical: err.technical,
      };
    }

    if (err.status && err.status >= 500) {
      return {
        category: 'server_failure',
        title: 'Server Error',
        message: err.userMessage,
        action: 'The server encountered an error. Please try again shortly.',
        retryable: true,
        requiresRefresh: false,
        statusCode: err.status,
        technical: err.technical,
      };
    }

    if (err.category === 'retryable' || err.status === undefined) {
      return {
        category: 'network_failure',
        title: 'Connection Issue',
        message: err.userMessage,
        action: 'Check your internet connection and try again.',
        retryable: true,
        requiresRefresh: false,
        statusCode: err.status,
        technical: err.technical,
      };
    }

    return {
      category: 'validation',
      title: 'Action Failed',
      message: err.userMessage,
      action: 'Check your inputs and try again.',
      retryable: false,
      requiresRefresh: false,
      statusCode: err.status,
      technical: err.technical,
    };
  }

  if (err instanceof Error) {
    const isNetwork = /network|fetch|abort|failed to fetch/i.test(err.message);
    if (isNetwork) {
      return {
        category: 'network_failure',
        title: 'Network Issue',
        message: 'Could not connect to the service. Please check your network connection.',
        action: 'Verify your internet connection and try again.',
        retryable: true,
        requiresRefresh: false,
        technical: err.message,
      };
    }

    return {
      category: 'server_failure',
      title: 'Unexpected Error',
      message: sentence(err.message) || 'Something went wrong. Please try again.',
      action: 'Retry in a moment. If the issue persists, contact support.',
      retryable: true,
      requiresRefresh: false,
      technical: err.message,
    };
  }

  return {
    category: 'server_failure',
    title: 'Unexpected Error',
    message: 'An unknown problem occurred. Please try again.',
    action: 'Retry in a few moments.',
    retryable: true,
    requiresRefresh: false,
    technical: String(err),
  };
}

/**
 * Classifies any error into an actionable structure (backwards compatibility).
 */
export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof AppError) {
    return {
      userMessage: err.userMessage,
      category: err.category,
      isConflict: err.category === 'conflict' || err.status === 409,
      isRetryable: err.category === 'retryable',
      statusCode: err.status,
      domainCode: err.domainCode,
      technical: err.technical,
    };
  }

  const translation = translateError(err);
  return {
    userMessage: translation.message,
    category: translation.category === 'conflict' ? 'conflict' : translation.retryable ? 'retryable' : 'system-failure',
    isConflict: translation.category === 'conflict',
    isRetryable: translation.retryable,
    technical: translation.technical,
  };
}

/**
 * What any component should render. Accepts anything caught.
 */
export function userMessage(err: unknown): string {
  return translateError(err).message;
}

/**
 * Did a lookup fail because the identifier addresses nothing, rather than because the request
 * itself went wrong?
 *
 * Only ever ask this of a request whose ENTIRE input is an identifier in its path —
 * `GET /assayers/:id`, `GET /assayers/:id/dossier`. For those, two statuses mean the same thing:
 *
 * - **404** is the plain answer: the store was asked and holds no such row.
 * - **400** is the same answer arriving earlier. Every one of these routes is guarded by
 *   `ParseUUIDPipe`, which refuses a malformed id ("Validation failed (uuid is expected)")
 *   before the handler runs — so the id is not one the store could ever hold. Rendering that as
 *   a validation failure would be nonsense: there is no form and no field to correct.
 *
 * Everything else is a statement about the REQUEST, not about the record. A 401 is a session, a
 * 403 is a permission, a 500 is a server, a timeout is a network — and a screen that renders any
 * of those as "no such thing" tells the operator a record was deleted when it was not. That is a
 * worse bug than the perpetual spinner this replaces, so the list stays exactly two statuses long.
 *
 * A `400` on a request that also carries a BODY means something completely different (the body
 * is invalid), which is why this is not folded into `translateError`'s categories: the same
 * status is genuinely two different answers depending on what was sent.
 */
export function isAbsentById(err: unknown): boolean {
  const status = err instanceof AppError ? err.status : undefined;
  return status === 404 || status === 400;
}
