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

export const pool = new pg.Pool({
  host: env.DB_HOST ?? '127.0.0.1',
  port: +(env.DB_PORT ?? 5432),
  user: env.DB_USERNAME ?? 'fapoms',
  password: env.DB_PASSWORD ?? 'fapoms_dev',
  database: env.DB_DATABASE ?? 'fapoms',
});
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
 * Sign in, clearing a forced password change if one is pending.
 *
 * The gate is enforced on EVERY request, not only at login: `/auth/login` answers 200 with
 * `mustChangePassword: true` and the next call 403s. A helper that only handles the login-time
 * refusal sails past this and then reads every later 403 as a permission failure.
 */
export async function login(username, password = CERT_PASSWORD) {
  const attempt = (pw) => req('/auth/login', { method: 'POST', body: { username, password: pw } });
  let r = await attempt(password);
  let tok = r.body?.data?.accessToken ?? r.body?.accessToken;
  if (!tok) throw new Error(`login ${username}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);

  if (r.body?.data?.user?.mustChangePassword) {
    // Rotate away and back, so the account always ends on CERT_PASSWORD and this is re-runnable.
    const away = await req('/users/me/change-password', {
      method: 'POST', token: tok, body: { currentPassword: password, newPassword: HANDOVER },
    });
    if (away.status >= 400) throw new Error(`rotate ${username}: ${away.status}`);
    const r2 = await attempt(HANDOVER);
    await req('/users/me/change-password', {
      method: 'POST', token: r2.body?.data?.accessToken,
      body: { currentPassword: HANDOVER, newPassword: CERT_PASSWORD },
    });
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
