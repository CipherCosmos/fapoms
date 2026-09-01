import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * The security controls that must not disappear again.
 *
 * On 2026-08-20, `83925654` shipped a hardening batch. The same day, `7c9ee664` — a roles-rename
 * cleanup, 39 files and 720 deletions — was merged from a branch forked before it and took most of
 * the batch back out. Seven controls vanished, including refresh-token reuse detection, leaving a
 * stolen refresh token replayable indefinitely. Nobody noticed for twelve days.
 *
 * CI did not catch it, and CI was not broken: **each control's own unit test was deleted in the
 * same commit as the control**. A green build was the correct answer to the question being asked.
 * So the safeguard cannot be "the control has a test" — it has to be a check that a commit
 * removing a control cannot satisfy by also removing the check.
 *
 * Hence this file. It lives outside every module it protects, is named after none of them, and
 * asserts only that a marker string still exists in a file. Deleting a control now fails HERE, in
 * a file the deleting commit has no reason to touch. Removing an entry is still possible — but it
 * means editing this registry and writing over a `why`, which is a deliberate act that shows up in
 * review, rather than a silent side effect of a merge.
 *
 * This is a tripwire, not a test: it proves a control is still WIRED, never that it still WORKS.
 * The behavioural tests remain the place for that. If you are here because this spec failed, the
 * question to answer is "was this removal intended?" — and if it was, say so in the commit message.
 */
describe('security controls are still wired', () => {
  const BACKEND = __dirname;
  const REPO = join(__dirname, '..', '..', '..');

  interface Control {
    /** Stable id, quoted in failure output. */
    id: string;
    /** Path relative to the repository root. */
    file: string;
    /** A string that exists only while the control does. */
    marker: string;
    /** Why this matters — printed on failure, so the next reader gets the reasoning, not a diff. */
    why: string;
  }

  const B = 'packages/backend/src';

  const CONTROLS: Control[] = [
    {
      id: 'assayer-password-hash-not-selected',
      file: `${B}/modules/assayer/assayer.entity.ts`,
      marker: 'select: false',
      why: 'The bcrypt hash must not load by default. Without this it rides along on every entity '
        + 'read and lands in the Redis-cached principal.',
    },
    {
      id: 'roles-guard-denies-by-default',
      file: `${B}/modules/auth/guards.ts`,
      marker: 'AnyAuthenticated',
      why: 'RolesGuard is deny-by-default and @AnyAuthenticated() is the explicit opt-out. If the '
        + 'opt-out marker is gone, check the default did not invert with it.',
    },
    {
      id: 'production-config-assertions',
      file: `${B}/main.ts`,
      marker: 'assertProductionSafeConfig',
      why: 'The boot-time refusal to start on unsafe production config (JWT_SECRET, DB_SYNCHRONIZE, '
        + 'CORS_ORIGINS, DB_PASSWORD). Removing it turns a loud startup failure into a silent '
        + 'insecure deployment.',
    },
    {
      id: 'field-encryption-transformer',
      file: `${B}/infrastructure/security/field-encryption.ts`,
      marker: 'enc:v1:',
      why: 'The at-rest encryption envelope for PAN, Aadhaar and bank account. The version prefix '
        + 'is also what makes key rotation and per-principal crypto-shredding possible later.',
    },
    {
      id: 'assayer-pii-columns-encrypted',
      file: `${B}/modules/assayer/assayer.entity.ts`,
      marker: 'transformer: encryptedColumn',
      why: 'PAN, Aadhaar and bank account are encrypted at rest through the column transformer. '
        + 'Dropping the transformer silently writes plaintext — reads keep working either way, so '
        + 'nothing else would surface it.',
    },
    {
      id: 'assayer-field-redaction-interceptor',
      file: `${B}/infrastructure/http/assayer-redaction.interceptor.ts`,
      marker: 'redactAssayersDeep',
      why: 'PAN and bank account decrypt on entity load, so ANY join that reaches an assayer '
        + 'returns them. This interceptor walks the whole response graph and re-applies the field '
        + 'policy. Without it the front door is locked and a dozen side windows are open.',
    },
    {
      id: 'assayer-visibility-policy',
      file: `${B}/modules/assayer/assayer-visibility.ts`,
      marker: 'IDENTITY_FIELDS',
      why: 'The single field-level visibility policy. Masking, the redaction interceptor and any '
        + 'read-access logging all derive their categories from it.',
    },
    {
      id: 'document-access-token-hmac',
      file: `${B}/modules/document/document-access-token.service.ts`,
      marker: 'timingSafeEqual',
      why: 'Download links are HMAC-signed and short-lived rather than guessable object keys, and '
        + 'the comparison is constant-time so the signature cannot be recovered a byte at a time.',
    },
    {
      id: 'audit-repository-is-append-only',
      file: `${B}/core/audit/audit.repository.ts`,
      marker: 'append',
      why: 'The audit port exposes append and finders only, so no call site can express an update '
        + 'or a delete. Append-only is a property of the type here, not a convention.',
    },
    {
      id: 'audit-tables-never-wiped',
      file: `${B}/infrastructure/data-reset/wipe-domains.registry.ts`,
      marker: 'NEVER_WIPEABLE_TABLES',
      why: 'The danger-zone reset must never be able to erase audit_events, workflow_history or '
        + 'outbox_events — the evidence trail for a system whose product is audit evidence.',
    },
    {
      id: 'global-scope-is-server-side',
      file: `${B}/infrastructure/scope/global-scope.ts`,
      marker: 'GlobalScopeFilter',
      why: 'Region scoping is resolved from the authenticated principal, never from a query '
        + 'string. A query string is not a trust boundary.',
    },
    {
      id: 'login-is-throttled',
      file: `${B}/modules/auth/auth.controller.ts`,
      marker: '@Throttle',
      why: 'Per-IP brake on credential stuffing. Per-account lockout cannot see an attack spread '
        + 'across many usernames; this is the half that can.',
    },
    {
      id: 'account-lockout-on-failed-logins',
      file: `${B}/modules/auth/auth.service.ts`,
      marker: 'failedLoginAttempts',
      why: 'Brute-force lockout. Especially load-bearing while temporary passwords are low-entropy.',
    },
    {
      id: 'error-alerts-carry-no-payload',
      file: `${B}/infrastructure/observability/error-alerter.ts`,
      marker: 'alertKey',
      why: 'The outbound webhook is a third party over the public internet. Error MESSAGES on this '
        + 'system routinely contain the data that caused them — a failing query includes its bound '
        + 'values, and those values are bank customer records.',
    },
    {
      id: 'document-download-content-disposition-sanitised',
      file: `${B}/modules/document/document.controller.ts`,
      marker: `filename*=UTF-8`,
      why: 'doc.fileName is stored from client-supplied input on the JSON upload routes. Without '
        + 'stripping CR/LF/quote and adding the RFC 5987 filename* form, a crafted filename corrupts '
        + 'or splits the Content-Disposition response header (HTTP response splitting).',
    },
    {
      id: 'report-sync-exports-throttled',
      file: `${B}/modules/reports/reports.controller.ts`,
      marker: 'Synchronous xlsx.write blocks the event loop with no yield',
      why: 'The five synchronous GET export routes (coverage, assignments, billing, command-center, '
        + 'assayer-roster) call xlsx.write with no yield point — an unthrottled CPU-bound DoS surface. '
        + 'Their queued POST twins are already throttled; these must carry the same @Throttle.',
    },
    {
      id: 'assayer-profile-read-is-self-or-privileged',
      file: `${B}/modules/assayer/assayer.controller.ts`,
      marker: 'view this profile',
      why: '`GET :assayerId/profile` computed isSelf but used it only to decide REDACTION, never to '
        + 'refuse — any assayer could pull any colleague\'s full profile by id. assertSelfOrPrivileged '
        + 'must run before the record is fetched; staff (ADMIN/OPERATIONS) are unaffected.',
    },
    {
      id: 'feedback-socket-room-entitlement',
      file: `${B}/modules/realtime/events.gateway.ts`,
      marker: 'this.regionGuard.feedbackVerdict(client.user!, threadId)',
      why: 'subscribe:feedback was a bare join with no check — any authenticated socket, an assayer '
        + 'included, could subscribe to any feedback thread by guessing its UUID and receive internal '
        + 'team messages. Must go through joinIfEntitled like assignment: and query: rooms.',
    },
    {
      id: 'socket-subscribe-rate-budget',
      file: `${B}/modules/realtime/events.gateway.ts`,
      marker: 'allowSubscribeAttempt',
      why: 'Each subscribe attempt can run an uncached DB verdict (a not-found result is deliberately '
        + 'not cached). Without a per-socket budget a client spraying random UUIDs issues an unbounded '
        + 'stream of queries.',
    },
    {
      id: 'expense-approval-blocks-self-dealing',
      file: `${B}/modules/expense/expense.service.ts`,
      marker: 'You cannot approve an expense claim you raised',
      why: 'Approving an expense books a payable — money out. The claim\'s raiser must not be able to '
        + 'approve their own entry; only rejecting your own claim is harmless and stays allowed.',
    },
    {
      id: 'feedback-file-and-reply-throttled',
      file: `${B}/modules/feedback/feedback.controller.ts`,
      marker: '@Throttle',
      why: 'Filing and replying each fan out a realtime notification to the whole feedback team. '
        + 'Without a per-route ceiling above real human usage, one account can flood the team\'s '
        + 'inbox and the notification pipeline.',
    },
    {
      id: 'forced-password-change-enforced-server-side',
      file: `${B}/modules/auth/guards.ts`,
      marker: 'PASSWORD_CHANGE_EXEMPT_KEY',
      why: '`mustChangePassword` used to be returned to the client and acted on only by the web '
        + 'UI, so a curl script or a stale tab could use a seeded/admin-set password normally. '
        + 'JwtAuthGuard now refuses every route except change-password, read-own-profile and '
        + 'logout until the flag clears. Scoped to principals carrying the flag — the assayer '
        + 'mobile principal never does, so the field app is unaffected.',
    },
    {
      id: 'login-timing-oracle-equalised',
      file: `${B}/modules/auth/auth.service.ts`,
      marker: 'DUMMY_BCRYPT_HASH',
      why: 'An unknown identifier used to return instantly while a known one paid a full bcrypt '
        + 'compare — a timing oracle for which usernames/assayer codes exist. The not-found path '
        + 'now spends the same work against a fixed dummy hash.',
    },
    {
      id: 'refresh-token-reuse-detection',
      file: `${B}/modules/auth/auth.service.ts`,
      marker: 'handleRefreshTokenReuse',
      why: 'A replayed, already-rotated refresh token used to just fail to match — reuse (the '
        + 'signature of a stolen token) was indistinguishable from a random bad token. It is now '
        + 'caught and treated as theft: the whole token family is revoked and an audit event is '
        + 'raised, with a short grace window so an ordinary two-tab refresh race is not punished.',
    },
    {
      id: 'refresh-token-replaced-by-stores-row-not-secret',
      file: `${B}/modules/auth/auth.service.ts`,
      marker: 'generateTokenPairWithRow',
      why: 'Rotation used to write the NEW, still-valid refresh token in cleartext into the '
        + 'predecessor row\'s `replaced_by`. Anyone who could read the table (a backup, a read '
        + 'replica, a support export) could lift it and redeem a full session with no password. '
        + '`replaced_by` now stores the successor ROW id; the secret exists only as its hash.',
    },
    {
      id: 'password-change-revokes-all-sessions',
      file: `${B}/modules/auth/auth.service.ts`,
      marker: 'revokeAllSessions',
      why: 'A password change or admin reset used to only rewrite the hash — it never ended '
        + 'existing sessions, so a stolen or lingering refresh token kept rotating into fresh '
        + 'access tokens for the full refresh TTL. Both staff paths now revoke every refresh '
        + 'token and drop the cached principal on a `user:password-changed` event.',
    },
    {
      id: 'password-change-invalidates-principal-cache-synchronously',
      file: `${B}/modules/user/user.service.ts`,
      marker: 'rbacPrincipalCacheKey',
      why: 'The RBAC principal cache (~30s TTL) is what the forced-password-change guard reads. '
        + 'The domain-event invalidation is fire-and-forget and not guaranteed to finish before '
        + 'the HTTP response returns, so both password-change paths also await a direct cache '
        + 'drop — without it, a user who just changed their password could stay wrongly 403\'d '
        + 'by their own stale cached principal for up to the TTL.',
    },
    {
      id: 'user-password-hash-not-selected',
      file: `${B}/modules/user/user.entity.ts`,
      marker: 'select: false',
      why: 'The bcrypt hash must not load by default. Without this it rides along on every '
        + 'entity read and lands in the Redis-cached principal — the same exposure already '
        + 'closed on assayers.',
    },
    {
      id: 'pii-encryption-key-production-check',
      file: `${B}/main.ts`,
      marker: 'PII_ENCRYPTION_KEY',
      why: 'The field-encryption layer degrades to plaintext passthrough when this key is unset. '
        + 'A production boot without it would silently store PAN, bank account and government-ID '
        + 'numbers as cleartext, with no failure signal until someone reads the table.',
    },
  ];

  it('has no duplicate ids', () => {
    const ids = CONTROLS.map((c) => c.id);
    expect(ids).toHaveLength(new Set(ids).size);
  });

  it('names only files that exist — a moved file is a review question, not a silent pass', () => {
    const missing = CONTROLS.filter((c) => !existsSync(join(REPO, c.file)))
      .map((c) => `${c.id} → ${c.file}`);
    expect(missing).toEqual([]);
  });

  it.each(CONTROLS.map((c) => [c.id, c] as const))('%s', (_id, control) => {
    const full = join(REPO, control.file);
    const source = readFileSync(full, 'utf8');

    if (!source.includes(control.marker)) {
      throw new Error(
        `Security control "${control.id}" is no longer present.\n\n`
          + `  file:   ${control.file}\n`
          + `  marker: ${control.marker}\n\n`
          + `WHY IT EXISTS: ${control.why}\n\n`
          + 'If you removed this deliberately, delete its entry from '
          + 'packages/backend/src/security-controls.spec.ts in the SAME commit and say why in the '
          + 'commit message. If you did not, you have hit the failure mode this file exists for: '
          + 'commit 7c9ee664 removed seven controls and their tests together, and CI stayed green '
          + 'for twelve days. See docs/SECURITY-CONTROLS.md.',
      );
    }
  });

  it('keeps the backend source root where this spec expects it', () => {
    // Cheap guard: if the layout moves, every path above turns into a false pass on the
    // existence check rather than a real assertion.
    expect(existsSync(join(BACKEND, 'main.ts'))).toBe(true);
  });
});
