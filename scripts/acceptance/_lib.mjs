/**
 * Shared helpers for the acceptance probes.
 *
 * Every script under this directory needs the same five things: a session that survives the
 * forced password rotation, an HTTP helper that does not lie about throttling, a database
 * connection, a way to get an unconsumed branch, and a tally. They were being reimplemented per
 * script, which is how three of them ended up with the same 429 bug.
 *
 * Configuration comes from the environment; `AC_ENV_FILE` may point at a file of `KEY=value`
 * lines (the acceptance rig writes one) and anything already in `process.env` wins over it.
 *
 * ── READ-ONLY BY DEFAULT ──────────────────────────────────────────────────────────────────────
 *
 * A certification tool is pointed at deployments somebody is deciding whether to TRUST. It must
 * therefore be safe to point at one before you have read it, and that means writing nothing until
 * told to. Until this file was changed it did the opposite: `login()` rotated an account's
 * password away to a handover value and back whenever `mustChangePassword` was set, announcing
 * nothing. On the rig that is convenient and re-runnable. On a real deployment it is an
 * unannounced write to a live credential, and a failed rotate-back leg locks somebody out.
 *
 * It had already cost this campaign real time: a password reset made for the product owner was
 * silently undone by the next probe run, twice, and nobody could see why (campaign defect T-03).
 *
 * So there are now two gates, deliberately separate, because "insert a fixture branch" and
 * "change the password of a real account" are not the same risk and must not share a switch:
 *
 *   AC_ALLOW_WRITES=1              general mutation — fixture rows, business records, SQL writes.
 *                                  (`AC_ALLOW_MUTATIONS=1` is accepted as a synonym.)
 *   AC_ALLOW_PASSWORD_ROTATION=1   changing ANY account's password. Implied by nothing.
 *
 * Both are off unless set. Both announce themselves on stdout when they are used — the banner
 * names the target and every category of write before the first one happens, so "I did not know
 * it would do that" stops being available to anybody who ran it.
 *
 * `sql()` enforces the first gate itself: any statement whose verb writes is refused unless the
 * gate is open, so a probe cannot mutate the database through this helper by accident. `login()`
 * enforces the second: with rotation not permitted it reports `mustChangePassword` as a finding
 * and hands back the session it did get, instead of quietly rewriting the credential.
 */
import pg from 'pg';
import fs from 'node:fs';

const fromFile = (() => {
  const p = process.env.AC_ENV_FILE;
  if (!p || !fs.existsSync(p)) return {};
  return Object.fromEntries(
    fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }),
  );
})();

export const env = { ...fromFile, ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) };
export const API = env.AC_API ?? 'http://127.0.0.1:8080/api/v1';
export const CERT_PASSWORD = env.CERT_PASSWORD ?? 'Cert!Walk2026x19961';
const HANDOVER = 'Handover!Temp2026x7';

// ── the safety gates ───────────────────────────────────────────────────────────────────────────

const truthy = (v) => v === '1' || v === 'true' || v === 'yes' || v === 'YES' || v === 'TRUE';

/** General mutation: fixture rows, business records, SQL writes. */
export const ALLOW_WRITES = truthy(env.AC_ALLOW_WRITES) || truthy(env.AC_ALLOW_MUTATIONS);
/** Changing any account's password. Separate on purpose — nothing else implies it. */
export const ALLOW_PASSWORD_ROTATION = truthy(env.AC_ALLOW_PASSWORD_ROTATION);

/** A target that is not loopback is somebody's deployment until proven otherwise. */
export const TARGET_IS_LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(API);

let announcedMutating = false;

/**
 * Announce, once, that this run will write — and refuse to run if it was not authorised.
 *
 * `writes` is a list of the CATEGORIES of write this script performs, in plain words. It is not
 * decoration: it is the only thing an operator reads before deciding to type the flag, so it has
 * to be specific enough to act on ("creates fixture branches and walks lifecycle_status on a
 * throwaway assayer"), never "modifies some data".
 */
export function declareMutating(script, writes) {
  if (announcedMutating) return;
  announcedMutating = true;
  const bar = '─'.repeat(94);
  if (!ALLOW_WRITES) {
    console.error(`\n${bar}`);
    console.error(`  REFUSED — "${script}" is a MUTATING probe and writes are not enabled.`);
    console.error(`  target : ${API}${TARGET_IS_LOCAL ? '' : '   ← NOT loopback. This is somebody\'s deployment.'}`);
    console.error('  it would:');
    for (const w of writes) console.error(w.startsWith('  ') ? `       ${w.trim()}` : `     · ${w}`);
    console.error('');
    console.error('  Certification tooling is read-only by default so that it is safe to point at a');
    console.error('  deployment before you have read it. Re-run with AC_ALLOW_WRITES=1 if every line');
    console.error('  above is acceptable on THIS target.');
    console.error(`${bar}\n`);
    process.exit(2);
  }
  console.log(`\n${bar}`);
  console.log(`  MUTATING RUN — "${script}" will write to the target. AC_ALLOW_WRITES=1 is set.`);
  console.log(`  target : ${API}`);
  if (!TARGET_IS_LOCAL) console.log('  WARNING: this target is NOT loopback. You are writing to a deployment.');
  console.log('  writes :');
  for (const w of writes) console.log(w.startsWith('  ') ? `       ${w.trim()}` : `     · ${w}`);
  console.log(`  password rotation: ${ALLOW_PASSWORD_ROTATION ? 'ENABLED (AC_ALLOW_PASSWORD_ROTATION=1)' : 'disabled'}`);
  console.log(`${bar}\n`);
}

/** Refuse a write the run was not authorised to make. Names what it was about to do. */
export function assertWritesAllowed(what) {
  if (ALLOW_WRITES) return;
  throw new Error(
    `REFUSED: this run is read-only and tried to ${what}.\n`
    + `  target: ${API}\n`
    + '  Certification tooling writes nothing unless told to. Set AC_ALLOW_WRITES=1 to permit it,\n'
    + '  and only on a target where that write is acceptable.',
  );
}

/**
 * Refuse a password change the run was not authorised to make, and say whose it is when it is.
 *
 * The announcement is not optional and not conditional on success: whoever reads the log has to
 * be able to see, afterwards, exactly which credential this tool touched.
 */
export function assertPasswordRotationAllowed(username, why) {
  if (!ALLOW_PASSWORD_ROTATION) {
    throw new Error(
      `REFUSED: this run tried to change the password of "${username}" (${why}).\n`
      + `  target: ${API}\n`
      + '  A probe must never silently rotate a real credential — a failed rotate-back leg locks\n'
      + '  somebody out, and a manual reset made by an administrator does not survive it.\n'
      + '  Set AC_ALLOW_PASSWORD_ROTATION=1 to permit it, on a rig where that is acceptable.',
    );
  }
  console.log(`  ROTATING PASSWORD of "${username}" — ${why} (AC_ALLOW_PASSWORD_ROTATION=1)`);
}

/**
 * The non-throwing form, for a probe that can report the check as not-run instead of dying.
 *
 * Returns true only when rotation is permitted, and announces either way — a skipped credential
 * write has to be as visible as a performed one, or a read-only run reads as a clean run.
 */
export function canRotatePassword(username, why) {
  if (ALLOW_PASSWORD_ROTATION) {
    console.log(`  ROTATING PASSWORD of "${username}" — ${why} (AC_ALLOW_PASSWORD_ROTATION=1)`);
    return true;
  }
  console.log(`  NOT rotating the password of "${username}" (${why}) — AC_ALLOW_PASSWORD_ROTATION is unset.`);
  return false;
}

export const pool = new pg.Pool({
  host: env.DB_HOST ?? '127.0.0.1',
  port: +(env.DB_PORT ?? 5432),
  user: env.DB_USERNAME ?? 'fapoms',
  password: env.DB_PASSWORD ?? 'fapoms_dev',
  database: env.DB_DATABASE ?? 'fapoms',
});

/**
 * Does this statement write?
 *
 * Leading verb, plus two cases a leading-verb test alone would wave through: a data-modifying CTE
 * (`WITH x AS (UPDATE …)`), and the handful of `SELECT fn()` calls whose whole purpose is a side
 * effect — `pg_stat_statements_reset()` in particular, which silently discards whatever a real
 * deployment's monitoring had accumulated.
 */
const WRITE_VERB = /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*(insert|update|delete|truncate|drop|alter|create|grant|revoke|comment|reindex|vacuum|refresh|call|do|lock|copy|set\s+role|security\s+label)\b/i;
const WRITE_CTE = /^\s*with\b[\s\S]*\b(?:insert\s+into|update\s+\S+\s+set|delete\s+from)\b/i;
const SIDE_EFFECT_FN = /\b(pg_stat_statements_reset|pg_stat_reset\w*|pg_terminate_backend|pg_cancel_backend|pg_switch_wal|pg_create_\w*slot|pg_drop_replication_slot|setval|nextval)\s*\(/i;
/** `EXPLAIN ANALYZE INSERT …` really runs the insert. `EXPLAIN` on its own does not. */
const EXPLAIN_ANALYZE_WRITE = /^\s*explain\b[\s\S]*\banalyze\b[\s\S]*?\b(insert\s+into|update\s+\S+\s+set|delete\s+from|create|drop|alter)\b/i;

export const statementWrites = (q) => {
  const s = String(q);
  return WRITE_VERB.test(s) || WRITE_CTE.test(s) || SIDE_EFFECT_FN.test(s) || EXPLAIN_ANALYZE_WRITE.test(s);
};

/**
 * The gate goes on `pool.query`, not only on `sql()`.
 *
 * Several probes reach past the helper and call `pool.query(CLEANUP)` directly for multi-statement
 * teardown. A gate that only wrapped `sql()` would wave those through, which is precisely the
 * class of bypass this change exists to remove.
 */
const rawQuery = pool.query.bind(pool);
pool.query = (q, ...rest) => {
  const text = typeof q === 'string' ? q : q?.text ?? '';
  if (statementWrites(text)) {
    assertWritesAllowed(`run a writing SQL statement: ${String(text).replace(/\s+/g, ' ').trim().slice(0, 120)}`);
  }
  return rawQuery(q, ...rest);
};

export const sql = (q, p) => pool.query(q, p).then((r) => r.rows);
export const one = async (q, p) => (await sql(q, p))[0] ?? null;

/**
 * A 429 is retried, but only for a bounded time, and the bound respects the window.
 *
 * `POST /auth/login` is capped at 20/min/IP and answers `Retry-After: 20-26s`, so a helper that
 * slept 2.5s and recursed forever never converged — it hammered a closed window in silence. Two
 * certification runs sat for 313s and 371s with nothing on screen and one had to be killed, which
 * is indistinguishable from a broken product. On reaching the budget this returns the 429 as
 * itself, so a caller can report "throttled, UNKNOWN" rather than mistake it for a denial.
 */
export async function req(path, { method = 'GET', token, body, budgetMs = 90_000 } = {}) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const r = await fetch(API + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429 && Date.now() < deadline) {
      const after = Number(r.headers.get('retry-after'));
      const waitMs = Number.isFinite(after) && after > 0 ? Math.min(after * 1000 + 500, 30_000) : 2_500;
      if (Date.now() + waitMs >= deadline) {
        let j = null; try { j = await r.json(); } catch {}
        return { status: 429, body: j, msg: `throttled for the whole ${budgetMs}ms budget — treat as UNKNOWN, not a denial` };
      }
      await new Promise((s) => setTimeout(s, waitMs));
      continue;
    }
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j, msg: j?.message ?? j?.error ?? null };
  }
}

/**
 * Sign in. Clearing a forced password change is OPT-IN and announced — see the header.
 *
 * The gate is enforced on EVERY request, not only at login: `/auth/login` answers 200 with
 * `mustChangePassword: true` and the next call 403s. A helper that only handles the login-time
 * refusal sails past this and then reads every later 403 as a permission failure.
 *
 * With `AC_ALLOW_PASSWORD_ROTATION=1` this clears the flag by rotating away to a handover value
 * and back to `CERT_PASSWORD`, which is what makes a rig run re-runnable, and says so on stdout.
 * Without it, the session is returned as-is carrying `mustChangePassword: true` so the caller can
 * report the forced rotation as the finding it is — the credential is not touched.
 */
export async function login(username, password = CERT_PASSWORD) {
  const attempt = (pw) => req('/auth/login', { method: 'POST', body: { username, password: pw } });
  let r = await attempt(password);
  let tok = r.body?.data?.accessToken ?? r.body?.accessToken;
  if (!tok) throw new Error(`login ${username}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);

  if (r.body?.data?.user?.mustChangePassword) {
    if (!ALLOW_PASSWORD_ROTATION) {
      // Deliberately NOT rotating. Hand the caller the session and the fact.
      console.log(`  NOTE: "${username}" has mustChangePassword set. Not rotating it — this run is`);
      console.log('        read-only for credentials. Set AC_ALLOW_PASSWORD_ROTATION=1 to clear it.');
      return { token: tok, user: r.body?.data?.user ?? null, mustChangePassword: true };
    }
    assertPasswordRotationAllowed(username, 'mustChangePassword is set and the probe needs a usable session');
    // Rotate away and back, so the account always ends on CERT_PASSWORD and this is re-runnable.
    const away = await req('/users/me/change-password', {
      method: 'POST', token: tok, body: { currentPassword: password, newPassword: HANDOVER },
    });
    if (away.status >= 400) throw new Error(`rotate ${username}: ${away.status}`);
    const r2 = await attempt(HANDOVER);
    const back = await req('/users/me/change-password', {
      method: 'POST', token: r2.body?.data?.accessToken,
      body: { currentPassword: HANDOVER, newPassword: CERT_PASSWORD },
    });
    if (back.status >= 400) {
      // The leg that locks somebody out. Say it loudly and in terms of what to do about it.
      throw new Error(
        `ROTATE-BACK FAILED for "${username}": ${back.status}. The account is left on the handover\n`
        + `  password "${HANDOVER}". Sign in with that and change it, or reset it through the product.`,
      );
    }
    r = await attempt(CERT_PASSWORD);
    tok = r.body?.data?.accessToken;
  }
  if (!tok) throw new Error(`login ${username} produced no usable token`);
  return { token: tok, user: r.body?.data?.user ?? null };
}

export function tally() {
  const state = { pass: 0, fail: 0, notes: [] };
  const check = (name, ok, detail) => {
    ok ? state.pass++ : state.fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
    if (!ok) state.notes.push(`${name} — ${detail ?? ''}`);
  };
  const done = async () => {
    console.log(`\n${state.pass}/${state.pass + state.fail} checks passed`);
    if (state.notes.length) { console.log('\nFailures:'); state.notes.forEach((n) => console.log('  - ' + n)); }
    await pool.end();
    process.exit(state.fail ? 1 : 0);
  };
  return { check, done, state };
}

/**
 * An unconsumed branch, cloned from a real one.
 *
 * A completed audit closes its branch to further assignments — twice over, by the branch status
 * and by the branch already holding a completed assignment — so a script that reuses the fixture
 * runs exactly once. `gen_random_uuid()` and not an md5-derived id: a UUID derived from md5 can
 * land on a version nibble outside 1-5, which `@IsUUID()` rejects outright.
 */
export async function freshBranch(tag, sourceBranchName = 'Pune Main Branch') {
  assertWritesAllowed('create a fixture branch and project_branch row');
  const name = `${tag} ${Date.now()}`;
  await sql(
    `INSERT INTO branches (id, version, sol_id, name, address, state, district, city, pincode, region,
       latitude, longitude, is_active, organization_id, client_id, created_at, updated_at, created_by, updated_by)
     SELECT gen_random_uuid(), 1, $1, $2, b.address, b.state, b.district, b.city, b.pincode, b.region,
            b.latitude, b.longitude, true, b.organization_id, b.client_id, now(), now(), 'acceptance', 'acceptance'
       FROM branches b WHERE b.name = $3 LIMIT 1`, [`SOL-${Date.now()}`, name, sourceBranchName]);
  await sql(
    `INSERT INTO project_branches (id, version, project_id, branch_id, status, is_active, created_at, updated_at, created_by, updated_by)
     SELECT gen_random_uuid(), 1, p.id, b.id, 'PLANNING', true, now(), now(), 'acceptance', 'acceptance'
       FROM projects p, branches b WHERE b.name = $1 LIMIT 1`, [name]);
  const row = await one(
    `SELECT pb.id AS "pbId", pb.branch_id AS "branchId", p.client_id AS "clientId", b.state, b.region
       FROM project_branches pb JOIN projects p ON p.id = pb.project_id JOIN branches b ON b.id = pb.branch_id
      WHERE b.name = $1 LIMIT 1`, [name]);
  if (!row) throw new Error('could not provision a branch');
  return { ...row, name };
}
