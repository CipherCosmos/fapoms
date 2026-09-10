#!/usr/bin/env node
/**
 * FAPOMS product acceptance — search/filter/sort, export/report, and performance.
 *
 * Companion to `business-loop.mjs` and `authorization-and-audit.mjs`, and it makes the same
 * argument they do: an HTTP 200 with a list in it is not evidence that the list is the right
 * list. Every filter here is re-computed independently in SQL and compared set-wise against
 * what the API returned; every export is compared, row for row, against the screen it claims
 * to mirror; every timing discards its first (cold) call and reports p50 and worst of the rest.
 *
 * Three things this script deliberately does NOT do:
 *
 *   - It never asserts a latency threshold. A number measured on a 12-assignment database says
 *     nothing about production, and inventing a pass mark for it would launder a guess into a
 *     certification. It reports the numbers and the row counts they were measured over.
 *   - It never writes. Every probe is a GET, a login, or a queued-report POST that produces a
 *     workbook and nothing else. The one exception is the queued-report POST, which enqueues.
 *   - It never treats a 429 as an answer. The throttler is a brake; a 429 is retried once and
 *     then recorded as UNKNOWN rather than as a denial or as a slow response.
 *
 * ## The comparison method
 *
 * A filter is correct when it selects *exactly the rows of the unfiltered list* that satisfy
 * the predicate. So each filter check takes the endpoint's own unfiltered id set as the
 * baseline, intersects it with the predicate computed in SQL, and compares that against the
 * filtered call. This is deliberately independent of whatever base predicate the endpoint
 * applies internally (`is_active`, organisation, region): if the endpoint hides inactive rows,
 * both sides hide them, and the check still measures only the filter under test.
 *
 * ## Running it
 *
 *   node scripts/acceptance/search-export-performance.mjs             # everything
 *   node scripts/acceptance/search-export-performance.mjs search      # one phase
 *   node scripts/acceptance/search-export-performance.mjs export perf
 *
 * Configuration comes from the shared acceptance helpers (`PA_LIB`, see below), which read
 * `acc.env`. `PA_LIB` points at the campaign's `lib.mjs`; override it if the helpers move.
 */

import XLSX from 'xlsx';

const PA_LIB = process.env.PA_LIB
  ?? '/private/tmp/claude-501/-Users-deepstacker-WorkSpace-dupcq-gssAutomation/18ced63c-3709-4b5e-a708-90162fd58be8/scratchpad/pa/lib.mjs';
const lib = await import(PA_LIB);
const { env, API, login, sql, one, pool, CERT_PASSWORD } = lib;

const PHASES = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const want = (p) => PHASES.length === 0 || PHASES.includes(p);

// ── Bookkeeping ────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
let unknown = 0;
const findings = [];
const timings = [];

const check = (name, ok, detail) => {
  if (ok === null) { unknown++; console.log(`UNKN  ${name}${detail ? `\n        ${detail}` : ''}`); return; }
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
};

/** Record a defect with the exact request and the exact response that produced it. */
const finding = (id, severity, title, repro, observed, note) => {
  findings.push({ id, severity, title, repro, observed, note });
  console.log(`\n>>> ${id} [${severity}] ${title}\n    repro:    ${repro}\n    observed: ${observed}${note ? `\n    note:     ${note}` : ''}\n`);
};

// ── HTTP ───────────────────────────────────────────────────────────────────

/**
 * One request, with the timing and the raw body kept.
 *
 * `lib.req` retries a 429 forever and parses JSON only; neither is right here — a retried call
 * is not a measurement, and half the surfaces under test return CSV or a spreadsheet. So this
 * is the same idea with the two properties this script needs: a single retry, and bytes.
 */
/**
 * The export routes carry their own brake: `@Throttle({ limit: 10, ttl: 60_000 })` per handler.
 * A certification that runs six exports across seven roles trips it, and a 429 is not an answer
 * to any question this script asks. So calls to those routes are paced under the limit rather
 * than fired and retried — the brake is left working, and every result is a real result.
 */
const REPORT_BUDGET = 9;
const REPORT_WINDOW_MS = 61_000;
const reportCalls = new Map();

async function paceReports(path) {
  // Only the routes that build a workbook carry the brake. Polling and downloading a finished
  // job do not, and pacing them would only make the run slower for no reason.
  if (path.startsWith('/reports/jobs/')) return;
  if (!path.startsWith('/reports/')) return;
  const key = path.split('?')[0].replace(/\/[0-9]+(\/|$)/, '/:id$1');
  const now = Date.now();
  const seen = (reportCalls.get(key) ?? []).filter((t) => now - t < REPORT_WINDOW_MS);
  if (seen.length >= REPORT_BUDGET) {
    const waitMs = REPORT_WINDOW_MS - (now - seen[0]) + 250;
    console.log(`     (pacing ${key}: ${Math.ceil(waitMs / 1000)}s to stay under its 10/min budget)`);
    await new Promise((s) => setTimeout(s, waitMs));
    reportCalls.set(key, (reportCalls.get(key) ?? []).filter((t) => Date.now() - t < REPORT_WINDOW_MS));
  }
  reportCalls.set(key, [...(reportCalls.get(key) ?? []).filter((t) => Date.now() - t < REPORT_WINDOW_MS), Date.now()]);
}

async function hit(path, { method = 'GET', token, body, accept } = {}) {
  await paceReports(path);
  const url = API + path;
  const send = async () => {
    const t0 = process.hrtime.bigint();
    const r = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(accept ? { Accept: accept } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const buf = Buffer.from(await r.arrayBuffer());
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    let json = null;
    const ct = r.headers.get('content-type') ?? '';
    if (ct.includes('json')) { try { json = JSON.parse(buf.toString('utf8')); } catch { /* keep bytes */ } }
    return {
      status: r.status, ms, buf, json, ct,
      text: ct.includes('json') || ct.includes('text') ? buf.toString('utf8') : null,
      disposition: r.headers.get('content-disposition'),
      msg: json?.message ?? json?.error ?? null,
      url, method,
    };
  };
  let r = await send();
  if (r.status === 429) {
    await new Promise((s) => setTimeout(s, 3000));
    r = await send();
    if (r.status === 429) r.throttled = true;
  }
  /**
   * A 401 that says the account is inactive is not this endpoint's answer.
   *
   * This rig is shared with other acceptance sessions, and one of them toggles account status
   * in bulk. A token can therefore stop working between two calls of the same check, and
   * recording that as "the export refused me" would be a fabricated denial. Re-establish the
   * principal once and ask again; only the second answer is evidence.
   */
  if (r.status === 401 && token && reauth.has(token)) {
    const who = reauth.get(token);
    try {
      const fresh = await login(who.username, who.password);
      reauth.delete(token);
      reauth.set(fresh.token, who);
      if (P[who.role]) P[who.role].token = fresh.token;
      const c = readCache(); c[who.role] = { username: who.username, token: fresh.token }; writeCache(c);
      console.log(`     (re-established ${who.username} after a mid-run 401 "${r.json?.code ?? ''}"; the shared rig toggles account status)`);
      return hit(path, { method, token: fresh.token, body, accept });
    } catch { /* fall through and report the 401 as observed */ }
  }
  return r;
}

/** token -> the principal that minted it, so a token killed mid-run can be re-established once. */
const reauth = new Map();

/**
 * A login that gives up.
 *
 * `lib.login` goes through `lib.req`, which retries a 429 for as long as it takes — correct for
 * a script that must sign in, wrong for an optional extra principal. `POST /auth/login` allows
 * 20 a minute for the whole host and around twenty acceptance sessions share it, so an
 * unbounded wait here is a run that never ends. Ninety seconds, then the check that wanted this
 * principal reports UNKNOWN, which is the honest answer.
 */
const boundedLogin = async (username, password) => {
  const cache = readCache();
  const hit0 = Object.values(cache).find((c) => c.username === username);
  if (hit0?.token) {
    const probe = await fetch(`${API}/users/me`, { headers: { Authorization: `Bearer ${hit0.token}` } });
    if (probe.status === 200) return { token: hit0.token };
  }
  const s = await Promise.race([
    login(username, password),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`login ${username}: gave up after 90s (the login brake is saturated)`)), 90_000)),
  ]);
  const c = readCache(); c[username] = { username, token: s.token }; writeCache(c);
  return s;
};

/** Pull the row array out of whichever envelope a surface happens to use. */
const rowsOf = (r) => {
  const d = r.json?.data ?? r.json;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.items)) return d.items;
  if (Array.isArray(d?.data)) return d.data;
  return [];
};

/** The total the surface claims, wherever it keeps it. */
const totalOf = (r) => {
  const b = r.json ?? {};
  return b.meta?.pagination?.total ?? b.meta?.total ?? b.data?.total ?? b.pagination?.total ?? null;
};

const idsOf = (r) => rowsOf(r).map((x) => x?.id).filter(Boolean);
const setOf = (a) => new Set(a);
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const brief = (r, n = 180) => `HTTP ${r.status}${r.throttled ? ' (throttled)' : ''} ${String(r.text ?? `<${r.buf.length} bytes ${r.ct}>`).replace(/\s+/g, ' ').slice(0, n)}`;

// ── Timing ─────────────────────────────────────────────────────────────────

/**
 * Time one call N+1 times and throw the first away.
 *
 * The first request through a cold connection pool, a cold query plan and a cold page cache is
 * measuring the stack waking up, not the endpoint. It is discarded and the discard is reported,
 * because a p50 that quietly includes it is a different number than the one it claims to be.
 */
async function time(label, path, opts, runs = 6) {
  const samples = [];
  let cold = null;
  let status = null;
  let rows = null;
  let bytes = null;
  for (let i = 0; i <= runs; i++) {
    const r = await hit(path, opts);
    if (r.throttled) return { label, path, throttled: true };
    status = r.status;
    rows = rowsOf(r).length || null;
    bytes = r.buf.length;
    if (i === 0) cold = r.ms; else samples.push(r.ms);
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor((samples.length - 1) / 2)];
  const rec = {
    label, path, status, rows, bytes,
    cold: +cold.toFixed(1),
    p50: +p50.toFixed(1),
    worst: +samples[samples.length - 1].toFixed(1),
    best: +samples[0].toFixed(1),
    runs: samples.length,
  };
  timings.push(rec);
  console.log(
    `  ${label.padEnd(46)} ${String(rec.status).padEnd(4)} rows=${String(rec.rows ?? '-').padEnd(5)} `
    + `p50=${String(rec.p50).padStart(8)}ms worst=${String(rec.worst).padStart(8)}ms (cold ${rec.cold}ms discarded, n=${rec.runs})`,
  );
  return rec;
}

// ── Phase 0: principals, each proved alive on a permitted read ─────────────

const PERSONAS = [
  ['ADMIN', 'admin', () => env.AC_PASSWORD],
  ['DEVELOPER', 'cert_developer', () => CERT_PASSWORD],
  ['OPERATIONS', 'cert_operations', () => CERT_PASSWORD],
  ['DESK', 'cert_desk', () => CERT_PASSWORD],
  ['DESK_OPERATOR', 'cert_desk_operator', () => CERT_PASSWORD],
  ['AUDITOR', 'cert_auditor', () => CERT_PASSWORD],
  ['CLIENT_USER', 'cert_client_user', () => CERT_PASSWORD],
];

const P = {};

/**
 * Tokens are cached beside `acc.env`, and the cache is the point.
 *
 * `POST /auth/login` is throttled at 20 a minute for the whole host, and this rig is shared with
 * around twenty other acceptance sessions that are all signing in. Seven fresh logins per phase
 * is how a run spends ten minutes queueing behind other people's 429s instead of measuring
 * anything. A cached token is used only after `GET /users/me` proves it still works, so a stale
 * or revoked one costs one request and falls through to a real login.
 */
const TOKEN_CACHE = new URL('../sxp-tokens.json', new URL(PA_LIB, 'file:///'));
const fs = await import('node:fs');
const readCache = () => { try { return JSON.parse(fs.readFileSync(TOKEN_CACHE, 'utf8')); } catch { return {}; } };
const writeCache = (c) => { try { fs.writeFileSync(TOKEN_CACHE, JSON.stringify(c, null, 2)); } catch { /* best effort */ } };

async function establishPrincipals() {
  console.log('\n=== 0. Principals (every token proved alive on a permitted read) ===\n');
  const cache = readCache();
  for (const [role, username, pw] of PERSONAS) {
    try {
      let s = null;
      if (cache[role]?.token) {
        reauth.set(cache[role].token, { role, username, password: pw() });
        const probe = await fetch(`${API}/users/me`, { headers: { Authorization: `Bearer ${cache[role].token}` } });
        if (probe.status === 200) s = { token: cache[role].token };
        else reauth.delete(cache[role].token);
      }
      if (!s) s = await login(username, pw());
      cache[role] = { username, token: s.token };
      reauth.set(s.token, { role, username, password: pw() });
      const me = await hit('/users/me', { token: s.token });
      const liveName = me.json?.data?.username ?? me.json?.username ?? null;
      P[role] = { role, username, token: s.token, id: me.json?.data?.id ?? null, alive: me.status === 200 };
      check(
        `token alive — ${role} (${username}) GET /users/me`,
        me.status === 200 && liveName === username,
        `HTTP ${me.status} username=${liveName}`,
      );
    } catch (e) {
      P[role] = { role, username, token: null, alive: false };
      check(`token alive — ${role} (${username})`, false, String(e.message).slice(0, 200));
    }
  }
  writeCache(cache);
  const dead = Object.values(P).filter((p) => !p.alive).map((p) => p.role);
  if (dead.length) {
    console.log(`\n!! ${dead.join(', ')} could not be established — every denial reported for them is UNKNOWN, not a control.\n`);
  }
}

// ── Phase 0b: what the data actually looks like ────────────────────────────

async function census() {
  console.log('\n=== 0b. Dataset census (the volume every number below was measured over) ===\n');
  const tables = [
    'assayers', 'assignments', 'branches', 'project_branches', 'projects', 'clients', 'users',
    'documents', 'notifications', 'billing_entries', 'billing_invoices', 'assayer_payables',
    'validation_cases', 'schedules', 'audit_events',
  ];
  const counts = {};
  for (const t of tables) {
    try { counts[t] = (await one(`SELECT count(*)::int AS c FROM ${t}`)).c; } catch { counts[t] = 'n/a'; }
  }
  console.log('  ' + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  '));

  const dbs = await sql('SELECT datname, pg_size_pretty(pg_database_size(datname)) AS sz FROM pg_database ORDER BY 1');
  console.log('  databases on this server: ' + dbs.map((d) => `${d.datname} (${d.sz})`).join(', '));
  const scale = dbs.find((d) => /scale/i.test(d.datname));
  check(
    'scale dataset — a fapoms_scale* database exists on the acceptance server',
    scale ? true : null,
    scale ? `found ${scale.datname} (${scale.sz})` : 'SELECT datname FROM pg_database returned no scale database — see the report',
  );
  return counts;
}

// ══════════════════════════════════════════════════════════════════════════
// 1. SEARCH, FILTER AND SORT
// ══════════════════════════════════════════════════════════════════════════

/**
 * A filter must select exactly the rows of the unfiltered list that satisfy the predicate.
 *
 * `baselinePath` is the same surface with no filter and a limit big enough to hold it all;
 * `predicate` is the same condition expressed in SQL, returning ids. The comparison is
 * `API(filter)` against `baseline ∩ SQL(predicate)`, so a base predicate the endpoint applies
 * internally cancels out of both sides instead of producing a false failure.
 */
async function filterVsSql(name, token, baselinePath, filteredPath, predicateSql, params = []) {
  const base = await hit(baselinePath, { token });
  const got = await hit(filteredPath, { token });
  if (base.throttled || got.throttled) { check(name, null, 'throttled — UNKNOWN'); return null; }
  if (base.status !== 200 || got.status !== 200) {
    check(name, false, `baseline ${brief(base)} | filtered ${brief(got)}`);
    return null;
  }
  const baseIds = setOf(idsOf(base));
  const sqlIds = setOf((await sql(predicateSql, params)).map((r) => r.id));
  const expected = setOf([...baseIds].filter((id) => sqlIds.has(id)));
  const actual = setOf(idsOf(got));
  const ok = sameSet(expected, actual);
  const extra = [...actual].filter((id) => !expected.has(id));
  const missing = [...expected].filter((id) => !actual.has(id));
  check(
    name, ok,
    `GET ${filteredPath} -> ${actual.size} rows; SQL predicate over the unfiltered ${baseIds.size} -> ${expected.size}`
    + (ok ? '' : `; extra=${extra.slice(0, 4).join(',')} missing=${missing.slice(0, 4).join(',')}`),
  );
  return { ok, expected, actual, baseIds, extra, missing, got };
}

/** Does an unknown VALUE for a known filter narrow to nothing, refuse, or return everything? */
async function unknownValue(name, token, baselinePath, filteredPath) {
  const base = await hit(baselinePath, { token });
  const got = await hit(filteredPath, { token });
  if (base.throttled || got.throttled) { check(name, null, 'throttled — UNKNOWN'); return null; }
  const baseIds = setOf(idsOf(base));
  const actual = setOf(idsOf(got));
  const refused = got.status >= 400 && got.status < 500;
  const everything = got.status === 200 && baseIds.size > 0 && sameSet(baseIds, actual);
  const ok = refused || (got.status === 200 && actual.size === 0);
  check(
    name, ok,
    `GET ${filteredPath} -> ${brief(got, 110)}; rows=${actual.size} of an unfiltered ${baseIds.size}`
    + (everything ? '  <-- returned the WHOLE unfiltered set' : ''),
  );
  return { ok, everything, got, baseIds, actual };
}

/** Collected across surfaces so the report carries one finding per defect class, not per route. */
const serverErrors = [];
const ignoredKeys = [];
const wildcardOpen = [];

/** Does an unknown KEY get refused, or silently ignored (leaving the caller unfiltered)? */
async function unknownKey(name, token, baselinePath, filteredPath) {
  const base = await hit(baselinePath, { token });
  const got = await hit(filteredPath, { token });
  if (base.throttled || got.throttled) { check(name, null, 'throttled — UNKNOWN'); return null; }
  const same = got.status === 200 && sameSet(setOf(idsOf(base)), setOf(idsOf(got)));
  const refused = got.status === 400;
  console.log(`  unknown key — ${name}: ${refused ? 'REFUSED 400' : same ? 'IGNORED (same rows as unfiltered)' : `HTTP ${got.status}`}  [${filteredPath}]`);
  if (same) ignoredKeys.push({ name, path: filteredPath, rows: idsOf(got).length });
  return { refused, ignored: same, got };
}

/** Walk pages and prove no id appears twice and none is skipped. */
async function walkPages(name, token, pathFor, pageSize, pages = 3) {
  const seen = new Map();
  let dup = null;
  let total = null;
  let collected = 0;
  for (let p = 1; p <= pages; p++) {
    const r = await hit(pathFor(p, pageSize), { token });
    if (r.throttled) { check(name, null, 'throttled — UNKNOWN'); return null; }
    if (r.status !== 200) { check(name, false, `page ${p}: ${brief(r)}`); return null; }
    total = totalOf(r) ?? total;
    for (const id of idsOf(r)) {
      if (seen.has(id)) dup = dup ?? { id, first: seen.get(id), again: p };
      else seen.set(id, p);
      collected++;
    }
  }
  // The union of N pages of size L must be exactly min(N*L, total) distinct rows: a duplicate
  // makes the union smaller than the rows delivered, and a skip makes it smaller than the
  // window. Both are the same arithmetic, so both are caught here.
  const expectedWindow = total == null ? collected : Math.min(pages * pageSize, total);
  const ok = !dup && seen.size === expectedWindow;
  check(
    name, ok,
    `${pages} pages x ${pageSize}: delivered ${collected} rows, ${seen.size} distinct, total=${total}, expected window=${expectedWindow}`
    + (dup ? `; DUPLICATE id ${dup.id} on pages ${dup.first} and ${dup.again}` : ''),
  );
  return { ok, dup, seen, total, expectedWindow };
}

/** Compare an ordering against the same ordering computed in SQL, both directions. */
async function sortVsSql(name, token, pathFor, sqlFor, key) {
  const out = {};
  for (const dir of ['ASC', 'DESC']) {
    const r = await hit(pathFor(dir), { token });
    if (r.throttled) { check(`${name} (${dir})`, null, 'throttled — UNKNOWN'); continue; }
    if (r.status !== 200) { check(`${name} (${dir})`, false, brief(r)); continue; }
    const apiIds = idsOf(r);
    const sqlIds = (await sql(sqlFor(dir))).map((x) => x.id).filter((id) => apiIds.includes(id));
    const ok = apiIds.length === sqlIds.length && apiIds.every((id, i) => id === sqlIds[i]);
    out[dir] = { apiIds, sqlIds, ok, sample: rowsOf(r).map((x) => x?.[key]) };
    check(
      `${name} (${dir})`, ok,
      `GET ${pathFor(dir)} -> ${JSON.stringify(out[dir].sample.slice(0, 6))}; SQL ORDER BY ${dir} disagrees at index `
      + `${apiIds.findIndex((id, i) => id !== sqlIds[i])}`,
    );
  }
  if (out.ASC && out.DESC) {
    const reversed = [...out.ASC.apiIds].reverse();
    check(
      `${name} — DESC is the reverse of ASC`,
      out.DESC.apiIds.length === reversed.length && out.DESC.apiIds.every((id, i) => id === reversed[i]),
      `ASC=${out.ASC.sample.slice(0, 5).join('|')}  DESC=${out.DESC.sample.slice(0, 5).join('|')}`,
    );
  }
  return out;
}

/** The adversarial matrix, run against one surface. */
async function adversarial(surface, token, build) {
  console.log(`\n  -- adversarial: ${surface}`);
  const LONG = 'A'.repeat(5000);
  const cases = [
    ['unknown filter key', build({ zzUnknownFilter: 'zzz' })],
    ['wrong-type filter value', build({ typeConfusion: true })],
    ['negative page', build({ page: -1 })],
    ['page zero', build({ page: 0 })],
    ['page beyond the end', build({ page: 99999 })],
    ['limit=0', build({ limit: 0 })],
    ['limit=999999999', build({ limit: 999999999 })],
    ['limit=abc', build({ limit: 'abc' })],
    ['5,000-character search string', build({ q: LONG })],
    ["SQL metacharacters (' OR 1=1 --)", build({ q: "' OR 1=1 --" })],
    ['LIKE wildcard %', build({ q: '%' })],
    ['LIKE wildcard _', build({ q: '_' })],
    ['null byte in search', build({ q: 'a\u0000b' })],
  ].filter(([, p]) => p != null);

  const baseline = await hit(build({}), { token });
  const baseIds = setOf(idsOf(baseline));
  const results = [];
  for (const [label, path] of cases) {
    const r = await hit(path, { token });
    if (r.throttled) { console.log(`     ${label.padEnd(34)} THROTTLED — UNKNOWN`); results.push({ label, path, unknown: true }); continue; }
    const ids = setOf(idsOf(r));
    const unfiltered = r.status === 200 && baseIds.size > 0 && sameSet(baseIds, ids);
    const leaks = /\b(syntax error|SQLSTATE|QueryFailedError|invalid input value for enum|relation ".*" does not exist|column .* does not exist|ECONNREFUSED|at .*\.ts:\d+)/i
      .test(r.text ?? '');
    results.push({ label, path, status: r.status, rows: ids.size, unfiltered, leaks, body: (r.text ?? '').replace(/\s+/g, ' ').slice(0, 220) });
    console.log(
      `     ${label.padEnd(34)} ${String(r.status).padEnd(4)} rows=${String(ids.size).padEnd(5)}`
      + `${unfiltered ? ' UNFILTERED' : ''}${leaks ? ' LEAKS-SQL' : ''}${r.status >= 500 ? ' SERVER-ERROR' : ''}`,
    );
  }
  const bad = results.filter((x) => x.status >= 500 || x.leaks);
  for (const b of bad) serverErrors.push({ surface, ...b });
  for (const w of results.filter((x) => /wildcard/.test(x.label) && x.unfiltered)) wildcardOpen.push({ surface, ...w });
  check(
    `adversarial input — ${surface}: no 500 and no leaked SQL error`,
    bad.length === 0,
    bad.length ? bad.map((b) => `${b.label} -> ${b.status} ${b.body}`).join(' || ') : `${results.length} hostile inputs, all refused or handled`,
  );
  return { results, baseIds };
}

async function phaseSearch() {
  console.log('\n\n════ 1. SEARCH, FILTER AND SORT ════\n');
  const ADMIN = P.ADMIN.token;

  // ---- 1.1 The assayer roster: nine segment chips, four filter groups ------
  console.log('\n=== 1.1 Assayer roster (/assayers) ===\n');
  const ROSTER_ALL = '/assayers?limit=1000';

  const lifecycles = (await sql(
    'SELECT lifecycle_status AS s, count(*)::int AS c FROM assayers GROUP BY 1 ORDER BY 2 DESC',
  ));
  console.log('  lifecycle_status in the database: ' + lifecycles.map((l) => `${l.s}=${l.c}`).join(', '));

  for (const { s } of lifecycles) {
    await filterVsSql(
      `roster filter lifecycleStatus=${s}`, ADMIN, ROSTER_ALL, `/assayers?limit=1000&lifecycleStatus=${s}`,
      'SELECT id FROM assayers WHERE lifecycle_status = $1', [s],
    );
  }

  // The chips are a multi-select: the panel sends a comma-separated list.
  const two = lifecycles.slice(0, 2).map((l) => l.s);
  if (two.length === 2) {
    await filterVsSql(
      `roster filter lifecycleStatus=${two.join(',')} (multi-select chip)`, ADMIN, ROSTER_ALL,
      `/assayers?limit=1000&lifecycleStatus=${two.join(',')}`,
      'SELECT id FROM assayers WHERE lifecycle_status = ANY($1)', [two],
    );
  }

  const states = await sql('SELECT state AS s, count(*)::int AS c FROM assayers WHERE state IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 2');
  for (const { s } of states) {
    await filterVsSql(
      `roster filter state=${s}`, ADMIN, ROSTER_ALL, `/assayers?limit=1000&state=${encodeURIComponent(s)}`,
      'SELECT id FROM assayers WHERE state = $1', [s],
    );
  }
  const regions = await sql('SELECT region AS s, count(*)::int AS c FROM assayers WHERE region IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 2');
  for (const { s } of regions) {
    await filterVsSql(
      `roster filter region=${s}`, ADMIN, ROSTER_ALL, `/assayers?limit=1000&region=${encodeURIComponent(s)}`,
      'SELECT id FROM assayers WHERE region = $1', [s],
    );
  }
  const engagements = await sql('SELECT engagement_type AS s FROM assayers WHERE engagement_type IS NOT NULL GROUP BY 1 LIMIT 2');
  for (const { s } of engagements) {
    await filterVsSql(
      `roster filter engagementType=${s}`, ADMIN, ROSTER_ALL, `/assayers?limit=1000&engagementType=${encodeURIComponent(s)}`,
      'SELECT id FROM assayers WHERE engagement_type = $1', [s],
    );
  }

  // The free-text box inside the panel. ILIKE over four columns.
  const someone = await one("SELECT id, display_name FROM assayers WHERE display_name IS NOT NULL AND length(display_name) > 6 ORDER BY display_name LIMIT 1");
  if (someone) {
    const frag = someone.display_name.slice(2, 7);
    await filterVsSql(
      `roster free-text q=${JSON.stringify(frag)}`, ADMIN, ROSTER_ALL, `/assayers?limit=1000&q=${encodeURIComponent(frag)}`,
      'SELECT id FROM assayers WHERE display_name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1 OR assayer_code ILIKE $1',
      [`%${frag}%`],
    );
  }

  // Empanelment group — a filter over a joined table, the one most likely to fan out rows.
  const emp = await one("SELECT client_id, status FROM assayer_client_empanelments GROUP BY 1,2 ORDER BY count(*) DESC LIMIT 1");
  if (emp) {
    await filterVsSql(
      `roster filter empanelmentClientId=<client> (join fan-out check)`, ADMIN, ROSTER_ALL,
      `/assayers?limit=1000&empanelmentClientId=${emp.client_id}`,
      'SELECT DISTINCT a.id FROM assayers a JOIN assayer_client_empanelments e ON e.assayer_id = a.id WHERE e.client_id = $1',
      [emp.client_id],
    );
    await filterVsSql(
      `roster filter empanelmentStatus=${emp.status}`, ADMIN, ROSTER_ALL,
      `/assayers?limit=1000&empanelmentStatus=${emp.status}`,
      'SELECT DISTINCT a.id FROM assayers a JOIN assayer_client_empanelments e ON e.assayer_id = a.id WHERE e.status = $1',
      [emp.status],
    );
  }

  // joinedFrom/joinedTo — a date-range group, where an off-by-one on the boundary hides a row.
  const jd = await one('SELECT min(joining_date) AS lo, max(joining_date) AS hi FROM assayers WHERE joining_date IS NOT NULL');
  if (jd?.lo) {
    const iso = (d) => new Date(d).toISOString().slice(0, 10);
    await filterVsSql(
      `roster filter joinedFrom=${iso(jd.lo)} (inclusive lower bound)`, ADMIN, ROSTER_ALL,
      `/assayers?limit=1000&joinedFrom=${iso(jd.lo)}`,
      'SELECT id FROM assayers WHERE joining_date >= $1', [iso(jd.lo)],
    );
    await filterVsSql(
      `roster filter joinedTo=${iso(jd.lo)} (inclusive upper bound)`, ADMIN, ROSTER_ALL,
      `/assayers?limit=1000&joinedTo=${iso(jd.lo)}`,
      'SELECT id FROM assayers WHERE joining_date <= $1', [iso(jd.lo)],
    );
  }

  // Unknown values on each filter group.
  await unknownValue('roster lifecycleStatus=NOT_A_STATUS narrows or refuses', ADMIN, ROSTER_ALL, '/assayers?limit=1000&lifecycleStatus=NOT_A_STATUS');
  await unknownValue('roster region=ATLANTIS narrows or refuses', ADMIN, ROSTER_ALL, '/assayers?limit=1000&region=ATLANTIS');
  await unknownValue('roster empanelmentClientId=<random uuid> narrows or refuses', ADMIN, ROSTER_ALL,
    '/assayers?limit=1000&empanelmentClientId=00000000-0000-4000-8000-000000000000');
  await unknownValue('roster empanelmentClientId=not-a-uuid refuses', ADMIN, ROSTER_ALL, '/assayers?limit=1000&empanelmentClientId=not-a-uuid');
  await unknownValue('roster joinedFrom=not-a-date refuses', ADMIN, ROSTER_ALL, '/assayers?limit=1000&joinedFrom=banana');
  await unknownKey('roster', ADMIN, ROSTER_ALL, '/assayers?limit=1000&zzUnknownFilter=zzz');

  // The counts strip above the chips must agree with the list beneath it.
  const cnt = await hit('/assayers/counts', { token: ADMIN });
  if (cnt.status === 200) {
    // The strip is delivered as `[{ value, count }]`, not as a map.
    const raw = cnt.json?.data?.byLifecycleStatus ?? [];
    const byLifecycle = Array.isArray(raw)
      ? Object.fromEntries(raw.map((x) => [x.value ?? x.status ?? x.key, x.count ?? x.total]))
      : raw;
    const sqlCounts = Object.fromEntries((await sql(
      'SELECT lifecycle_status AS s, count(*)::int AS c FROM assayers GROUP BY 1',
    )).map((r) => [r.s, r.c]));
    const mismatches = Object.entries(sqlCounts).filter(([s, c]) => (byLifecycle[s] ?? 0) !== c);
    check(
      'roster counts strip agrees with the database', mismatches.length === 0,
      `API=${JSON.stringify(byLifecycle)}  SQL=${JSON.stringify(sqlCounts)}`,
    );
    // And under a filter, the strip must describe the filtered set, not the whole roster.
    if (states[0]) {
      const cf = await hit(`/assayers/counts?state=${encodeURIComponent(states[0].s)}`, { token: ADMIN });
      const filteredTotal = cf.json?.data?.total ?? null;
      const sqlTotal = (await one('SELECT count(*)::int AS c FROM assayers WHERE state = $1', [states[0].s])).c;
      check(
        `roster counts honour an active filter (state=${states[0].s})`,
        filteredTotal != null && Math.abs(filteredTotal - sqlTotal) <= 0,
        `GET /assayers/counts?state=${states[0].s} -> total=${filteredTotal}; SQL -> ${sqlTotal}`,
      );
    }
  } else {
    check('roster counts strip agrees with the database', false, brief(cnt));
  }

  // Pagination, keyset and offset, and the two together.
  await walkPages('roster pagination — 3 pages x 3, offset', ADMIN, (p, l) => `/assayers?page=${p}&limit=${l}`, 3, 3);
  await walkPages('roster pagination — 4 pages x 3 under a filter', ADMIN,
    (p, l) => `/assayers?page=${p}&limit=${l}&lifecycleStatus=${lifecycles[0].s}`, 3, 4);

  // Keyset: the roster's other pagination mode. Walk it to exhaustion and compare the union
  // against the offset walk — two ways of asking for the same list must produce the same list.
  {
    const all = setOf(idsOf(await hit(ROSTER_ALL, { token: ADMIN })));
    const seen = new Set();
    let cursor = null;
    let hops = 0;
    let dupe = null;
    do {
      const r = await hit(`/assayers?limit=3${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`, { token: ADMIN });
      if (r.status !== 200) { hops = -1; break; }
      for (const id of idsOf(r)) { if (seen.has(id)) dupe = dupe ?? id; seen.add(id); }
      cursor = r.json?.meta?.pagination?.nextCursor ?? null;
      hops++;
    } while (cursor && hops < 40);
    check(
      'roster keyset walk (?after=) delivers the whole roster exactly once',
      hops > 0 && !dupe && sameSet(seen, all),
      `${hops} hops at limit=3 -> ${seen.size} distinct of ${all.size} in the offset list${dupe ? `; DUPLICATE ${dupe}` : ''}`,
    );
  }

  await adversarial('/assayers', ADMIN, (o) => {
    const q = new URLSearchParams({ limit: '1000' });
    if (o.zzUnknownFilter) q.set('zzUnknownFilter', o.zzUnknownFilter);
    if (o.typeConfusion) q.set('lifecycleStatus', '12345');
    if (o.page !== undefined) q.set('page', String(o.page));
    if (o.limit !== undefined) q.set('limit', String(o.limit));
    if (o.q !== undefined) q.set('q', o.q);
    return `/assayers?${q}`;
  });

  // ---- 1.2 Global search --------------------------------------------------
  console.log('\n=== 1.2 Global search (/search) ===\n');
  const branch = await one("SELECT id, name FROM branches WHERE name IS NOT NULL ORDER BY name LIMIT 1");
  if (branch) {
    const frag = branch.name.split(/\s+/)[0];
    const r = await hit(`/search?q=${encodeURIComponent(frag)}`, { token: ADMIN });
    const groups = r.json?.data ?? {};
    check(
      `global search q=${JSON.stringify(frag)} finds the branch it names`,
      (groups.branches ?? []).some((b) => b.id === branch.id),
      `HTTP ${r.status} groups=${Object.entries(groups).map(([k, v]) => `${k}:${(v ?? []).length}`).join(' ')}`,
    );
    // Every group must actually match the term, not just be "some rows".
    const nonMatching = [];
    for (const [g, rows] of Object.entries(groups)) {
      for (const row of rows ?? []) {
        const hay = JSON.stringify(row).toLowerCase();
        if (!hay.includes(frag.toLowerCase())) nonMatching.push(`${g}:${row.id}`);
      }
    }
    check(
      'global search returns only rows that contain the term',
      nonMatching.length === 0,
      nonMatching.length ? `non-matching rows: ${nonMatching.slice(0, 5).join(', ')}` : 'every returned row contains the term',
    );
  }

  {
    const empty = await hit('/search?q=', { token: ADMIN });
    check('global search with an empty q returns empty groups, not everything',
      empty.status === 200 && Object.values(empty.json?.data ?? {}).every((v) => (v ?? []).length === 0),
      brief(empty, 140));

    const missing = await hit('/search', { token: ADMIN });
    check('global search with no q at all is handled', missing.status < 500, brief(missing, 140));

    // Global search ignores a one-character term, so a bare "%" proves nothing. "%%" is two
    // characters, passes the minimum, and is a LIKE pattern that matches every row if — and
    // only if — the term is interpolated into the pattern without escaping.
    const groupCount = (r) => Object.entries(r.json?.data ?? {}).map(([k, v]) => `${k}:${(v ?? []).length}`).join(' ');
    const groupTotal = (r) => Object.values(r.json?.data ?? {}).reduce((n, v) => n + (v ?? []).length, 0);
    const one1 = await hit('/search?q=a', { token: ADMIN });
    console.log(`  minimum term length: q=a -> ${groupCount(one1)} ; q=an -> ${groupCount(await hit('/search?q=an', { token: ADMIN }))}`);

    const wildcard = await hit('/search?q=%25%25', { token: ADMIN });   // the term is "%%"
    const nonsense = await hit('/search?q=zzqqxx', { token: ADMIN });
    const wildcardRows = groupTotal(wildcard);
    const nonsenseRows = groupTotal(nonsense);
    check(
      'global search treats LIKE wildcards in the term as literals, not as "everything"',
      wildcardRows <= nonsenseRows,
      `q=%%   -> ${groupCount(wildcard)}  (${wildcardRows} rows); q=zzqqxx -> ${groupCount(nonsense)} (${nonsenseRows} rows)`,
    );
    // The unambiguous demonstration: "%25" is three literal characters that appear in no name
    // in the database, yet as a pattern it is "any…2…5…any" and matches a branch code.
    const digits = await hit('/search?q=%2525', { token: ADMIN });      // the term is "%25"
    check(
      'global search does not match rows via an injected wildcard pattern',
      groupTotal(digits) === 0,
      `q=%25 (three literal characters, present in no name) -> ${groupCount(digits)}`,
    );
    if (wildcardRows > nonsenseRows || groupTotal(digits) > 0) {
      finding(
        'SXP-W1', 'MEDIUM',
        'Search terms are interpolated into ILIKE without escaping, so % and _ are wildcards any caller can inject',
        `GET ${API}/search?q=%25%25  (the term is "%%")   and   GET ${API}/search?q=%2525  (the term is "%25")`,
        `q=%% -> ${groupCount(wildcard)} where the nonsense term q=zzqqxx -> ${groupCount(nonsense)}; `
        + `q=%25 -> ${groupCount(digits)} — it matched on the pattern "any…2…5…any", not on the literal characters`,
        'The term is wrapped as `%${q}%` in roster-query.service.ts and search.service.ts, so a one-character "%" '
        + 'becomes the pattern "%%%": every row of every joined table, in one request, from a text box.',
      );
    }
  }

  await adversarial('/search', ADMIN, (o) => {
    const q = new URLSearchParams();
    q.set('q', o.q !== undefined ? o.q : 'a');
    if (o.zzUnknownFilter) q.set('zzUnknownFilter', o.zzUnknownFilter);
    if (o.typeConfusion) q.set('q', '12345');
    if (o.page !== undefined) q.set('page', String(o.page));
    if (o.limit !== undefined) q.set('limit', String(o.limit));
    return `/search?${q}`;
  });

  // Search authorization: a role that cannot see a resource must not find it in search.
  for (const role of ['AUDITOR', 'DESK_OPERATOR', 'CLIENT_USER']) {
    const p = P[role];
    if (!p?.alive) { check(`global search authorization — ${role}`, null, 'no live token'); continue; }
    const r = await hit('/search?q=a', { token: p.token });
    if (r.status === 403 || r.status === 401) {
      check(`global search authorization — ${role} is refused outright`, true, `HTTP ${r.status} ${r.msg ?? ''}`);
      continue;
    }
    const groups = r.json?.data ?? {};
    const n = Object.entries(groups).map(([k, v]) => `${k}:${(v ?? []).length}`).join(' ');
    check(`global search reachable by ${role}`, r.status === 200, `HTTP ${r.status} ${n}`);
  }
  /**
   * The strongest form of the authorization question: not "is the caller refused" but "can a
   * caller who is admitted find, through search, a specific row they are not allowed to see".
   * A region-scoped account and an out-of-region branch make that a yes/no with a named row.
   */
  const scopedCandidates = await sql(
    "SELECT username, regions FROM users WHERE regions IS NOT NULL AND array_length(regions,1) = 1 ORDER BY username",
  );
  let scopedUser = null;
  let stok = null;
  let why = 'no account in `users` carries exactly one region';
  for (const c of scopedCandidates) {
    try { stok = (await boundedLogin(c.username)).token; scopedUser = c; break; }
    catch (e) { why = String(e.message).slice(0, 160); }
  }
  if (scopedUser) {
    const outside = await one(
      'SELECT id, name, region FROM branches WHERE region IS NOT NULL AND region <> $1 ORDER BY name LIMIT 1',
      [scopedUser.regions[0]],
    );
    if (!stok || !outside) {
      check('search honours the caller region ceiling', null,
        `${!outside ? 'no out-of-region branch to look for' : `could not establish ${scopedUser.username}: ${why}`}`);
    } else {
      const alive = await hit('/users/me', { token: stok });
      const term = outside.name.split(/\s+/)[0];
      const r = await hit(`/search?q=${encodeURIComponent(term)}`, { token: stok });
      const asAdmin = await hit(`/search?q=${encodeURIComponent(term)}`, { token: ADMIN });
      const foundByAdmin = (asAdmin.json?.data?.branches ?? []).some((b) => b.id === outside.id);
      const foundByScoped = (r.json?.data?.branches ?? []).some((b) => b.id === outside.id);
      check(
        `search as ${scopedUser.username} [${scopedUser.regions}] cannot find the ${outside.region} branch "${outside.name}"`,
        alive.status === 200 && foundByAdmin && !foundByScoped,
        `token alive: GET /users/me -> ${alive.status}; GET /search?q=${term} as ADMIN finds it: ${foundByAdmin}; `
        + `as ${scopedUser.username}: ${foundByScoped} (HTTP ${r.status}, branches:${(r.json?.data?.branches ?? []).length})`,
      );
      if (foundByScoped) {
        finding('SXP-R1', 'HIGH', 'Global search returns rows outside the caller region ceiling',
          `GET ${API}/search?q=${term} as ${scopedUser.username} (users.regions = [${scopedUser.regions}])`,
          `the ${outside.region} branch "${outside.name}" (${outside.id}) is in the result set`);
      }
    }
  } else {
    check('search honours the caller region ceiling', null,
      `could not establish any of ${scopedCandidates.map((c) => c.username).join(', ') || '(none)'}: ${why}`);
  }

  // The specific proof: an assayer's phone number is a field DESK/AUDITOR may not read.
  for (const role of ['AUDITOR', 'DESK_OPERATOR']) {
    const p = P[role];
    if (!p?.alive) continue;
    const r = await hit('/search?q=a', { token: p.token });
    if (r.status !== 200) continue;
    const leaked = (r.json?.data?.assayers ?? []).filter((a) => a.panNumber || a.aadhaarNumber || a.bankAccountNumber);
    check(
      `global search does not hand ${role} identity or banking fields`,
      leaked.length === 0,
      leaked.length ? `leaked on ${leaked.length} rows, e.g. ${JSON.stringify(leaked[0]).slice(0, 200)}` : 'no PAN/Aadhaar/bank key present on any assayer row',
    );
  }

  // ---- 1.3 Assignments ----------------------------------------------------
  console.log('\n=== 1.3 Assignments (/assignments) ===\n');
  const ASSIGN_ALL = '/assignments?page=1&limit=200';
  const astat = await sql('SELECT status AS s, count(*)::int AS c FROM assignments GROUP BY 1 ORDER BY 2 DESC');
  console.log('  assignment status in the database: ' + astat.map((l) => `${l.s}=${l.c}`).join(', '));
  for (const { s } of astat.slice(0, 3)) {
    await filterVsSql(
      `assignments filter status=${s}`, ADMIN, ASSIGN_ALL, `/assignments?page=1&limit=200&status=${s}`,
      'SELECT id FROM assignments WHERE status = $1', [s],
    );
  }
  const aprio = await sql('SELECT priority AS s FROM assignments WHERE priority IS NOT NULL GROUP BY 1 LIMIT 2');
  for (const { s } of aprio) {
    await filterVsSql(
      `assignments filter priority=${s}`, ADMIN, ASSIGN_ALL, `/assignments?page=1&limit=200&priority=${s}`,
      'SELECT id FROM assignments WHERE priority = $1', [s],
    );
  }
  // "Unscheduled" is "has no calendar entry" — no active `schedules` row — not "scheduled_date
  // is null". The two disagree on real data, and the calendar is the one the planning screen means.
  await filterVsSql(
    'assignments filter unscheduledOnly=true (no active calendar entry)', ADMIN, ASSIGN_ALL,
    '/assignments?page=1&limit=200&unscheduledOnly=true',
    'SELECT a.id FROM assignments a WHERE NOT EXISTS (SELECT 1 FROM schedules s WHERE s.assignment_id = a.id AND s.is_active = true)',
    [],
  );
  await unknownValue('assignments status=NOT_A_STATUS narrows or refuses', ADMIN, ASSIGN_ALL, '/assignments?page=1&limit=200&status=NOT_A_STATUS');
  await unknownValue('assignments priority=9999 narrows or refuses', ADMIN, ASSIGN_ALL, '/assignments?page=1&limit=200&priority=9999');
  await unknownKey('assignments', ADMIN, ASSIGN_ALL, '/assignments?page=1&limit=200&zzUnknownFilter=zzz');
  await walkPages('assignments pagination — 3 pages x 3', ADMIN, (p, l) => `/assignments?page=${p}&limit=${l}`, 3, 3);
  if (astat[0]) {
    await walkPages(`assignments pagination under status=${astat[0].s}`, ADMIN,
      (p, l) => `/assignments?page=${p}&limit=${l}&status=${astat[0].s}`, 2, 3);
  }
  await adversarial('/assignments', ADMIN, (o) => {
    const q = new URLSearchParams({ page: '1', limit: '200' });
    if (o.zzUnknownFilter) q.set('zzUnknownFilter', o.zzUnknownFilter);
    if (o.typeConfusion) q.set('status', '12345');
    if (o.page !== undefined) q.set('page', String(o.page));
    if (o.limit !== undefined) q.set('limit', String(o.limit));
    if (o.q !== undefined) q.set('status', o.q);
    return `/assignments?${q}`;
  });

  // ---- 1.4 Branches -------------------------------------------------------
  console.log('\n=== 1.4 Branches (/branches) ===\n');
  const BR_ALL = '/branches?limit=1000';
  const brRegions = await sql('SELECT region AS s FROM branches WHERE region IS NOT NULL GROUP BY 1 LIMIT 2');
  for (const { s } of brRegions) {
    await filterVsSql(
      `branches filter region=${s}`, ADMIN, BR_ALL, `/branches?limit=1000&region=${s}`,
      'SELECT id FROM branches WHERE region = $1', [s],
    );
  }
  const brState = await one('SELECT state FROM branches WHERE state IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 1');
  if (brState) {
    await filterVsSql(
      `branches filter state=${brState.state}`, ADMIN, BR_ALL, `/branches?limit=1000&state=${encodeURIComponent(brState.state)}`,
      'SELECT id FROM branches WHERE state = $1', [brState.state],
    );
  }
  const brClient = await one('SELECT client_id FROM branches WHERE client_id IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 1');
  if (brClient) {
    await filterVsSql(
      'branches filter clientId', ADMIN, BR_ALL, `/branches?limit=1000&clientId=${brClient.client_id}`,
      'SELECT id FROM branches WHERE client_id = $1', [brClient.client_id],
    );
  }
  const brName = await one("SELECT name FROM branches WHERE name IS NOT NULL AND length(name) > 6 ORDER BY name LIMIT 1");
  if (brName) {
    const frag = brName.name.slice(1, 6);
    await filterVsSql(
      `branches filter search=${JSON.stringify(frag)}`, ADMIN, BR_ALL, `/branches?limit=1000&search=${encodeURIComponent(frag)}`,
      "SELECT id FROM branches WHERE name ILIKE $1 OR sol_id ILIKE $1 OR city ILIKE $1 OR COALESCE(district,'') ILIKE $1 OR COALESCE(pincode,'') ILIKE $1",
      [`%${frag}%`],
    );
  }
  await unknownValue('branches region=ATLANTIS narrows or refuses', ADMIN, BR_ALL, '/branches?limit=1000&region=ATLANTIS');
  await unknownKey('branches', ADMIN, BR_ALL, '/branches?limit=1000&zzUnknownFilter=zzz');
  await walkPages('branches pagination — 3 pages x 3', ADMIN, (p, l) => `/branches?page=${p}&limit=${l}`, 3, 3);
  await adversarial('/branches', ADMIN, (o) => {
    const q = new URLSearchParams({ limit: '1000' });
    if (o.zzUnknownFilter) q.set('zzUnknownFilter', o.zzUnknownFilter);
    if (o.typeConfusion) q.set('region', '12345');
    if (o.page !== undefined) q.set('page', String(o.page));
    if (o.limit !== undefined) q.set('limit', String(o.limit));
    if (o.q !== undefined) q.set('search', o.q);
    return `/branches?${q}`;
  });

  // ---- 1.5 Clients: the one surface with a declared sort -------------------
  console.log('\n=== 1.5 Clients (/clients) — filter AND sort ===\n');
  const CL_ALL = '/clients?page=1&limit=200';
  const clStatus = await sql('SELECT lifecycle_status AS s FROM clients GROUP BY 1');
  for (const { s } of clStatus) {
    await filterVsSql(
      `clients filter status=${s}`, ADMIN, CL_ALL, `/clients?page=1&limit=200&status=${s}`,
      'SELECT id FROM clients WHERE lifecycle_status = $1', [s],
    );
  }
  const clName = await one('SELECT name FROM clients WHERE name IS NOT NULL ORDER BY name LIMIT 1');
  if (clName) {
    const frag = clName.name.slice(1, 5);
    await filterVsSql(
      `clients filter search=${JSON.stringify(frag)}`, ADMIN, CL_ALL, `/clients?page=1&limit=200&search=${encodeURIComponent(frag)}`,
      "SELECT id FROM clients WHERE name ILIKE $1 OR COALESCE(client_code,'') ILIKE $1 OR COALESCE(display_name,'') ILIKE $1 OR COALESCE(contact_person,'') ILIKE $1 OR COALESCE(contact_email,'') ILIKE $1",
      [`%${frag}%`],
    );
  }
  await sortVsSql(
    'clients sort by name', ADMIN,
    (dir) => `/clients?page=1&limit=200&sortBy=name&sortOrder=${dir}`,
    (dir) => `SELECT id FROM clients ORDER BY name ${dir}`,
    'name',
  );
  // A nullable column: where do NULLs land, and does the answer stay consistent between
  // directions? Postgres defaults to NULLS LAST for ASC and NULLS FIRST for DESC, so an
  // ordering that is merely "ORDER BY col dir" moves the empty rows from one end to the other.
  const nullable = await one(
    "SELECT count(*) FILTER (WHERE priority IS NULL)::int AS nulls, count(*)::int AS total FROM clients",
  );
  console.log(`  clients.priority: ${nullable.nulls} NULL of ${nullable.total}`);
  if (nullable.nulls > 0 && nullable.nulls < nullable.total) {
    for (const dir of ['ASC', 'DESC']) {
      const r = await hit(`/clients?page=1&limit=200&sortBy=priority&sortOrder=${dir}`, { token: ADMIN });
      const vals = rowsOf(r).map((x) => x.priority ?? null);
      const firstNull = vals.indexOf(null);
      const lastNonNull = vals.map((v, i) => (v == null ? -1 : i)).reduce((a, b) => Math.max(a, b), -1);
      console.log(`  sortBy=priority&sortOrder=${dir} -> ${JSON.stringify(vals)}  (NULLs ${firstNull === 0 ? 'first' : firstNull === -1 ? 'absent' : 'last'})`);
    }
  } else {
    check('clients sort over a nullable column', null,
      `clients.priority has ${nullable.nulls} NULL of ${nullable.total} rows — no mixed NULL/non-NULL set to sort, so where NULLs land cannot be observed through the API on this data`);
    /**
     * What can still be established is the ordering the endpoint emits.
     *
     * `ClientService.findAll` builds `.orderBy('client.' + sortBy, sortOrder)` with no NULLS
     * clause, so the answer to "where do NULLs land" is whatever Postgres does by default for
     * that shape. Measured here rather than asserted, on a values list rather than on the
     * product's data — and reported as a property of the ordering, not as a product observation.
     */
    const asc = (await sql('SELECT v FROM (VALUES (1),(NULL),(2)) t(v) ORDER BY v ASC')).map((r) => r.v);
    const desc = (await sql('SELECT v FROM (VALUES (1),(NULL),(2)) t(v) ORDER BY v DESC')).map((r) => r.v);
    console.log(
      `  the ordering this endpoint emits is a bare "ORDER BY col dir": ASC -> ${JSON.stringify(asc)}, DESC -> ${JSON.stringify(desc)} `
      + '— NULLs land last ascending and first descending, so they change ends when the direction flips.',
    );
  }
  // Unknown sort key: allow-listed, or interpolated into ORDER BY?
  {
    const goodOrder = idsOf(await hit('/clients?page=1&limit=200&sortBy=name&sortOrder=ASC', { token: ADMIN }));
    const bogus = await hit('/clients?page=1&limit=200&sortBy=zzNotAColumn&sortOrder=ASC', { token: ADMIN });
    const inject = await hit(`/clients?page=1&limit=200&sortBy=${encodeURIComponent("name; DROP TABLE clients --")}`, { token: ADMIN });
    const injOrder = await hit(`/clients?page=1&limit=200&sortOrder=${encodeURIComponent("ASC; SELECT 1")}`, { token: ADMIN });
    check(
      'clients sortBy is allow-listed (unknown key falls back, never reaches ORDER BY)',
      bogus.status === 200 && inject.status < 500 && injOrder.status < 500,
      `sortBy=zzNotAColumn -> ${brief(bogus, 90)}; sortBy=<injection> -> ${brief(inject, 90)}; sortOrder=<injection> -> ${brief(injOrder, 90)}`,
    );
    check(
      'clients still exists after the ORDER BY injection attempt',
      (await one('SELECT count(*)::int AS c FROM clients')).c === nullable.total,
      `clients row count is still ${nullable.total}`,
    );
    check(
      'clients unknown sortBy falls back to the default order rather than an arbitrary one',
      JSON.stringify(idsOf(bogus)) === JSON.stringify(goodOrder),
      `sortBy=zzNotAColumn produced ${idsOf(bogus).length} rows; default (name ASC) order match=${JSON.stringify(idsOf(bogus)) === JSON.stringify(goodOrder)}`,
    );
  }
  await unknownValue('clients status=NOT_A_STATUS narrows or refuses', ADMIN, CL_ALL, '/clients?page=1&limit=200&status=NOT_A_STATUS');
  await unknownKey('clients', ADMIN, CL_ALL, '/clients?page=1&limit=200&zzUnknownFilter=zzz');
  await adversarial('/clients', ADMIN, (o) => {
    const q = new URLSearchParams({ page: '1', limit: '200' });
    if (o.zzUnknownFilter) q.set('zzUnknownFilter', o.zzUnknownFilter);
    if (o.typeConfusion) q.set('status', '12345');
    if (o.page !== undefined) q.set('page', String(o.page));
    if (o.limit !== undefined) q.set('limit', String(o.limit));
    if (o.q !== undefined) q.set('search', o.q);
    return `/clients?${q}`;
  });

  // ---- 1.6 Billing: payouts, lines, invoices ------------------------------
  console.log('\n=== 1.6 Billing lists ===\n');
  const PAY_ALL = '/billing-engine/payouts?page=1&limit=100';
  const payStatus = await sql('SELECT status AS s FROM assayer_payables GROUP BY 1');
  for (const { s } of payStatus) {
    await filterVsSql(
      `payouts filter status=${s}`, ADMIN, PAY_ALL, `/billing-engine/payouts?page=1&limit=100&status=${s}`,
      'SELECT id FROM assayer_payables WHERE status = $1', [s],
    );
  }
  const payAssayer = await one('SELECT assayer_id FROM assayer_payables WHERE assayer_id IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 1');
  if (payAssayer) {
    await filterVsSql(
      'payouts filter assayerId', ADMIN, PAY_ALL, `/billing-engine/payouts?page=1&limit=100&assayerId=${payAssayer.assayer_id}`,
      'SELECT id FROM assayer_payables WHERE assayer_id = $1', [payAssayer.assayer_id],
    );
  }
  await filterVsSql(
    'payouts filter onHold=true', ADMIN, PAY_ALL, '/billing-engine/payouts?page=1&limit=100&onHold=true',
    'SELECT id FROM assayer_payables WHERE on_hold = true', [],
  );
  await unknownValue('payouts status=NOT_A_STATUS refuses', ADMIN, PAY_ALL, '/billing-engine/payouts?page=1&limit=100&status=NOT_A_STATUS');
  await unknownKey('payouts', ADMIN, PAY_ALL, '/billing-engine/payouts?page=1&limit=100&zzUnknownFilter=zzz');
  await walkPages('payouts pagination — 3 pages x 3', ADMIN, (p, l) => `/billing-engine/payouts?page=${p}&limit=${l}`, 3, 3);

  const LINE_ALL = '/billing-engine/lines?page=1&limit=100';
  const lineState = await sql('SELECT state AS s FROM billing_entries GROUP BY 1');
  for (const { s } of lineState) {
    await filterVsSql(
      `billing lines filter state=${s}`, ADMIN, LINE_ALL, `/billing-engine/lines?page=1&limit=100&state=${s}`,
      'SELECT id FROM billing_entries WHERE state = $1', [s],
    );
  }
  await walkPages('billing lines pagination — 3 pages x 3', ADMIN, (p, l) => `/billing-engine/lines?page=${p}&limit=${l}`, 3, 3);
  await adversarial('/billing-engine/lines', ADMIN, (o) => {
    const q = new URLSearchParams({ page: '1', limit: '100' });
    if (o.zzUnknownFilter) q.set('zzUnknownFilter', o.zzUnknownFilter);
    if (o.typeConfusion) q.set('state', '12345');
    if (o.page !== undefined) q.set('page', String(o.page));
    if (o.limit !== undefined) q.set('limit', String(o.limit));
    if (o.q !== undefined) q.set('state', o.q);
    return `/billing-engine/lines?${q}`;
  });

  // ---- 1.7 Documents, data-entry queues, notifications, users -------------
  console.log('\n=== 1.7 Documents / data-entry queues / notifications / users ===\n');
  await walkPages('documents pagination — 3 pages x 3 (limit/offset)', ADMIN,
    (p, l) => `/documents?limit=${l}&offset=${(p - 1) * l}`, 3, 3);
  await unknownKey('documents', ADMIN, '/documents?limit=1000', '/documents?limit=1000&zzUnknownFilter=zzz');

  for (const q of ['/documents/data-entry/queue', '/documents/data-entry/mine']) {
    const r = await hit(`${q}?page=1&limit=20`, { token: ADMIN });
    check(`${q} responds`, r.status === 200, brief(r, 140));
    const bogus = await hit(`${q}?page=1&limit=20&lane=NOT_A_LANE`, { token: ADMIN });
    const baseN = rowsOf(r).length;
    check(
      `${q} lane=NOT_A_LANE narrows or refuses`,
      bogus.status >= 400 || rowsOf(bogus).length === 0 || rowsOf(bogus).length < baseN || baseN === 0,
      `base rows=${baseN}; lane=NOT_A_LANE -> ${brief(bogus, 110)} rows=${rowsOf(bogus).length}`,
    );
  }

  const NOTIF_ALL = '/notifications?limit=200';
  await filterVsSql(
    'notifications filter unreadOnly=true', ADMIN, NOTIF_ALL, '/notifications?limit=200&unreadOnly=true',
    'SELECT id FROM notifications WHERE is_read = false', [],
  );
  const ncat = await one('SELECT category FROM notifications WHERE category IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 1');
  if (ncat) {
    await filterVsSql(
      `notifications filter category=${ncat.category}`, ADMIN, NOTIF_ALL, `/notifications?limit=200&category=${ncat.category}`,
      'SELECT id FROM notifications WHERE category = $1', [ncat.category],
    );
  }
  await unknownValue('notifications category=NOT_A_CATEGORY narrows or refuses', ADMIN, NOTIF_ALL, '/notifications?limit=200&category=NOT_A_CATEGORY');
  await walkPages('notifications pagination — 3 pages x 1 (limit/offset)', ADMIN,
    (p, l) => `/notifications?limit=${l}&offset=${(p - 1) * l}`, 1, 3);

  await walkPages('users pagination — 3 pages x 3', ADMIN, (p, l) => `/users?page=${p}&limit=${l}`, 3, 3);
  await unknownKey('users', ADMIN, '/users?page=1&limit=200', '/users?page=1&limit=200&zzUnknownFilter=zzz');
  await adversarial('/users', ADMIN, (o) => {
    const q = new URLSearchParams({ page: '1', limit: '200' });
    if (o.zzUnknownFilter) q.set('zzUnknownFilter', o.zzUnknownFilter);
    if (o.typeConfusion) q.set('status', '12345');
    if (o.page !== undefined) q.set('page', String(o.page));
    if (o.limit !== undefined) q.set('limit', String(o.limit));
    if (o.q !== undefined) q.set('search', o.q);
    return `/users?${q}`;
  });

  // ---- 1.8 Sort: which surfaces offer one at all? -------------------------
  console.log('\n=== 1.8 Does an ordering parameter exist beyond /clients? ===\n');
  const sortProbe = [
    ['/assayers', '/assayers?limit=1000'],
    ['/assignments', '/assignments?page=1&limit=200'],
    ['/branches', '/branches?limit=1000'],
    ['/projects', '/projects?page=1&limit=200'],
    ['/users', '/users?page=1&limit=200'],
    ['/billing-engine/payouts', '/billing-engine/payouts?page=1&limit=100'],
    ['/billing-engine/lines', '/billing-engine/lines?page=1&limit=100'],
    ['/documents', '/documents?limit=200'],
    ['/notifications', '/notifications?limit=200'],
  ];
  const noSort = [];
  for (const [name, base] of sortProbe) {
    const plain = await hit(base, { token: ADMIN });
    if (plain.status !== 200) { console.log(`  ${name.padEnd(30)} base HTTP ${plain.status} — skipped`); continue; }
    const asc = await hit(`${base}&sortBy=createdAt&sortOrder=ASC`, { token: ADMIN });
    const desc = await hit(`${base}&sortBy=createdAt&sortOrder=DESC`, { token: ADMIN });
    const a = JSON.stringify(idsOf(asc));
    const d = JSON.stringify(idsOf(desc));
    const p = JSON.stringify(idsOf(plain));
    const honoured = asc.status === 200 && desc.status === 200 && a !== d;
    const refused = asc.status === 400 || desc.status === 400;
    console.log(
      `  ${name.padEnd(30)} sortBy/sortOrder: ${refused ? `REFUSED (${asc.status}/${desc.status})` : honoured ? 'HONOURED' : 'IGNORED (same order both directions)'}`
      + `${!refused && !honoured && a === p ? ' — identical to the unsorted call' : ''}`,
    );
    if (!honoured && !refused) noSort.push(name);
  }
  if (noSort.length) {
    finding(
      'SXP-S1', 'MEDIUM',
      'Only /clients has a working sort; every other list surface silently ignores sortBy/sortOrder',
      `GET ${API}/assayers?limit=1000&sortBy=createdAt&sortOrder=ASC  vs  ...&sortOrder=DESC`,
      `${noSort.length} surfaces returned the identical row order for ASC and DESC, and HTTP 200 in both cases: ${noSort.join(', ')}`,
      'Silently ignored, not refused — so a caller (or a column header in a future UI) that asks for an ordering '
      + 'gets a 200 and the wrong order, with nothing to distinguish it from a working sort.',
    );
  }

  // ---- 1.9 Combined filter + sort + page ---------------------------------
  console.log('\n=== 1.9 Filter + sort + page together ===\n');
  if (clStatus[0]) {
    const s = clStatus[0].s;
    const r1 = await hit(`/clients?page=1&limit=1&status=${s}&sortBy=name&sortOrder=ASC`, { token: ADMIN });
    const r2 = await hit(`/clients?page=2&limit=1&status=${s}&sortBy=name&sortOrder=ASC`, { token: ADMIN });
    const expected = (await sql(
      'SELECT id, name FROM clients WHERE lifecycle_status = $1 ORDER BY name ASC', [s],
    ));
    const got = [...idsOf(r1), ...idsOf(r2)];
    check(
      `clients filter+sort+page (status=${s}, name ASC, 2 pages of 1)`,
      got.length > 0 && got.every((id, i) => expected[i] && expected[i].id === id),
      `API pages -> ${JSON.stringify(rowsOf(r1).concat(rowsOf(r2)).map((x) => x.name))}; SQL -> ${JSON.stringify(expected.slice(0, 4).map((x) => x.name))}`,
    );
  }
  if (lifecycles[0]) {
    const s = lifecycles[0].s;
    const w = await walkPages(`roster filter+page (lifecycleStatus=${s}, 3 pages x 2)`, ADMIN,
      (p, l) => `/assayers?page=${p}&limit=${l}&lifecycleStatus=${s}`, 2, 3);
    if (w && !w.ok) {
      finding(
        'SXP-P1', 'HIGH', 'Paging a filtered roster drops or repeats rows',
        `GET ${API}/assayers?page=1..3&limit=2&lifecycleStatus=${s}`,
        `3 pages of 2 produced ${w.seen.size} distinct ids where ${w.expectedWindow} were expected${w.dup ? `; id ${w.dup.id} appeared on pages ${w.dup.first} and ${w.dup.again}` : ''}`,
      );
    }
  }

  // ---- 1.10 One finding per defect class, not one per route --------------
  console.log('\n=== 1.10 Consolidated defect classes ===\n');

  if (serverErrors.length) {
    // Which hostile input produced the 500 matters more than which route did, because the same
    // input produces it on every route that shares the pattern.
    const byInput = new Map();
    for (const e of serverErrors) {
      if (!byInput.has(e.label)) byInput.set(e.label, []);
      byInput.get(e.label).push(e.surface);
    }
    finding(
      'SXP-A1', 'HIGH',
      'Hostile query-string values reach Postgres unvalidated and come back as HTTP 500',
      [...byInput.entries()].map(([label, s]) => `${label}: ${s.join(', ')}`).join('  ||  '),
      `${serverErrors.length} of the hostile inputs produced a 500. Examples: `
      + serverErrors.slice(0, 4).map((e) => `${e.path} -> ${e.status}`).join(' ; '),
      'The response body is a generic INTERNAL_ERROR with a correlation id — nothing leaks to the caller — but the '
      + 'server log records the underlying QueryFailedError, and a 500 is not a refusal: it is the request '
      + 'reaching the database and the database rejecting it.',
    );
  }

  if (ignoredKeys.length) {
    finding(
      'SXP-A2', 'MEDIUM',
      'An unknown filter key is refused on the billing lists and silently ignored everywhere else',
      ignoredKeys.map((k) => `GET ${API}${k.path}`).join(' ; '),
      `${ignoredKeys.length} surfaces returned the full unfiltered set for a query string carrying an unknown filter `
      + `key: ${ignoredKeys.map((k) => `${k.name} (${k.rows} rows)`).join(', ')}. `
      + 'The billing lists, which bind their query to a DTO, answer 400 to the same request.',
      'A caller who misspells a filter — or uses one this version of the API no longer has — is handed the whole '
      + 'table with a 200 and no way to tell.',
    );
  }

  if (wildcardOpen.length) {
    console.log(`  LIKE wildcards left unescaped on: ${[...new Set(wildcardOpen.map((w) => w.surface))].join(', ')}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 2. EXPORT AND REPORT
// ══════════════════════════════════════════════════════════════════════════

/** Read an xlsx buffer into { sheetName: rows[][] }. */
function readWorkbook(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const out = {};
  for (const name of wb.SheetNames) out[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null });
  return out;
}

const csvRows = (text) => text.split('\n').filter((l) => l.trim().length).map((l) => l.split(','));

/**
 * The masking rule under test, stated once.
 *
 * `maskTail` leaves the last four characters and replaces the rest, so a masked PAN looks like
 * `XXXXXX1234` and a clear one does not. "Clear" here means: the value the database holds,
 * character for character.
 */
const looksMasked = (v) => typeof v === 'string' && /^[X*••]{2,}/.test(v);

async function phaseExport() {
  console.log('\n\n════ 2. EXPORT AND REPORT ════\n');
  const ADMIN = P.ADMIN.token;

  // ---- 2.1 Does the export contain the same rows as the screen? -----------
  console.log('\n=== 2.1 Export contents vs the screen they came from ===\n');

  const rosterScreen = await hit('/assayers?limit=1000', { token: ADMIN });
  const rosterTotal = totalOf(rosterScreen) ?? idsOf(rosterScreen).length;
  const rosterCsv = await hit('/assayers/export', { token: ADMIN, accept: 'text/csv' });
  const csv = csvRows(rosterCsv.text ?? '');
  check(
    'roster CSV export row count equals the roster screen',
    rosterCsv.status === 200 && csv.length - 1 === rosterTotal,
    `GET /assayers/export -> HTTP ${rosterCsv.status}, ${csv.length - 1} data rows (header: ${csv[0]?.join(',')}); GET /assayers?limit=1000 -> total=${rosterTotal}`,
  );

  // The same export under the same filter as the screen.
  const lc = await one('SELECT lifecycle_status AS s, count(*)::int AS c FROM assayers GROUP BY 1 ORDER BY 2 DESC LIMIT 1');
  if (lc) {
    const screen = await hit(`/assayers?limit=1000&lifecycleStatus=${lc.s}`, { token: ADMIN });
    const exp = await hit(`/assayers/export?lifecycleStatus=${lc.s}`, { token: ADMIN, accept: 'text/csv' });
    const rows = csvRows(exp.text ?? '');
    const screenTotal = totalOf(screen) ?? idsOf(screen).length;
    check(
      `roster CSV export honours ?lifecycleStatus=${lc.s}`,
      exp.status === 200 && rows.length - 1 === screenTotal,
      `GET /assayers/export?lifecycleStatus=${lc.s} -> ${rows.length - 1} data rows; the screen with the same filter -> ${screenTotal}`,
    );
    if (exp.status === 200 && rows.length - 1 !== screenTotal) {
      finding(
        'SXP-E1', 'HIGH', 'The roster CSV export ignores the filter the screen was showing',
        `GET ${API}/assayers/export?lifecycleStatus=${lc.s}   (compare GET ${API}/assayers?limit=1000&lifecycleStatus=${lc.s})`,
        `export delivered ${rows.length - 1} rows; the filtered screen shows ${screenTotal} of ${rosterTotal} total`,
      );
    }
  }

  // An empty result set.
  {
    const exp = await hit('/assayers/export?lifecycleStatus=ARCHIVED&state=Atlantis', { token: ADMIN, accept: 'text/csv' });
    const rows = csvRows(exp.text ?? '');
    check(
      'roster CSV export on an empty result set returns a header and no rows, not an error',
      exp.status === 200 && rows.length === 1,
      `HTTP ${exp.status}, ${rows.length} line(s): ${JSON.stringify((exp.text ?? '').slice(0, 120))}`,
    );
  }

  // The assignment book.
  {
    const screen = await hit('/assignments?page=1&limit=200', { token: ADMIN });
    const book = await hit('/reports/assignments', { token: ADMIN });
    check('assignment book export returns a workbook', book.status === 200 && book.buf.length > 0, `HTTP ${book.status} ${book.buf.length} bytes ${book.ct} ${book.disposition ?? ''}`);
    if (book.status === 200) {
      const wb = readWorkbook(book.buf);
      const sheet = Object.keys(wb)[0];
      const dataRows = (wb[sheet] ?? []).length - 1;
      check(
        'assignment book export row count equals the assignments screen',
        dataRows === (totalOf(screen) ?? idsOf(screen).length),
        `sheets=${Object.keys(wb).join('|')}; ${sheet} has ${dataRows} data rows; the screen shows total=${totalOf(screen)}`,
      );
      const stat = await one('SELECT status AS s, count(*)::int AS c FROM assignments GROUP BY 1 ORDER BY 2 DESC LIMIT 1');
      const filtered = await hit(`/reports/assignments?status=${stat.s}`, { token: ADMIN });
      const fRows = filtered.status === 200 ? (readWorkbook(filtered.buf)[sheet] ?? []).length - 1 : null;
      const fScreen = totalOf(await hit(`/assignments?page=1&limit=200&status=${stat.s}`, { token: ADMIN }));
      check(
        `assignment book export honours ?status=${stat.s}`,
        fRows === fScreen,
        `GET /reports/assignments?status=${stat.s} -> ${fRows} rows; the filtered screen -> ${fScreen}; unfiltered -> ${dataRows}`,
      );
      if (fRows !== null && fRows === dataRows && fScreen !== dataRows) {
        finding(
          'SXP-E2', 'HIGH', 'The assignment book export ignores its status filter',
          `GET ${API}/reports/assignments?status=${stat.s}`,
          `returned ${fRows} rows — the same as the unfiltered export — where the filtered screen shows ${fScreen}`,
        );
      }
    }
  }

  // The billing workbook.
  {
    const book = await hit('/reports/billing', { token: ADMIN });
    check('billing workbook export returns a workbook', book.status === 200 && book.buf.length > 0, `HTTP ${book.status} ${book.buf.length} bytes`);
    if (book.status === 200) {
      const wb = readWorkbook(book.buf);
      const lines = (wb['Client Lines'] ?? [])?.length - 1;
      const dbLines = (await one('SELECT count(*)::int AS c FROM billing_entries')).c;
      check(
        'billing workbook Client Lines equals the billing lines screen',
        lines === (totalOf(await hit('/billing-engine/lines?page=1&limit=100', { token: ADMIN })) ?? dbLines),
        `sheets=${Object.keys(wb).join('|')}; Client Lines has ${lines} data rows; billing_entries has ${dbLines}`,
      );
      check(
        'billing workbook has no truncation Notice sheet below the 5,000-line cap',
        !Object.keys(wb).includes('Notice'),
        `sheets=${Object.keys(wb).join('|')} at ${dbLines} client lines`,
      );
      const st = await one('SELECT state FROM billing_entries GROUP BY 1 ORDER BY count(*) DESC LIMIT 1');
      if (st) {
        const f = await hit(`/reports/billing?state=${st.state}`, { token: ADMIN });
        const fLines = f.status === 200 ? (readWorkbook(f.buf)['Client Lines'] ?? []).length - 1 : null;
        const dbF = (await one('SELECT count(*)::int AS c FROM billing_entries WHERE state = $1', [st.state])).c;
        check(
          `billing workbook honours ?state=${st.state}`, fLines === dbF,
          `GET /reports/billing?state=${st.state} -> ${fLines} rows; SQL -> ${dbF}; unfiltered -> ${lines}`,
        );
      }
    }
    // The documented cap. It cannot be crossed at this volume; say so rather than imply a pass.
    const total = (await one('SELECT count(*)::int AS c FROM billing_entries')).c;
    check(
      'billing workbook 5,000-line cap is exercised', null,
      `billing_entries holds ${total} rows — the cap cannot be crossed on this database, so "exceeding it is reported rather than silently truncated" is UNVERIFIED here`,
    );
  }

  // Command centre and roster workbooks.
  for (const [name, path] of [['command centre', '/reports/command-center'], ['assayer roster', '/reports/assayer-roster']]) {
    const r = await hit(path, { token: ADMIN });
    check(`${name} export returns a workbook`, r.status === 200 && r.buf.length > 0,
      `GET ${path} -> HTTP ${r.status} ${r.buf.length} bytes ${r.disposition ?? ''}`);
    if (r.status === 200) console.log(`     sheets: ${Object.keys(readWorkbook(r.buf)).join(' | ')}`);
  }

  // TDS report.
  {
    const r = await hit('/billing-engine/tds-report', { token: ADMIN });
    check('TDS report responds', r.status === 200, brief(r, 200));
    const bogus = await hit('/billing-engine/tds-report?from=banana&to=%25', { token: ADMIN });
    check('TDS report refuses or survives a malformed date window', bogus.status < 500, brief(bogus, 160));
  }

  // ---- 2.2 THE PII CHECK: do exports leak what the screen masks? ----------
  console.log('\n=== 2.2 Sensitive fields in exports (PAN / Aadhaar / bank account) ===\n');

  const truth = await one(
    `SELECT id, assayer_code, pan_number, aadhaar_number, bank_account_number, ifsc_code, bank_name,
            account_holder_name, date_of_birth, notes, emergency_contact_phone
       FROM assayers
      WHERE pan_number IS NOT NULL OR aadhaar_number IS NOT NULL OR bank_account_number IS NOT NULL
      ORDER BY assayer_code LIMIT 1`,
  ).catch(() => null);
  const truthRow = truth ?? await one('SELECT id, assayer_code, pan_number, aadhaar_number, bank_account_number FROM assayers ORDER BY assayer_code LIMIT 1');
  console.log(`  reference row: ${truthRow?.assayer_code} pan=${JSON.stringify(truthRow?.pan_number)} aadhaar=${JSON.stringify(truthRow?.aadhaar_number)} bank=${JSON.stringify(truthRow?.bank_account_number)}`);

  /**
   * The columns are `enc:v1:` ciphertext at rest, so the database is not where the clear value
   * is. The product has exactly one route that returns it — `GET /assayers/:id/sensitive/:field`,
   * the audited reveal — so that is where the comparison value comes from. Comparing an export
   * against the ciphertext would prove nothing: the ciphertext is not what leaks.
   */
  const clearValues = [];
  // The route names the fields `pan | aadhaar | bank`; the export columns name them
  // `panNumber | aadhaarNumber | bankAccountNumber`. Same three facts, two vocabularies.
  for (const [routeField, column] of [['pan', 'panNumber'], ['aadhaar', 'aadhaarNumber'], ['bank', 'bankAccountNumber']]) {
    const rev = await hit(`/assayers/${truthRow.id}/sensitive/${routeField}`, { token: ADMIN });
    const d = rev.json?.data ?? null;
    const v = typeof d === 'string' ? d : (d?.value ?? d?.[column] ?? d?.[routeField] ?? null);
    if (typeof v === 'string' && v.length > 4 && !v.startsWith('enc:')) clearValues.push([column, v]);
    console.log(`  audited reveal GET /assayers/:id/sensitive/${routeField} -> HTTP ${rev.status} ${typeof v === 'string' ? `a value of ${v.length} characters` : JSON.stringify(d).slice(0, 120)}`);
  }
  check(
    'the audited reveal route yields at least one clear value to compare exports against',
    clearValues.length > 0,
    clearValues.length ? `${clearValues.map(([f]) => f).join(', ')} obtained in the clear` : 'no clear value available — the PII leak check below would be vacuous',
  );

  const SENSITIVE_COLUMNS = 'assayerCode,panNumber,aadhaarNumber,bankAccountNumber,ifscCode,bankName,accountHolderName,dateOfBirth,notes,emergencyContactPhone';
  const payrollLeak = [];

  for (const role of ['ADMIN', 'OPERATIONS', 'AUDITOR', 'DESK', 'DESK_OPERATOR', 'DEVELOPER', 'CLIENT_USER']) {
    const p = P[role];
    if (!p?.alive) { check(`export PII — ${role}`, null, 'no live token'); continue; }

    // What the screen shows this role.
    const screen = await hit(`/assayers/${truthRow.id}`, { token: p.token });
    const scr = screen.json?.data ?? {};
    const screenState = (f) => (screen.status !== 200 ? `HTTP ${screen.status}`
      : !(f in scr) ? 'ABSENT' : looksMasked(scr[f]) ? `MASKED(${scr[f]})` : `CLEAR(${scr[f]})`);

    // What the CSV export hands it, when it asks for the same columns by name.
    const exp = await hit(`/assayers/export?columns=${SENSITIVE_COLUMNS}`, { token: p.token, accept: 'text/csv' });
    if (exp.status !== 200) {
      check(`export PII — ${role} is refused the roster CSV`, exp.status === 403 || exp.status === 401,
        `GET /assayers/export?columns=<sensitive> -> ${brief(exp, 140)}`);
      continue;
    }
    const rows = csvRows(exp.text ?? '');
    const header = rows[0] ?? [];
    const mine = rows.slice(1).find((r) => r[header.indexOf('assayerCode')] === truthRow.assayer_code) ?? [];
    const exportState = (f) => {
      const i = header.indexOf(f);
      const v = i >= 0 ? mine[i] : undefined;
      return v === undefined || v === '' ? 'EMPTY' : looksMasked(v) ? `MASKED(${v})` : `CLEAR(${v})`;
    };

    const report = ['panNumber', 'aadhaarNumber', 'bankAccountNumber', 'ifscCode', 'bankName', 'accountHolderName', 'dateOfBirth', 'notes', 'emergencyContactPhone']
      .map((f) => `${f}: screen=${screenState(f)} export=${exportState(f)}`);
    console.log(`  ${role}:\n     ` + report.join('\n     '));

    // The defect being hunted: a field the screen masks or withholds arriving whole in a file.
    const leaked = [];
    for (const [field, clear] of clearValues) {
      const i = header.indexOf(field);
      const v = i >= 0 ? mine[i] : undefined;
      if (v && v === clear) {
        const onScreen = screenState(field);
        if (!onScreen.startsWith('CLEAR')) leaked.push(`${field} — screen ${onScreen}, export CLEAR(${v})`);
      }
    }
    check(
      `roster CSV export gives ${role} no field in the clear that the screen masks or withholds`,
      leaked.length === 0,
      leaked.length ? leaked.join(' || ') : `checked ${clearValues.map(([f]) => f).join(', ')} against GET /assayers/${truthRow.id}`,
    );
    if (leaked.length) {
      finding(
        'SXP-E3', 'BLOCKER', `The roster CSV export hands ${role} sensitive fields in the clear that the screen masks`,
        `GET ${API}/assayers/export?columns=${SENSITIVE_COLUMNS}   as ${p.username}`,
        leaked.join(' || '),
        'The export writes rows to the response itself, so the response-shaping stage that masks the screen never sees them.',
      );
    }

    // The same question of the spreadsheet.
    const wbr = await hit('/reports/assayer-roster', { token: p.token });
    if (wbr.status === 200) {
      const wb = readWorkbook(wbr.buf);
      const flat = JSON.stringify(wb);
      const inWorkbook = clearValues.filter(([, v]) => flat.includes(v));
      check(
        `assayer-roster workbook gives ${role} no PAN/Aadhaar/bank value in the clear`,
        inWorkbook.length === 0,
        inWorkbook.length ? `values present: ${inWorkbook.map(([f]) => f).join(', ')}` : `sheets=${Object.keys(wb).join('|')}; none of the reference row's sensitive values appear`,
      );
      /**
       * Compensation is its own category of sensitive, and it is the one this workbook carries
       * in full: a "Pay Roll" sheet with every assayer's base fee, daily rate and allowances.
       * So ask the same question of it as of PAN — can this role see those numbers on screen?
       */
      const payroll = wb['Pay Roll'] ?? [];
      const payrollRows = payroll.slice(1);
      // Postgres `numeric` arrives as a string through the driver, so a rate can land in the
      // sheet as "1500.00" rather than 1500. Both are the figure; only null is its absence.
      const isFigure = (c) => c != null && c !== '' && Number.isFinite(Number(c)) && Number(c) > 0;
      const withMoney = payrollRows.filter((r) => r.slice(2, 8).some(isFigure));
      const rosterScreen = await hit('/assayers/commercial/roster', { token: p.token });
      const oneScreen = await hit(`/assayers/${truthRow.id}/commercial/active`, { token: p.token });
      console.log(
        `     ${role}: /reports/assayer-roster sheets=${Object.keys(wb).join('|')} Roster rows=${(wb.Roster ?? []).length - 1} `
        + `PayRoll rows=${payrollRows.length} (${withMoney.length} carrying a rate)  ||  on screen: `
        + `GET /assayers/commercial/roster -> ${rosterScreen.status}, GET /assayers/:id/commercial/active -> ${oneScreen.status}`,
      );
      const screenRefused = rosterScreen.status === 403 && oneScreen.status === 403;
      check(
        `assayer-roster workbook gives ${role} rate-card figures only if the screen does`,
        !(screenRefused && withMoney.length > 0),
        screenRefused && withMoney.length > 0
          ? `both rate-card routes answer 403, yet the Pay Roll sheet carries ${withMoney.length} rows of real figures, e.g. ${JSON.stringify(withMoney[0])}`
          : `screen ${rosterScreen.status}/${oneScreen.status}; Pay Roll rows with figures: ${withMoney.length}`,
      );
      if (screenRefused && withMoney.length > 0) {
        payrollLeak.push({ role, username: p.username, rows: withMoney.length, sample: withMoney[0] });
      }
    } else {
      console.log(`     ${role}: /reports/assayer-roster -> HTTP ${wbr.status} ${wbr.msg ?? ''}`);
    }
  }

  if (payrollLeak.length) {
    finding(
      'SXP-E6', 'HIGH',
      "The assayer-roster workbook hands roles the whole workforce's pay rates, which the rate-card screens refuse them",
      payrollLeak.map((l) => `GET ${API}/reports/assayer-roster as ${l.username}  (compare GET ${API}/assayers/commercial/roster as the same account -> 403)`).join(' ; '),
      payrollLeak.map((l) => `${l.role}: Pay Roll sheet with ${l.rows} rows carrying figures, e.g. ${JSON.stringify(l.sample)}`).join(' || '),
      'The export route is gated on STAFF_ROLES while the two routes that serve the same numbers to a screen are '
      + 'ADMIN/OPERATIONS only. The workbook is the wider door, and it opens on every assayer at once.',
    );
  }

  /**
   * The TDS report is a PAN-wise statement, which is the whole point of it — and PAN is one of
   * the three fields this product masks on every screen. So it is the sharpest version of this
   * section's question: does a report hand out, in bulk, the identifier the record read masks?
   */
  console.log('\n  -- the TDS report is PAN-wise by design; who gets the PANs, and in what form?');
  const tdsClear = [];
  for (const role of ['ADMIN', 'OPERATIONS', 'AUDITOR', 'DESK', 'DESK_OPERATOR', 'DEVELOPER', 'CLIENT_USER']) {
    const p = P[role];
    if (!p?.alive) continue;
    const r = await hit('/billing-engine/tds-report', { token: p.token });
    if (r.status !== 200) { console.log(`     ${role.padEnd(14)} /billing-engine/tds-report -> HTTP ${r.status} ${r.msg ?? ''}`); continue; }
    const rows = r.json?.data?.rows ?? [];
    const clear = rows.filter((x) => typeof x.pan === 'string' && x.pan && !looksMasked(x.pan));
    console.log(`     ${role.padEnd(14)} HTTP 200, ${rows.length} rows, ${clear.length} with an unmasked PAN${clear[0] ? ` (e.g. ${clear[0].assayerCode} -> ${clear[0].pan})` : ''}`);
    if (!clear.length) continue;

    // What the same account is shown when it asks for that person's record directly.
    const subject = await one('SELECT id FROM assayers WHERE assayer_code = $1', [clear[0].assayerCode]);
    const screen = subject ? await hit(`/assayers/${subject.id}`, { token: p.token }) : null;
    const onScreen = !screen ? 'unknown'
      : screen.status !== 200 ? `HTTP ${screen.status}`
        : !('panNumber' in (screen.json?.data ?? {})) ? 'ABSENT'
          : looksMasked(screen.json.data.panNumber) ? `MASKED(${screen.json.data.panNumber})` : `CLEAR(${screen.json.data.panNumber})`;
    check(
      `TDS report gives ${role} PANs no more freely than the record read does`,
      onScreen.startsWith('CLEAR'),
      `GET /billing-engine/tds-report as ${p.username} -> pan "${clear[0].pan}" for ${clear[0].assayerCode}; `
      + `GET /assayers/${subject?.id} as the same account -> panNumber ${onScreen}`,
    );
    if (!onScreen.startsWith('CLEAR')) {
      tdsClear.push({ role, username: p.username, rows: clear.length, sample: clear[0], onScreen });
    }
  }
  if (tdsClear.length) {
    /**
     * The audited-reveal route writes an `ASSAYER_SENSITIVE_FIELD_REVEALED` row for every single
     * number it hands over. Whether this report does is a before-and-after measurement, not an
     * opinion: count the rows, pull the report, count again.
     */
    const REVEAL = `SELECT count(*)::int AS c FROM audit_events WHERE event_type = 'ASSAYER_SENSITIVE_FIELD_REVEALED'`;
    const before = (await one(REVEAL).catch(() => ({ c: null })))?.c;
    await hit('/billing-engine/tds-report', { token: P[tdsClear[0].role].token });
    await new Promise((s) => setTimeout(s, 1200));
    const after = (await one(REVEAL).catch(() => ({ c: null })))?.c;
    const audited = { c: after == null || before == null ? null : after - before };
    check(
      'a bulk PAN read through the TDS report is recorded in the audit trail',
      audited.c !== null && audited.c > 0,
      `ASSAYER_SENSITIVE_FIELD_REVEALED rows before the call: ${before}; after: ${after} (delta ${audited.c}). `
      + `The report returned ${tdsClear[0].rows} PANs.`,
    );
    finding(
      'SXP-E7', 'HIGH',
      'The TDS report returns every payee PAN in the clear to roles whose record read masks or withholds it',
      tdsClear.map((t) => `GET ${API}/billing-engine/tds-report as ${t.username}`).join(' ; '),
      tdsClear.map((t) => `${t.role}: ${t.rows} rows with an unmasked PAN, e.g. ${t.sample.assayerCode} -> "${t.sample.pan}"; the same account's GET /assayers/:id shows panNumber ${t.onScreen}`).join(' || '),
      'PAN is masked in transit on every record read and has an audited reveal route for the whole value — '
      + `and this report is neither masked nor audited (${audited?.c ?? '?'} new ASSAYER_SENSITIVE_FIELD_REVEALED rows for a call that returned ${tdsClear[0].rows} PANs). `
      + 'AUDITOR is the sharp case: the visibility policy strips identity fields from it entirely, and BILLING_READ_ROLES admits it here.',
    );
  }

  // Payout exports carry the frozen destination bank account.
  for (const role of ['AUDITOR', 'DESK', 'DESK_OPERATOR']) {
    const p = P[role];
    if (!p?.alive) continue;
    const r = await hit('/billing-engine/payouts?page=1&limit=100', { token: p.token });
    if (r.status !== 200) { check(`payout list refuses ${role}`, r.status === 403, `HTTP ${r.status} ${r.msg ?? ''}`); continue; }
    const withBank = rowsOf(r).filter((x) => x.destinationBankAccountNumber && !looksMasked(x.destinationBankAccountNumber));
    check(
      `payout list gives ${role} no destination bank account in the clear`,
      withBank.length === 0,
      withBank.length ? `${withBank.length} of ${rowsOf(r).length} rows carry a clear account number, e.g. ${withBank[0].destinationBankAccountNumber}` : `${rowsOf(r).length} rows, no clear destination account`,
    );
  }

  // ---- 2.3 Do exports respect authorization? -----------------------------
  console.log('\n=== 2.3 Export authorization (403 vs 404 recorded separately) ===\n');
  const EXPORTS = [
    ['/assayers/export', 'roster CSV'],
    ['/reports/assayer-roster', 'roster workbook'],
    ['/reports/assignments', 'assignment book'],
    ['/reports/billing', 'billing workbook'],
    ['/reports/command-center', 'command centre'],
    ['/billing-engine/tds-report', 'TDS report'],
  ];
  const matrix = {};
  for (const role of ['ADMIN', 'OPERATIONS', 'DESK', 'DESK_OPERATOR', 'AUDITOR', 'DEVELOPER', 'CLIENT_USER']) {
    const p = P[role];
    if (!p?.alive) continue;
    matrix[role] = {};
    for (const [path, label] of EXPORTS) {
      const r = await hit(path, { token: p.token });
      matrix[role][label] = r.throttled ? '429/UNKNOWN' : `${r.status}${r.status === 200 ? ` (${r.buf.length}B)` : ''}`;
    }
  }
  console.log('\n  | role | ' + EXPORTS.map(([, l]) => l).join(' | ') + ' |');
  console.log('  |' + '---|'.repeat(EXPORTS.length + 1));
  for (const [role, row] of Object.entries(matrix)) {
    console.log(`  | ${role} | ` + EXPORTS.map(([, l]) => row[l]).join(' | ') + ' |');
  }
  // An unauthenticated caller must never reach an export.
  for (const [path] of EXPORTS) {
    const r = await hit(path, {});
    check(`unauthenticated ${path} is refused`, r.status === 401 || r.status === 403, `HTTP ${r.status} ${r.msg ?? ''}`);
  }
  // CLIENT_USER must not be able to export the workforce.
  if (P.CLIENT_USER?.alive) {
    const r = await hit('/assayers/export', { token: P.CLIENT_USER.token, accept: 'text/csv' });
    check(
      'CLIENT_USER is refused the roster CSV export (403, not an empty 200)',
      r.status === 403,
      `GET /assayers/export as cert_client_user -> HTTP ${r.status} ${String(r.text ?? '').slice(0, 120)}`,
    );
    if (r.status === 200) {
      finding('SXP-E4', 'BLOCKER', 'CLIENT_USER can export the whole assayer roster',
        `GET ${API}/assayers/export as cert_client_user`,
        `HTTP 200, ${csvRows(r.text ?? '').length - 1} data rows`);
    }
  }

  // ---- 2.4 Queued jobs: completed, owned, downloadable -------------------
  console.log('\n=== 2.4 Queued report jobs ===\n');
  const JOBS = [
    ['assignments', '/reports/assignments/jobs', 'ADMIN'],
    ['billing', '/reports/billing/jobs', 'ADMIN'],
    ['command-center', '/reports/command-center/jobs', 'ADMIN'],
    ['assayer-roster', '/reports/assayer-roster/jobs', 'ADMIN'],
  ];
  const jobIds = {};
  for (const [name, path, role] of JOBS) {
    const enq = await hit(path, { method: 'POST', token: P[role].token });
    const id = enq.json?.data?.jobId ?? enq.json?.data?.id ?? null;
    jobIds[name] = id;
    check(`POST ${path} is accepted and returns a job id`, enq.status === 202 && !!id, `HTTP ${enq.status} ${JSON.stringify(enq.json?.data ?? enq.json).slice(0, 160)}`);
  }
  for (const [name] of JOBS) {
    const id = jobIds[name];
    if (!id) continue;
    let state = null;
    let last = null;
    const DONE = ['done', 'completed', 'finished'];
    for (let i = 0; i < 40; i++) {
      last = await hit(`/reports/jobs/${id}`, { token: P.ADMIN.token });
      state = last.json?.data?.state ?? last.json?.data?.status ?? null;
      if (DONE.includes(state) || state === 'failed') break;
      await new Promise((s) => setTimeout(s, 750));
    }
    check(`queued ${name} export finishes`, DONE.includes(state),
      `GET /reports/jobs/${id} -> HTTP ${last.status} state=${state} ${JSON.stringify(last.json?.data ?? {}).slice(0, 220)}`);
    const dl = await hit(`/reports/jobs/${id}/download`, { token: P.ADMIN.token });
    check(`queued ${name} export file is retrievable`, dl.status === 200 && dl.buf.length > 0,
      `GET /reports/jobs/${id}/download -> HTTP ${dl.status} ${dl.buf.length} bytes ${dl.disposition ?? ''}`);

    // Queued and synchronous must agree — a second filter contract is a second set of bugs.
    if (DONE.includes(state) && dl.status === 200) {
      const syncPath = { assignments: '/reports/assignments', billing: '/reports/billing', 'command-center': '/reports/command-center', 'assayer-roster': '/reports/assayer-roster' }[name];
      const sync = await hit(syncPath, { token: P.ADMIN.token });
      if (sync.status === 200) {
        const a = readWorkbook(dl.buf);
        const b = readWorkbook(sync.buf);
        const same = Object.keys(a).join('|') === Object.keys(b).join('|')
          && Object.keys(a).every((s) => (a[s] ?? []).length === (b[s] ?? []).length);
        check(`queued ${name} export matches its synchronous twin`, same,
          `queued sheets=${Object.entries(a).map(([s, r]) => `${s}:${r.length}`).join(' ')}; sync sheets=${Object.entries(b).map(([s, r]) => `${s}:${r.length}`).join(' ')}`);
      }
    }
  }
  // The job ids are a per-queue integer. Another account must not be able to poll or download one.
  const victim = jobIds.billing ?? jobIds.assignments;
  if (victim && P.DESK_OPERATOR?.alive) {
    const poll = await hit(`/reports/jobs/${victim}`, { token: P.DESK_OPERATOR.token });
    const dl = await hit(`/reports/jobs/${victim}/download`, { token: P.DESK_OPERATOR.token });
    check(
      "another account cannot poll ADMIN's queued export job",
      poll.status >= 400, `GET /reports/jobs/${victim} as cert_desk_operator -> HTTP ${poll.status} ${poll.msg ?? ''}`,
    );
    check(
      "another account cannot download ADMIN's queued export file",
      dl.status >= 400, `GET /reports/jobs/${victim}/download as cert_desk_operator -> HTTP ${dl.status} ${dl.msg ?? String(dl.text ?? '').slice(0, 80)}`,
    );
    if (dl.status === 200) {
      finding('SXP-E5', 'BLOCKER', 'A queued export file is downloadable by an account that did not request it',
        `POST ${API}/reports/billing/jobs as admin, then GET ${API}/reports/jobs/${victim}/download as cert_desk_operator`,
        `HTTP 200, ${dl.buf.length} bytes`, 'Job ids are a per-queue incrementing integer, so they are guessable.');
    }
  }
  // A job that does not exist must be a clean refusal, not a 500.
  {
    const r = await hit('/reports/jobs/999999999', { token: P.ADMIN.token });
    check('polling a non-existent job id is a clean refusal', r.status >= 400 && r.status < 500, brief(r, 160));
    const t = await hit('/reports/jobs/..%2F..%2Fetc%2Fpasswd/download', { token: P.ADMIN.token });
    check('a traversal-shaped job id is refused', t.status >= 400 && t.status < 500, brief(t, 160));
  }

  // ---- 2.5 Do exports respect the caller's region scope? -----------------
  console.log('\n=== 2.5 Export vs the caller region scope ===\n');
  const scoped = await sql("SELECT username, regions FROM users WHERE regions IS NOT NULL AND array_length(regions,1) > 0");
  console.log('  region-scoped accounts in the database: ' + (scoped.length ? scoped.map((u) => `${u.username}=[${u.regions}]`).join(', ') : 'none'));
  if (!scoped.length) {
    check('export honours a region-scoped caller', null,
      'no account in `users` carries a non-empty `regions` array, so a scoped export cannot be exercised without creating one — see the report');
  } else {
    const national = totalOf(await hit('/billing-engine/lines?page=1&limit=100', { token: ADMIN }));
    for (const u of scoped) {
      let tok = null;
      try { tok = (await boundedLogin(u.username)).token; } catch { /* not an acceptance account, or the login brake is saturated */ }
      if (!tok) { check(`export honours region scope — ${u.username}`, null, 'no usable password for this account'); continue; }

      const screen = await hit('/billing-engine/lines?page=1&limit=100', { token: tok });
      const book = await hit('/reports/billing', { token: tok });

      // A 403 on the export is the export refusing the role — a correct outcome, and a
      // different question from whether the export respects a region ceiling.
      if (book.status !== 200) {
        check(
          `billing workbook and billing screen agree for ${u.username} [${u.regions}]`,
          book.status === screen.status || (book.status === 403 && screen.status === 403),
          `GET /reports/billing -> HTTP ${book.status} ${book.msg ?? ''}; GET /billing-engine/lines -> HTTP ${screen.status} ${screen.msg ?? ''}`,
        );
        continue;
      }
      const bookRows = (readWorkbook(book.buf)['Client Lines'] ?? []).length - 1;
      const screenRows = screen.status === 200 ? (totalOf(screen) ?? rowsOf(screen).length) : null;
      const ok = screenRows !== null && bookRows === screenRows;
      check(
        `billing workbook is confined to ${u.username}'s regions [${u.regions}]`,
        ok,
        `GET /reports/billing as ${u.username} -> ${bookRows} client lines; `
        + `GET /billing-engine/lines as the same account -> HTTP ${screen.status} total=${screenRows}; `
        + `the same screen as ADMIN (no region ceiling) -> total=${national}`,
      );
      // The queued twin is supposed to produce the same workbook. If the synchronous route has
      // lost the region ceiling, the question is whether the job has too.
      const enq = await hit('/reports/billing/jobs', { method: 'POST', token: tok });
      const jobId = enq.json?.data?.jobId ?? null;
      let queuedRows = null;
      if (jobId) {
        for (let i = 0; i < 20; i++) {
          const st = await hit(`/reports/jobs/${jobId}`, { token: tok });
          const s = st.json?.data?.state ?? null;
          if (s === 'done' || s === 'completed' || s === 'failed') break;
          await new Promise((r) => setTimeout(r, 600));
        }
        const dl = await hit(`/reports/jobs/${jobId}/download`, { token: tok });
        if (dl.status === 200) queuedRows = (readWorkbook(dl.buf)['Client Lines'] ?? []).length - 1;
      }
      check(
        `queued billing export is confined to ${u.username}'s regions [${u.regions}]`,
        queuedRows === null ? null : queuedRows === screenRows,
        `POST /reports/billing/jobs as ${u.username} -> HTTP ${enq.status} jobId=${jobId}; the downloaded workbook has `
        + `${queuedRows} client lines; the screen the same account can open has ${screenRows}`,
      );

      if (!ok && bookRows > (screenRows ?? 0)) {
        finding(
          'SXP-E8', 'BLOCKER',
          "The billing workbook export ignores the caller's region ceiling and hands over the national book",
          `GET ${API}/reports/billing as ${u.username} (users.regions = [${u.regions}])   `
          + `— compare GET ${API}/billing-engine/lines as the same account`,
          `the export delivered ${bookRows} client lines; the screen the same account can open delivered ${screenRows}; `
          + `the unscoped national total is ${national}`,
          'Every billing read on the engine controller resolves `@GlobalScopeFilter()` before the handler runs. '
          + '`GET /reports/billing` and its queued twin take no scope parameter at all, so the region ceiling that '
          + 'the screens enforce simply is not in the export path.'
          + (queuedRows === null ? '' : ` The queued twin behaves identically: ${queuedRows} client lines.`),
        );
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 3. PERFORMANCE AND LARGE DATA
// ══════════════════════════════════════════════════════════════════════════

const SURFACES = [
  ['global search', '/search?q=a', null],
  ['assayer roster (default page)', '/assayers?page=1&limit=20', '/assayers?page=1&limit=999999'],
  ['assayer roster counts', '/assayers/counts', null],
  ['assayer typeahead', '/assayers/search?q=a', '/assayers/search?q=a&limit=999999'],
  ['assayer map roster', '/assayers/map-roster', '/assayers/map-roster?limit=999999'],
  ['assignments', '/assignments?page=1&limit=20', '/assignments?page=1&limit=999999'],
  ['assignments inbox', '/assignments/inbox', null],
  ['assignment dashboard summary', '/assignments/dashboard/summary', null],
  ['branches', '/branches?limit=20', '/branches?limit=999999'],
  ['projects', '/projects?page=1&limit=20', '/projects?page=1&limit=999999'],
  ['clients', '/clients?page=1&limit=20', '/clients?page=1&limit=999999'],
  ['users', '/users?page=1&limit=20', '/users?page=1&limit=999999'],
  ['billing payouts', '/billing-engine/payouts?page=1&limit=20', '/billing-engine/payouts?page=1&limit=999999'],
  ['billing lines', '/billing-engine/lines?page=1&limit=20', '/billing-engine/lines?page=1&limit=999999'],
  ['billing invoices', '/billing-engine/invoices?page=1&limit=20', '/billing-engine/invoices?page=1&limit=999999'],
  ['billing overview', '/billing-engine/overview', null],
  ['documents', '/documents?limit=20', '/documents?limit=999999'],
  ['documents operations overview', '/documents/operations/overview', null],
  ['data-entry queue', '/documents/data-entry/queue?page=1&limit=20', '/documents/data-entry/queue?page=1&limit=999999'],
  ['notifications', '/notifications?limit=20', '/notifications?limit=999999'],
  ['validation worklist', '/validation?page=1&limit=20', '/validation?page=1&limit=999999'],
  ['schedules', '/schedules?page=1&limit=20', '/schedules?page=1&limit=999999'],
  ['planning command centre', '/planning/command-center', null],
  ['HR workforce analytics', '/hr/workforce', null],
  ['audit trail (recent)', '/audit-log/recent?limit=20', '/audit-log/recent?limit=999999'],
];

async function phasePerf() {
  console.log('\n\n════ 3. PERFORMANCE AND LARGE DATA ════\n');
  const ADMIN = P.ADMIN.token;

  console.log('\n=== 3.1 Latency at the default page size (first call discarded as cold) ===\n');
  for (const [label, def] of SURFACES) await time(label, def, { token: ADMIN });

  console.log('\n=== 3.2 Latency at the maximum page size, and the server-side ceiling ===\n');
  const caps = [];
  for (const [label, , max] of SURFACES) {
    if (!max) continue;
    const rec = await time(`${label} @limit=999999`, max, { token: ADMIN });
    const probe = await hit(max, { token: ADMIN });
    const claimed = probe.json?.meta?.pagination?.limit ?? probe.json?.data?.limit ?? probe.json?.meta?.limit ?? null;
    const delivered = rowsOf(probe).length;
    caps.push({ label, path: max, status: probe.status, claimed, delivered });
    console.log(`     ceiling: ${label.padEnd(38)} HTTP ${probe.status} meta.limit=${claimed ?? '-'} rows=${delivered}`);
  }
  const uncapped = caps.filter((c) => c.status === 200 && (c.claimed === 999999 || c.claimed === null && c.delivered > 5000));
  check(
    'every list surface clamps ?limit=999999 to a server-side ceiling',
    uncapped.length === 0,
    uncapped.length ? uncapped.map((c) => `${c.path} echoed limit=${c.claimed} and delivered ${c.delivered}`).join(' || ')
      : caps.map((c) => `${c.label}:${c.claimed ?? `${c.delivered} rows`}`).join(', '),
  );
  /**
   * The decisive version of the same question.
   *
   * At thirteen rows, "the response echoed limit=999999" is suggestive but not proof: the value
   * might still be clamped somewhere the response does not show. A limit larger than a 64-bit
   * integer settles it — if the request reaches Postgres, Postgres says so, and a 500 carrying
   * `bigint out of range` is the caller's number arriving at the database untouched.
   */
  console.log('\n  a limit larger than bigint — does the caller\'s number reach the database?\n');
  const HUGE = '99999999999999999999';
  const reaches = [];
  for (const [label, , max] of SURFACES) {
    if (!max) continue;
    const path = max.replace('limit=999999', `limit=${HUGE}`);
    const r = await hit(path, { token: ADMIN });
    const overflow = r.status >= 500;
    if (overflow) reaches.push({ label, path });
    console.log(`     ${label.padEnd(38)} ${path.split('?')[0]}?…limit=${HUGE} -> HTTP ${r.status}${overflow ? '  <-- the number reached Postgres' : ''}`);
  }
  check(
    'an out-of-range ?limit is clamped before it reaches the database',
    reaches.length === 0,
    reaches.length ? reaches.map((x) => `${x.path} -> 500`).join(' ; ') : `all ${caps.length} surfaces absorbed limit=${HUGE}`,
  );
  if (uncapped.length || reaches.length) {
    finding('SXP-L1', 'HIGH', "A list surface passes the caller's ?limit through to the database unclamped",
      [...uncapped.map((c) => `GET ${API}${c.path}`), ...reaches.map((x) => `GET ${API}${x.path}`)].join(' ; '),
      [
        ...uncapped.map((c) => `${c.path}: HTTP ${c.status}, meta.limit=${c.claimed} (the requested value, echoed back), ${c.delivered} rows`),
        ...reaches.map((x) => `${x.path}: HTTP 500 — the server log records "QueryFailedError: bigint out of range", which is the caller's number arriving at Postgres as a LIMIT`),
      ].join(' || '),
      'This codebase carries `ParseLimitPipe` for exactly this, with the comment that about twenty list endpoints '
      + 'once read `Number(limit)` straight off the query string. These are the ones it was never applied to.');
  }

  // ---- 3.3 What the database actually did --------------------------------
  console.log('\n=== 3.3 The queries behind the slowest surfaces ===\n');
  let statsAvailable = false;
  try {
    await sql('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
    await sql('SELECT pg_stat_statements_reset()');
    statsAvailable = true;
  } catch (e) {
    console.log(`  pg_stat_statements unavailable (${String(e.message).slice(0, 120)}) — falling back to EXPLAIN on the endpoint SQL below`);
  }

  if (statsAvailable) {
    // Drive the surfaces once more so the captured statements are exactly theirs.
    for (const [, def, max] of SURFACES) {
      await hit(def, { token: ADMIN });
      if (max) await hit(max, { token: ADMIN });
    }
    const top = await sql(`
      SELECT calls, round(total_exec_time::numeric, 1) AS total_ms, round(mean_exec_time::numeric, 2) AS mean_ms,
             rows, left(query, 400) AS query
        FROM pg_stat_statements
       WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
         AND query NOT ILIKE '%pg_stat_statements%'
       ORDER BY total_exec_time DESC LIMIT 15`);
    console.log('\n  Top 15 statements by total execution time during the sweep above:\n');
    for (const r of top) {
      console.log(`   ${String(r.total_ms).padStart(9)}ms total  ${String(r.mean_ms).padStart(8)}ms mean  x${String(r.calls).padStart(4)}  rows=${String(r.rows).padStart(5)}  ${r.query.replace(/\s+/g, ' ').slice(0, 150)}`);
    }

    const shared = await sql(`
      SELECT round(sum(shared_blks_read)::numeric, 0) AS read, round(sum(shared_blks_hit)::numeric, 0) AS hit
        FROM pg_stat_statements
       WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`);
    console.log(`\n  buffer traffic across the whole sweep: ${shared[0]?.hit ?? '?'} hits, ${shared[0]?.read ?? '?'} reads from disk`);
    console.log('  (pg_stat_statements normalises literals to $1, so the statements above cannot be replayed verbatim —');
    console.log('   §3.5 replays the query each hot endpoint builds, with real parameters, against two data volumes.)');
  }

  // The tables that will actually grow, and whether their hot columns are indexed.
  console.log('\n=== 3.4 Sequential scans over the tables that grow ===\n');
  const bigTables = await sql(`
    SELECT relname, n_live_tup, seq_scan, seq_tup_read, idx_scan,
           pg_size_pretty(pg_total_relation_size(relid)) AS size
      FROM pg_stat_user_tables
     WHERE n_live_tup > 0
     ORDER BY seq_tup_read DESC NULLS LAST LIMIT 15`);
  console.log('  | table | live rows | seq scans | rows read sequentially | index scans | size |');
  console.log('  |---|---|---|---|---|---|');
  for (const t of bigTables) {
    console.log(`  | ${t.relname} | ${t.n_live_tup} | ${t.seq_scan} | ${t.seq_tup_read} | ${t.idx_scan ?? 0} | ${t.size} |`);
  }

  /**
   * The plans, replayed with real parameters, at two data volumes.
   *
   * `pg_stat_statements` normalises every literal to `$1`, so its rows cannot be fed back to
   * EXPLAIN. These are the queries the hot endpoints build — reconstructed from their query
   * builders and parameterised from live data — which is what makes them replayable. Running
   * the identical statement against a second database with two orders of magnitude more rows
   * is what turns "is this fast?" into "what happens when it grows?".
   */
  console.log('\n=== 3.5 The same statements at two data volumes ===\n');
  const PLANS = [
    ['roster page 1 (the list screen)',
      'SELECT a.id FROM assayers a WHERE a.is_active = true ORDER BY a.created_at DESC, a.id DESC LIMIT 20', []],
    ['roster keyset hop (?after=)',
      'SELECT a.id FROM assayers a WHERE a.is_active = true AND (a.created_at, a.id) < (now(), $1::uuid) ORDER BY a.created_at DESC, a.id DESC LIMIT 20',
      ['ffffffff-ffff-4fff-8fff-ffffffffffff']],
    ['roster total (the pagination count)',
      'SELECT count(*) FROM assayers a WHERE a.is_active = true', []],
    ['roster free-text (ILIKE over four columns)',
      'SELECT a.id FROM assayers a WHERE a.is_active = true AND (a.display_name ILIKE $1 OR a.email ILIKE $1 OR a.phone ILIKE $1 OR a.assayer_code ILIKE $1) ORDER BY a.created_at DESC, a.id DESC LIMIT 20',
      ['%an%']],
    ['roster segment chip (lifecycleStatus)',
      "SELECT a.id FROM assayers a WHERE a.is_active = true AND a.lifecycle_status = 'ACTIVE' ORDER BY a.created_at DESC, a.id DESC LIMIT 20", []],
    ['assignment list page with its joins',
      `SELECT a.id FROM assignments a
         LEFT JOIN project_branches pb ON pb.id = a.project_branch_id
         LEFT JOIN branches b ON b.id = pb.branch_id
         LEFT JOIN assayers asy ON asy.id = a.assayer_id
        WHERE a.is_active = true ORDER BY a.created_at DESC LIMIT 20`, []],
    // `audit_events` timestamps its rows `occurred_at`, not `created_at` — the one table in this
    // schema that does, because the moment recorded is the event's, not the row's.
    ['audit trail page',
      'SELECT e.id FROM audit_events e ORDER BY e.occurred_at DESC LIMIT 20', []],
  ];

  const runPlans = async (label, runner, rows) => {
    console.log(`\n  ---- ${label} (${rows})`);
    for (const [name, q, params] of PLANS) {
      try {
        const plan = await runner(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${q}`, params);
        const text = plan.map((x) => x['QUERY PLAN']).join('\n');
        const ms = (text.match(/Execution Time: ([0-9.]+) ms/) ?? [])[1];
        const seq = [...new Set([...text.matchAll(/Seq Scan on (\w+)/g)].map((m) => m[1]))];
        const idx = [...new Set([...text.matchAll(/Index (?:Only )?Scan .*? using (\w+)/g)].map((m) => m[1]))];
        const sorted = /\bSort\b/.test(text) ? ' + Sort' : '';
        const buffers = (text.match(/Buffers: ([^\n]+)/) ?? [])[1] ?? '';
        console.log(
          `   ${name.padEnd(44)} ${String(ms).padStart(8)} ms  `
          + `${seq.length ? `SEQ SCAN on ${seq.join(',')}${sorted}` : `index: ${idx.join(',') || 'n/a'}${sorted}`}  |  ${buffers}`,
        );
      } catch (e) {
        console.log(`   ${name.padEnd(44)} EXPLAIN failed: ${String(e.message).slice(0, 110)}`);
      }
    }
  };

  const hereRows = `${(await one('SELECT count(*)::int AS c FROM assayers')).c} assayers, `
    + `${(await one('SELECT count(*)::int AS c FROM assignments')).c} assignments, `
    + `${(await one('SELECT count(*)::int AS c FROM audit_events')).c} audit events`;
  await runPlans('acceptance database', (q, p) => sql(q, p), hereRows);

  const bigger = process.env.SCALE_DB_URL ?? null;
  if (bigger) {
    const pg = (await import('pg')).default;
    const p2 = new pg.Pool({ connectionString: bigger, connectionTimeoutMillis: 8000 });
    try {
      const n = (await p2.query('SELECT count(*)::int AS c FROM assayers')).rows[0].c;
      const m = (await p2.query('SELECT count(*)::int AS c FROM assignments')).rows[0].c;
      await runPlans('SCALE_DB_URL (read-only copy)', async (q, p) => (await p2.query(q, p)).rows, `${n} assayers, ${m} assignments`);
    } catch (e) {
      console.log(`  SCALE_DB_URL unreachable: ${String(e.message).slice(0, 160)}`);
    } finally { await p2.end(); }
  } else {
    console.log('\n  SCALE_DB_URL not set — no second data volume compared. See the report for what exists and what does not.');
  }

  // Whether the roster's own ordering has an index at all is a property of the schema, not of
  // the row count, so it can be stated with certainty from either database.
  const rosterIdx = await sql(
    "SELECT indexdef FROM pg_indexes WHERE tablename = 'assayers' AND indexdef ILIKE '%created_at%'",
  );
  check(
    'the roster list ordering (created_at DESC, id DESC) has a supporting index',
    rosterIdx.length > 0,
    rosterIdx.length ? rosterIdx.map((i) => i.indexdef).join(' ; ')
      : "no index on assayers mentions created_at, so every roster page and every ?after= hop is a full scan of `assayers` plus a sort",
  );
  if (!rosterIdx.length) {
    finding(
      'SXP-L2', 'MEDIUM',
      'The roster list and its keyset cursor order by a column with no index, so every page is a full table scan plus a sort',
      "SELECT indexdef FROM pg_indexes WHERE tablename='assayers'  — then EXPLAIN (ANALYZE, BUFFERS) "
      + 'SELECT a.id FROM assayers a WHERE a.is_active ORDER BY a.created_at DESC, a.id DESC LIMIT 20',
      'no index on `assayers` covers `created_at`; the plan is Seq Scan + Sort at both data volumes measured above',
      '`assignments` has idx_assignments_recent_page for exactly this shape and `assayers` has none, even though the '
      + 'roster is the screen designed to be exhausted (limit ceiling 1,000 against every other list\'s 200) and the '
      + 'keyset cursor is literally `created_at_id`.',
    );
  }

  if (statsAvailable) {
    // Leave the server as it was found.
    try { await sql('DROP EXTENSION IF EXISTS pg_stat_statements'); console.log('\n  pg_stat_statements dropped again (the server is as it was found).'); } catch { /* best effort */ }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

const main = async () => {
  console.log(`FAPOMS acceptance — search / export / performance\nAPI ${API}\nphases: ${PHASES.length ? PHASES.join(', ') : 'all'}\n`);
  await establishPrincipals();
  await census();
  if (want('search')) await phaseSearch();
  if (want('export')) await phaseExport();
  if (want('perf')) await phasePerf();

  console.log(`\n\n════ TALLY ════\n${pass}/${pass + fail} checks passed, ${unknown} UNKNOWN (throttled, or not exercisable on this dataset)\n`);
  if (timings.length) {
    console.log('| surface | rows | p50 ms | worst ms | cold ms (discarded) | bytes |');
    console.log('|---|---|---|---|---|---|');
    for (const t of timings) console.log(`| ${t.label} | ${t.rows ?? '-'} | ${t.p50} | ${t.worst} | ${t.cold} | ${t.bytes} |`);
  }
  if (findings.length) {
    console.log('\n════ FINDINGS ════');
    for (const f of findings) console.log(`\n${f.id} [${f.severity}] ${f.title}\n  repro:    ${f.repro}\n  observed: ${f.observed}${f.note ? `\n  note:     ${f.note}` : ''}`);
  }
  await pool.end();
};

main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
