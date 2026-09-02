/**
 * Strip credentials out of log text before it leaves the machine.
 *
 * Only administrators can reach these logs, and an administrator can already read the platform's
 * configured secrets through the settings screen. So this is not a permission boundary — it is a
 * blast-radius one. Logs get copied: into a chat with a hosting provider, into a ticket, into a
 * message asking someone else what an error means. That is the entire reason this feature exists,
 * and it is exactly how a JWT or a database URL ends up somewhere nobody meant to put it.
 *
 * Deliberately conservative about what it calls a secret. Over-redaction destroys the thing being
 * debugged: a request id that looks vaguely like a token is worth more unredacted than a
 * hypothetical leak is worth preventing. Each pattern below matches a shape that is a credential
 * and essentially nothing else.
 */

/** What replaces a match. Keeps the surrounding text readable and says why the gap is there. */
const MASK = '[redacted]';

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
  /** Rebuilds the line with the secret replaced but its context intact. */
  readonly replace: (match: string, ...groups: string[]) => string;
}

const RULES: readonly Rule[] = [
  {
    // `Authorization: Bearer eyJ...` — the single most likely thing to be pasted by accident.
    name: 'bearer',
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
    replace: (_m, prefix) => `${prefix}${MASK}`,
  },
  {
    // A bare JWT anywhere: three base64url segments. The header segment of a JWT always starts
    // `eyJ` because it is `{"` base64-encoded, which is what makes this safe to match on.
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: () => MASK,
  },
  {
    // Credentials inside a connection string: postgres://user:secret@host, redis://, mongodb://,
    // amqp://. The password is between the first colon after the scheme and the @.
    name: 'connection-string',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(@)/gi,
    replace: (_m, prefix, at) => `${prefix}${MASK}${at}`,
  },
  {
    // `password=...`, `"secret": "..."`, `api_key: ...` — assignment of a secret-ish name, in
    // any of the punctuation styles that appear in logs (env dumps, JSON, query strings).
    //
    // The leading `[A-Za-z0-9_]*` is load-bearing. Underscore is a word character, so `\b` never
    // matches inside `DB_PASSWORD` — anchoring on the bare keyword silently missed every
    // prefixed env var, which is the exact form these appear in when a process dumps its
    // environment. That is the single most likely way a password reaches this log viewer.
    name: 'named-secret',
    pattern:
      /\b([A-Za-z0-9_]*(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret|encryption[_-]?key)"?\s*[:=]\s*"?)([^\s",;&}]{4,})/gi,
    replace: (_m, prefix) => `${prefix}${MASK}`,
  },
  {
    // AWS access key ids have a fixed, unmistakable shape.
    name: 'aws-access-key-id',
    pattern: /\b((?:AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16})\b/g,
    replace: () => MASK,
  },
  {
    // A PEM block's body. The BEGIN line is left in place so the reader can see that a key was
    // logged at all — which is itself worth knowing — without the key.
    name: 'pem-private-key',
    pattern: /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g,
    replace: (_m, begin, end) => `${begin}${MASK}${end}`,
  },
];

/**
 * Redact one line. Applied per line rather than per response so that a pathological regex can
 * only ever chew on one line's worth of text.
 */
export function redactLogLine(text: string): string {
  let out = text;
  for (const rule of RULES) {
    // `replace` with a function: the callback receives (match, ...groups), which is exactly the
    // shape each rule declares.
    out = out.replace(rule.pattern, rule.replace as (substring: string, ...args: unknown[]) => string);
  }
  return out;
}

/** Exposed for the test, so a new rule cannot be added without one. */
export const REDACTION_RULE_NAMES: readonly string[] = RULES.map((r) => r.name);
