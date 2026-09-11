#!/usr/bin/env node
/**
 * DOES EVERY COLLECTION ENDPOINT REFUSE AN ABSURD `?limit=`?
 *
 * `ParseLimitPipe` exists because about twenty list endpoints read `Number(limit)` straight off the
 * query string and passed it to a TypeORM `take:` with no ceiling. Its own docblock says so. This
 * script is the other half of that sentence: it asks each collection endpoint, over the wire, what
 * it actually does with a limit nobody meant.
 *
 * Four questions per route, because "it has a default" is not the same claim as "it has a maximum":
 *
 *   ?limit=5000000   a safe route CLAMPS (delivers far fewer rows than asked) or REFUSES (400).
 *                    An unsafe one tries: it either delivers everything, or hands the number
 *                    through to Postgres and 500s on "bigint out of range".
 *   ?limit=-5        must not reach `take:` or `skip:` as a negative.
 *   ?limit=abc       must not become NaN inside a query.
 *   ?limit=0         must not mean "no rows" or "all rows" by accident.
 *
 * WHY THIS IS NOT A UNIT TEST. The ceiling can live in the controller (a pipe), in the service
 * (`Math.min(...)`), or nowhere — and reading the controller alone cannot tell those apart. Several
 * routes here look unguarded and are clamped one layer down; others look fine and are not. Only the
 * wire settles it, which is why this is a script against a running deployment rather than a spec.
 *
 * READ-ONLY. Every request is a GET. It creates nothing, changes nothing, and needs no write gate.
 *
 * Usage:
 *   AC_ENV_FILE=…/acc.env node scripts/verify-list-limits.mjs
 *   AC_API=… AC_PASSWORD=… node scripts/verify-list-limits.mjs
 *
 * Exit code 0 when every route that answered was bounded; 1 when any accepted an absurd limit.
 * A route that could not be reached at all (403, no fixture) is UNKNOWN and fails nothing — an
 * unrunnable check is a reporting outcome, not a defect.
 */
import { req, login, sql, pool, env } from './acceptance/_lib.mjs';

const ABSURD = 5_000_000;
/** Anything at or above this many delivered rows means nothing clamped it. */
const SANE_CEILING = 2_000;

const results = [];
const say = (s) => console.log(s);

/** How many rows came back, whatever envelope this route happens to use. */
function rowsOf(body) {
  const d = body?.data ?? body;
  if (Array.isArray(d)) return d.length;
  if (Array.isArray(body?.items)) return body.items.length;
  for (const k of ['events', 'entries', 'items', 'rows', 'records', 'results', 'branches', 'notifications', 'queue', 'schedules', 'clients', 'projects', 'organizations', 'feedback', 'remarks']) {
    if (Array.isArray(d?.[k])) return d[k].length;
  }
  // One nested array and no ambiguity: take it.
  const arrays = Object.values(d ?? {}).filter(Array.isArray);
  return arrays.length === 1 ? arrays[0].length : null;
}

/** What the route claims the limit was, if it echoes one back. */
const echoedLimit = (body) =>
  body?.meta?.pagination?.limit ?? body?.meta?.limit ?? body?.data?.pagination?.limit
  ?? body?.data?.branchPagination?.limit ?? null;

async function probe(name, path, token, { needs } = {}) {
  if (!token) { results.push({ name, path, verdict: 'UNKNOWN', detail: `no token: ${needs ?? 'not signed in'}` }); return; }
  const sep = path.includes('?') ? '&' : '?';
  const call = (v) => req(v === null ? path : `${path}${sep}limit=${encodeURIComponent(v)}`, { token });

  /**
   * The baseline matters. A route that answers 400 to every limit INCLUDING a sane one is not
   * "rejecting absurd input" — it is refusing for some other reason, and scoring that as a pass
   * would be the probe agreeing with itself.
   */
  const base = await call(null);
  if (base.status === 403 || base.status === 404 || base.status === 401) {
    results.push({ name, path, verdict: 'UNKNOWN', detail: `baseline ${base.status} ${base.msg ?? ''} — this principal cannot reach it` });
    return;
  }
  if (base.status >= 400) {
    results.push({ name, path, verdict: 'UNKNOWN', detail: `baseline (no limit) -> ${base.status} ${String(base.msg ?? '').slice(0, 80)} — the route refuses regardless of limit` });
    return;
  }

  const big = await call(ABSURD);
  if (big.status === 429) {
    results.push({ name, path, verdict: 'UNKNOWN', detail: 'throttled for the whole budget' });
    return;
  }

  const rows = rowsOf(big.body);
  const baseRows = rowsOf(base.body);
  const echoed = echoedLimit(big.body);
  const neg = await call(-5);
  const nan = await call('abc');
  const zero = await call(0);

  // A 5xx is never the right answer to a query parameter. Reported whatever the verdict is.
  const garbage = [['-5', neg], ['abc', nan], ['0', zero]].filter(([, r]) => r.status >= 500).map(([v]) => v);

  let verdict;
  let why;
  if (big.status >= 500) {
    verdict = 'UNBOUNDED';
    why = 'the number reached the database — a 5xx on ?limit=' + ABSURD;
  } else if (echoed !== null && Number(echoed) >= ABSURD) {
    verdict = 'UNBOUNDED';
    why = `it accepted ${ABSURD} as the limit and echoed it back`;
  } else if (big.status === 400) {
    verdict = 'REFUSED';
    why = 'refused the absurd limit outright, while the same call without one succeeds';
  } else if (echoed !== null) {
    verdict = 'CLAMPED';
    why = `clamped ${ABSURD} down to ${echoed}`;
  } else {
    /**
     * No echo, and this database is far too small for a row count to settle it: a route that
     * clamps to 200 and a route with no ceiling at all both return every row there is. Saying
     * BOUNDED here would be inventing evidence.
     */
    verdict = 'INCONCLUSIVE';
    why = `no meta.limit echo and only ${rows ?? '?'} row(s) exist (baseline ${baseRows ?? '?'}), `
      + 'so delivering them all is consistent with both a clamp and no clamp — read the source';
  }
  if (garbage.length && verdict !== 'UNBOUNDED') {
    verdict = verdict === 'INCONCLUSIVE' ? 'INCONCLUSIVE+5xx' : verdict + '+5xx';
  }

  const detail = [
    `base -> ${base.status}`,
    `${ABSURD} -> ${big.status}`,
    rows === null ? 'rows=?' : `rows=${rows}`,
    echoed === null ? 'no echo' : `meta.limit=${echoed}`,
    `-5 -> ${neg.status}`, `abc -> ${nan.status}`, `0 -> ${zero.status}`,
    garbage.length ? `**5xx on ${garbage.join(', ')}**` : '',
    `| ${why}`,
  ].filter(Boolean).join('  ');

  results.push({ name, path, verdict, detail, garbage });
}

const main = async () => {
  say(`\nFAPOMS — collection endpoints and the limits they accept\nAPI ${env.AC_API ?? 'default'}\nread-only: every request below is a GET\n`);

  const admin = await login('admin', env.AC_PASSWORD);
  const dev = await login('cert_developer').catch(() => ({ token: null }));
  const A = admin.token;
  const D = dev.token;

  // Fixtures for the routes that need an id in the path. Read-only lookups.
  const assayer = await sql(`SELECT id FROM assayers WHERE is_active LIMIT 1`);
  const aid = assayer[0]?.id ?? null;
  const user = await sql(`SELECT id FROM users WHERE username = 'admin' LIMIT 1`);
  const uid = user[0]?.id ?? null;

  const ROUTES = [
    ['audit trail',             `/audit-log/trail?entityId=${aid ?? uid}`,         A],
    ['outbox dead letters',     '/admin/outbox/dead-letters',                      D, { needs: 'DEVELOPER' }],
    ['assayer remarks',         aid && `/assayer-remarks/assayer/${aid}`,          A],
    ['assignments by assayer',  aid && `/assignments/assayer/${aid}`,              A],
    ['clients',                 '/clients',                                        A],
    // "assayer" / "branch" are the only two targets assertTarget() accepts; "assayers" 400s
    // before limit is even looked at, which is a probe defect, not a route that validates.
    ['geo imprecise',           '/geo/precision/assayer/imprecise',                A],
    ['notifications',           '/notifications',                                  A],
    ['organizations',           '/organizations',                                  A],
    ['rule-bypass history',     '/admin/rule-bypass/history',                      A],
    ['projects',                '/projects',                                       A],
    ['schedules',               '/schedules',                                      A],
    ['telemetry by user',       uid && `/telemetry/user?userId=${uid}`,            A],
    ['validation queries',      '/validation-queries',                             A],
    ['validation queue',        '/validation',                                     A],
    ['validation activity',     '/validation/activity',                            A],
    ['feedback',                '/feedback',                                       A],
    // Bounded one layer down, in their service rather than at the boundary. Listed so the run
    // covers every collection endpoint that reads a limit, not only the ones that were wrong.
    ['data-entry queue',        '/documents/data-entry/queue',                     A],
    ['data-entry mine',         '/documents/data-entry/mine',                      A],
    ['document ops overview',   '/documents/operations/overview',                  A],

    // Already piped before this campaign — controls. If these are not CLAMPED the probe is wrong.
    ['CONTROL assayers',        '/assayers',                                       A],
    ['CONTROL branches',        '/branches',                                       A],
    ['CONTROL users',           '/users',                                          A],
  ];

  for (const [name, path, token, opts] of ROUTES) {
    if (!path) { results.push({ name, path: '(no fixture)', verdict: 'UNKNOWN', detail: 'no fixture row to address' }); continue; }
    await probe(name, path, token, opts);
    const r = results[results.length - 1];
    say(`  ${r.verdict.padEnd(9)} ${name.padEnd(24)} ${r.detail}`);
  }

  const BAD = (v) => v.startsWith('UNBOUNDED') || v.endsWith('+5xx');
  const bad = results.filter((r) => BAD(r.verdict));
  const inconclusive = results.filter((r) => r.verdict.startsWith('INCONCLUSIVE') && !BAD(r.verdict));
  const good = results.filter((r) => r.verdict === 'CLAMPED' || r.verdict === 'REFUSED');
  const unknown = results.filter((r) => r.verdict === 'UNKNOWN');
  say(`\n${good.length} bounded (observed), ${bad.length} not, ${inconclusive.length} inconclusive on this dataset, ${unknown.length} unknown, of ${results.length}`);
  if (bad.length) {
    say('\nRoutes that accepted a limit nobody meant, or answered 5xx to bad input:');
    for (const r of bad) say(`  ${r.verdict}  ${r.name}  ${r.path}\n        ${r.detail}`);
  }
  if (inconclusive.length) {
    say('\nNot settled by this database — too few rows for a row count to mean anything:');
    for (const r of inconclusive) say(`  ${r.name}  ${r.path}`);
  }
  await pool.end();
  process.exit(bad.length ? 1 : 0);
};

main().catch(async (e) => { console.error(e); try { await pool.end(); } catch { /* never opened */ } process.exit(2); });
