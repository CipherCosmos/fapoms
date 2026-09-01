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
