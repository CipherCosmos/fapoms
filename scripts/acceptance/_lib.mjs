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
 *
 * ── THE MEASURER'S OWN SLEEP IS NOT LATENCY ───────────────────────────────────────────────────
 *
 * Because the wait happens inside this function, a caller timing `await req(...)` with a clock on
 * the outside measures **wait + request** and reports it as one number. That is how a certification
 * run came to report a "60.4 second login" against a 2.4 s threshold. Twelve controlled logins
 * against the same rig measured 0.199 – 0.323 s; the 60.4 s was twenty-odd seconds of honouring
 * `Retry-After`, twice, with a fast 200 on the end. A performance number that includes the
 * measurer's own sleep is worse than no number, because somebody acts on it.
 *
 * So every result now carries the split, and callers are expected to use it:
 *
 *   requestMs  time on the wire for the attempt that ANSWERED. This is the latency.
 *   waitedMs   time this helper spent deliberately asleep honouring Retry-After. Not latency.
 *   attempts   how many times the request was made. > 1 means the sample was taken under
 *              contention, which is worth knowing even though requestMs is clean.
 */
export async function req(path, { method = 'GET', token, body, budgetMs = 90_000, api = API } = {}) {
  const deadline = Date.now() + budgetMs;
  let waitedMs = 0;
  let attempts = 0;
  for (;;) {
    attempts++;
    const sent = Date.now();
    const r = await fetch(api + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const requestMs = Date.now() - sent;
    if (r.status === 429 && Date.now() < deadline) {
      const after = Number(r.headers.get('retry-after'));
      const waitMs = Number.isFinite(after) && after > 0 ? Math.min(after * 1000 + 500, 30_000) : 2_500;
      if (Date.now() + waitMs >= deadline) {
        let j = null; try { j = await r.json(); } catch {}
        return {
          status: 429, body: j, requestMs, waitedMs, attempts,
          msg: `throttled for the whole ${budgetMs}ms budget — treat as UNKNOWN, not a denial`,
        };
      }
      await new Promise((s) => setTimeout(s, waitMs));
      waitedMs += waitMs;
      continue;
    }
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j, msg: j?.message ?? j?.error ?? null, requestMs, waitedMs, attempts };
  }
}

// ── accepted-then-polled routes ───────────────────────────────────────────────────────────────

/**
 * Where to poll each route that answers 202 and a job id instead of its result.
 *
 * On 2026-09-17 the slow bulk writes stopped doing their work inside the request. The web client
 * gives up at 30 s and the server did not, so the screen reported a failure for work still under
 * way, and a second press started it again. Those routes now answer 202 `{ jobId, deduplicated }`
 * (inside the usual `{ success, data }` envelope), and the body they used to answer with is the
 * finished job's `result`.
 *
 * What moved and what did not, because a probe asserting a refusal has to know which it is:
 *
 *   still immediate   validation (bad target status, over-long reason, > 500 ids, unknown fields),
 *                     the role gate, the region ceiling. 400/403/404, and NOTHING is queued.
 *   inside the result per-row refusals — a duties conflict, a held payout, a reason-gated hop.
 *                     The POST says 202; the refusal is in `result.refused` / `result.skipped`.
 *
 * A job is readable ONLY by the account that started it (`assertJobVisibleTo`: anyone else gets a
 * 404, administrators included), so poll with the same account's token.
 *
 * `deduplicated: true` means an identical run by the same account was still queued or running and
 * this press joined it — its result IS that run's result. A probe that means "press it again" must
 * let the first run finish before pressing, or it measures the join rather than the repeat.
 */
export const JOB_STATUS = {
  /** POST /assayers/app-access/bulk, /assayers/bulk/notify, /assayers/bulk/lifecycle */
  assayerBulk: (jobId) => `/assayers/bulk-jobs/${encodeURIComponent(jobId)}`,
  /** POST /billing-engine/payouts/approve, /billing-engine/payouts/pay, /billing-engine/assayer-invoices/invite-all */
  billingBulk: (jobId) => `/billing-engine/bulk-jobs/${encodeURIComponent(jobId)}`,
  /**
   * POST /planning/coverage-plans/:planId/execute (result: the old deploy body plus
   * `alreadyDeployedCount`), /planning/bulk-offers/jobs, /planning/unable-to-cover/jobs,
   * /planning/projects/:projectId/coverage-plan/versions/jobs
   */
  planningWrite: (jobId) => `/planning/write-jobs/${encodeURIComponent(jobId)}`,
  /** POST /documents/dispatch-batch (result: `{ dispatched, failed: [{ documentId, reason }] }`) */
  documentDispatch: (jobId) => `/documents/dispatch-batch/${encodeURIComponent(jobId)}`,
  /**
   * Every upload on the background-job foundation — POST /assayers/roster/import (a `dryRun`
   * rehearsal ends AWAITING_REVIEW, which counts as done here; its `result` is the rehearsal's),
   * /customer-master/upload, /documents/upload-generated-batch, and anything POSTed to /jobs.
   * They answer 202 `{ job, deduplicated }`; the job is read back from GET /jobs/:id.
   */
  backgroundJob: (jobId) => `/jobs/${encodeURIComponent(jobId)}`,
  /** POST /admin/data-reset/execute. Run in-process, not on a queue: a restart loses it (404). */
  dataReset: (jobId) => `/admin/data-reset/runs/${encodeURIComponent(jobId)}`,
};

/** A job that did not come to `done`: it failed, ran out of time, or could not be read back. */
export class JobError extends Error {
  constructor(message, { jobId = null, statusPath = null, state = null, serverError = null, httpStatus = null } = {}) {
    super(message);
    this.name = 'JobError';
    /** 'failed' | 'timeout' | 'unreadable' | 'not-accepted' — or the last state seen. */
    this.state = state;
    this.jobId = jobId;
    this.statusPath = statusPath;
    /** The server's own `error` for a failed run — the operator-facing reason, never a stack. */
    this.serverError = serverError;
    this.httpStatus = httpStatus;
  }
}

/** `awaitJob`'s default patience. A run waits behind other runs on its queue (concurrency 1). */
export const JOB_TIMEOUT_MS = Number(env.AC_JOB_TIMEOUT_MS) > 0 ? Number(env.AC_JOB_TIMEOUT_MS) : 120_000;

/** `describeJob`'s four states. A background-job row's statuses are mapped onto them first. */
const JOB_DONE = new Set(['done', 'completed']);
const JOB_FAILED = new Set(['failed', 'stuck']);

/**
 * A `GET /jobs/:id` summary (`status`: QUEUED | RUNNING | AWAITING_REVIEW | SUCCEEDED | FAILED |
 * CANCELLED) read in `describeJob`'s words, so one polling loop serves both. A rehearsal waiting for
 * review is an answer, so it is done.
 */
const fromBackgroundJob = (s) => {
  if (!s || typeof s !== 'object' || typeof s.state === 'string' || typeof s.status !== 'string') return s;
  const state = s.status === 'SUCCEEDED' || s.status === 'AWAITING_REVIEW' ? 'done'
    : s.status === 'FAILED' || s.status === 'CANCELLED' ? 'failed'
      : s.status === 'RUNNING' ? 'running' : 'queued';
  return { ...s, jobId: s.id, state, error: s.error ?? (s.status === 'CANCELLED' ? 'cancelled' : undefined) };
};

/** The `{ success, data }` envelope, removed once — the same unwrap `login()` does inline. */
const unwrap = (body) => (
  body && typeof body === 'object' && typeof body.success === 'boolean' && 'data' in body ? body.data : body);
/** A token, or a function returning the current one (for probes that renew a session mid-run). */
const tokenOf = (token) => (typeof token === 'function' ? token() : token);
const pause = (ms) => new Promise((s) => setTimeout(s, ms));

/**
 * Poll a job's status route until it is `done` (returns its `result`) or `failed` (throws a
 * JobError carrying the server's reason). Also throws — as a JobError — when the budget runs out,
 * or when the status route itself refuses (404: not this account's job, or no longer retained;
 * 429 for the whole budget: throttled, UNKNOWN).
 *
 * The one polling loop in this directory. Probes do not write their own.
 *
 *   token      the token of the account that STARTED the job (or a function returning it)
 *   timeoutMs  overall budget, default JOB_TIMEOUT_MS (env AC_JOB_TIMEOUT_MS, else 120 s)
 *   pollMs     first interval, growing by half each poll to at most maxPollMs (default 3 s), so a
 *              quick run answers quickly and a slow one does not eat the per-IP request budget
 *   api        base URL, for probes that carry their own AC_API rather than this file's
 */
export async function awaitJob(statusPath, {
  token, api = API, timeoutMs = JOB_TIMEOUT_MS, pollMs = 500, maxPollMs = 3_000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let interval = pollMs;
  for (;;) {
    const r = await req(statusPath, { token: tokenOf(token), api, budgetMs: Math.max(1_000, deadline - Date.now()) });
    const s = fromBackgroundJob(unwrap(r.body));
    if (r.status < 200 || r.status >= 300 || !s || typeof s.state !== 'string') {
      throw new JobError(
        `could not read the job at ${statusPath}: HTTP ${r.status} ${String(r.msg ?? '').slice(0, 160)}`
        + (r.status === 404 ? ' — a job is readable only by the account that started it, and only while retained' : ''),
        { statusPath, state: 'unreadable', httpStatus: r.status });
    }
    const meta = { jobId: s.jobId ?? null, statusPath, httpStatus: r.status };
    if (JOB_DONE.has(s.state)) return s.result ?? null;
    if (JOB_FAILED.has(s.state)) {
      const why = s.error ?? 'the server reported no reason';
      throw new JobError(`job ${s.jobId ?? '?'} failed: ${why}`, { ...meta, state: 'failed', serverError: why });
    }
    if (Date.now() >= deadline) {
      const at = s.progress ? ` at "${s.progress.stage ?? ''}" ${s.progress.percent ?? '?'}%` : '';
      throw new JobError(`job ${s.jobId ?? '?'} was still ${s.state}${at} after ${timeoutMs} ms`,
        { ...meta, state: 'timeout' });
    }
    await pause(Math.min(interval, Math.max(0, deadline - Date.now())));
    interval = Math.min(Math.round(interval * 1.5), maxPollMs);
  }
}

/**
 * POST to an accepted-then-polled route and wait for the run. Never throws for an OUTCOME — a
 * request-level refusal and a failed run are both things a probe asserts on — only for a broken
 * harness (the network, a bad argument). Resolves to:
 *
 *   r          the POST's response, exactly as `req` (or `send`) returned it
 *   status     its HTTP status — 202 when accepted
 *   accepted   `{ jobId, deduplicated }` when accepted, else null. A 400/403/404 refusal lands
 *              here as null: it was decided in the request and nothing was queued, so nothing
 *              is awaited, and the refusal is read from `r` as it always was.
 *   result     the finished run's result — the body the route used to answer with — else null
 *   error      a JobError when the run failed, timed out or could not be read back, or when a 2xx
 *              came back without a job id (a build older than this contract); else null
 *   throttled  the POST itself was throttled out: UNKNOWN, not a refusal
 *
 * `statusPathFor` is a JOB_STATUS entry, or any `(jobId) => path`. `send(path, body)` replaces the
 * POST for probes with their own request plumbing (re-auth, traffic accounting, throttle markers)
 * and must resolve to `{ status, body }`; `token` is still what the poll uses, so pass the same
 * account's. Remaining options go to `awaitJob`.
 */
export async function postAndAwait(path, body, statusPathFor, { token, send, api = API, ...wait } = {}) {
  const r = send ? await send(path, body) : await req(path, { method: 'POST', token: tokenOf(token), body, api });
  const out = {
    r, status: r.status, accepted: null, result: null, error: null,
    throttled: r.status === 429 || r.throttled === true,
  };
  if (r.status < 200 || r.status >= 300) return out;
  const raw = unwrap(r.body);
  // A background-job route answers `{ job, deduplicated }`; the rest answer `{ jobId, deduplicated }`.
  const data = raw?.job?.id ? { jobId: raw.job.id, deduplicated: raw.deduplicated } : raw;
  if (r.status !== 202 || data?.jobId === undefined || data?.jobId === null) {
    out.error = new JobError(
      `${path} answered HTTP ${r.status} without a job id — expected 202 { jobId, deduplicated }; `
      + 'is this deployment older than the accepted-then-polled contract?',
      { statusPath: null, state: 'not-accepted', httpStatus: r.status });
    return out;
  }
  out.accepted = { jobId: String(data.jobId), deduplicated: data.deduplicated === true };
  try {
    out.result = await awaitJob(statusPathFor(out.accepted.jobId), { token, api, ...wait });
  } catch (e) {
    if (!(e instanceof JobError)) throw e;
    out.error = e;
  }
  return out;
}

/** One line for a check's detail: what the POST answered, and what the run came to. */
export function describeJobOutcome(o) {
  if (!o) return 'no outcome';
  if (o.throttled) return `HTTP ${o.status} (throttled — UNKNOWN, not a refusal)`;
  if (!o.accepted) {
    const said = o.error?.message ?? o.r?.msg ?? o.r?.body?.message ?? '';
    return `HTTP ${o.status}${said ? ` "${String(said).slice(0, 140)}"` : ''}`;
  }
  const head = `HTTP ${o.status}, job ${o.accepted.jobId}${o.accepted.deduplicated ? ' (joined a run already in flight)' : ''}`;
  return o.error ? `${head} -> ${o.error.state}: ${o.error.serverError ?? o.error.message}` : `${head} -> done`;
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

/**
 * The current version of a client standing, or null when there is no row yet.
 *
 * `PUT /assayers/:id/empanelment/:clientId` stopped being a free-form upsert on 2026-09-11: an
 * UPDATE now requires `expectedVersion`, so that two desks recording different standings at the
 * same time cannot both be told theirs saved while one is silently discarded. A CREATE still needs
 * no version — there is no earlier decision to be stale about.
 *
 * Probes that set up a panel standing as a FIXTURE therefore have to read the version first. This
 * is that read, in one place, because three scripts were about to grow their own copy of it.
 */
export async function empanelmentVersion(assayerId, clientId) {
  const row = await one(
    `SELECT version FROM assayer_client_empanelments WHERE assayer_id = $1 AND client_id = $2`,
    [assayerId, clientId]);
  return row ? Number(row.version) : null;
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
