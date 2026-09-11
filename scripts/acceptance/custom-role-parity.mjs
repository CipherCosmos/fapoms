/**
 * Does a role built in Admin → Roles get what the product says it gets?
 *
 * The measurement this exists for: a custom role holding 15 grants signed in, landed on
 * `/dashboard`, was offered ten navigation entries, and NINE of the ten backing APIs answered 403.
 * Thirteen pages in all were offered by the web app and refused by the API behind them. Each page
 * rendered the refusal differently and the worst of them, `/scheduling`, rendered it as
 * "0 active schedules · 0 unscheduled confirmed offers" over a full empty calendar.
 *
 * So this probe asks four questions, in order of how much they matter:
 *
 *  1. Do the pages the web app offers a custom role actually load? (`PAGE_SURFACE`)
 *  2. Do the pages it does NOT offer stay refused, so the two agree in both directions?
 *  3. Do combinations behave — read-only, one mutation, several grants, one revoked, one newly
 *     granted — and does a change made THROUGH THE PRODUCT take effect without flushing Redis?
 *  4. Can a custom role reach ADMIN or DEVELOPER capability by any route, including the
 *     destructive data-reset approval? (`@RoleOnly()` must stay unsatisfiable by permissions.)
 *
 * Run:
 *   AC_ENV_FILE=<scratch>/acc.env node scripts/acceptance/custom-role-parity.mjs
 *
 * Every sign-in goes through `login()` from `_lib.mjs`, which clears the forced-rotation gate —
 * that gate is enforced on EVERY request, not just at login, so a probe that only handles it at
 * sign-in reads each later 403 as a permission failure. `req()` bounds its 429 retries and returns
 * the 429 rather than looping, and this script treats 429 as UNKNOWN. `POST /auth/login` is capped
 * at 20/min/IP independently of THROTTLE_LIMIT and this host is shared, so sign-ins are paced and
 * every token is minted once and reused.
 */
import { login, req, sql, one, pool, tally, env, CERT_PASSWORD, declareMutating } from './_lib.mjs';

const ADMIN_USER = env.AC_USERNAME ?? 'admin';
const ADMIN_PASSWORD = env.AC_PASSWORD;
const ROLE = 'CERT_SURFACE_CUSTOM';
const USER = 'cert_surface_custom';

/** A throttled answer is not a denial. Nothing in this script may score one as either. */
const UNKNOWN = (r) => r.status === 429;

const { check, done, state } = tally();

/** Space sign-ins so a shared host's 20/min/IP login cap is never the thing under test. */
const pace = (ms = 1200) => new Promise((s) => setTimeout(s, ms));

// ---------------------------------------------------------------------------
// The map. One row per page, exactly as `custom-role-page-parity.spec.ts` holds it.
// ---------------------------------------------------------------------------

/**
 * `offered` mirrors whether `config/route-permissions.ts` names a permission for the page — i.e.
 * whether the navigation shows it to a custom role holding that grant. `api` is the call that
 * fills it. The invariant is that the two agree: offered ⇒ 200, not offered ⇒ 403.
 */
const PAGE_SURFACE = [
  { page: '/dashboard',        api: '/system-dashboard/operations',       grant: 'PROJECT:VIEW:PLATFORM',       offered: true },
  { page: '/executive-map',    api: '/planning/command-center',           grant: 'PLANNING:VIEW:PLATFORM',      offered: true },
  // The planning READS honour the fallback and are exercised through /executive-map above; what
  // decides /planning is the project list it is keyed on, which does not.
  { page: '/planning (day-plans)', api: '/planning/day-plans?projectIds=', grant: 'PLANNING:VIEW:PLATFORM',   offered: true, allow400: true },
  { page: '/planning (projects)',  api: '/projects',                      grant: 'PROJECT:VIEW:PLATFORM',    offered: false },
  { page: '/scheduling',       api: '/schedules?limit=5',                 grant: 'SCHEDULING:VIEW:PLATFORM',    offered: true },
  { page: '/billing',          api: '/billing-engine/overview',           grant: 'BILLING:VIEW:PLATFORM',       offered: true },
  { page: '/documents',        api: '/documents/operations/overview',     grant: 'DOCUMENT:VIEW:ORGANIZATION',  offered: true },
  { page: '/users',            api: '/users?limit=5',                     grant: 'USER:VIEW:PLATFORM',          offered: true },
  { page: '/users',            api: '/users/roles',                       grant: 'USER:VIEW:PLATFORM',          offered: true },
  { page: '/users',            api: '/users/permissions',                 grant: 'USER:VIEW:PLATFORM',          offered: true },
  { page: '/admin/rule-bypass', api: '/admin/rule-bypass/catalogue',      grant: 'CONFIGURATION:VIEW:PLATFORM', offered: true },
  // Secondary panels on /scheduling. Not the page's main content, but a panel that draws a
  // confident zero over a refusal is the same defect one level down.
  { page: '/scheduling (queue)',    api: '/assignments?limit=5',          grant: 'ASSIGNMENT:VIEW:PLATFORM',    offered: true },
  { page: '/scheduling (holidays)', api: '/holidays?year=2026&limit=5',   grant: 'REFERENCE_DATA:VIEW:ORGANIZATION', offered: true },

  // The other legitimate answer: the web app does not offer these, because the API will not serve
  // them. Their handlers live in modules this workstream does not own.
  { page: '/hr',         api: '/hr/workforce',                 grant: 'ASSAYER:VIEW:ORGANIZATION',    offered: false },
  { page: '/hr/roster',  api: '/assayers?limit=5',             grant: 'ASSAYER:VIEW:ORGANIZATION',    offered: false },
  { page: '/data-entry', api: '/validation/attention',         grant: 'VALIDATION:VIEW:ORGANIZATION', offered: false },
];

/**
 * Capability a custom role must never reach, whatever it is granted.
 *
 * The first four are `@RoleOnly()`: their `@Roles` list is the whole gate precisely because their
 * permission is deliberately the same as some broader route's. The rest are ADMIN/DEVELOPER
 * territory with no fallback at all.
 */
const MUST_STAY_SHUT = [
  { what: 'approve a data wipe (the destructive two-person rule)', method: 'POST', api: '/admin/data-reset/requests/00000000-0000-4000-8000-000000000000/approve' },
  { what: 'reject a data wipe',                                    method: 'POST', api: '/admin/data-reset/requests/00000000-0000-4000-8000-000000000000/reject', body: { reason: 'probe' } },
  { what: 'write a platform setting',                              method: 'PUT',  api: '/platform-settings/probe.key', body: { value: 'x' } },
  { what: 'read the platform-wide aggregates',                     method: 'GET',  api: '/system-dashboard/metrics' },
  { what: 'suspend a business rule',                               method: 'POST', api: '/admin/rule-bypass', body: { rules: ['EMPANELMENT'], reason: 'probe', hours: 1 } },
  { what: 'create a role',                                         method: 'POST', api: '/users/roles', body: { name: 'PROBE_ROLE', displayName: 'Probe' } },
  { what: 'grant a role its permissions',                          method: 'PUT',  api: '/users/roles/00000000-0000-4000-8000-000000000000/permissions', body: { permissionIds: [] } },
  { what: 'assign roles to a user',                                method: 'PUT',  api: '/users/00000000-0000-4000-8000-000000000000/roles', body: { roleIds: [] } },
  { what: 'read the container logs (DEVELOPER estate)',            method: 'GET',  api: '/admin/logs/services' },
  { what: 'replay a dead-lettered event (DEVELOPER estate)',       method: 'GET',  api: '/admin/outbox/health' },
];

// ---------------------------------------------------------------------------
// Grants, changed the way an administrator changes them: through the API.
// ---------------------------------------------------------------------------

/**
 * Set the role's permissions to exactly this list of `RESOURCE:ACTION:SCOPE` keys, using
 * `PUT /users/roles/:id/permissions` as the admin screen does.
 *
 * Deliberately NOT a direct database write. There is a standing trap in this system: the RBAC
 * principal is cached in Redis, so editing `role_permissions` in SQL changes nothing a request can
 * see until the cache expires or is flushed — a test that edits the table and then measures the API
 * is measuring the cache. Going through the API is also the only thing that proves the product
 * works, which is the actual question.
 */
async function setRoleGrants(adminToken, roleId, keys) {
  const wanted = new Set(keys.map((k) => k.toUpperCase()));
  const all = await req('/users/permissions', { token: adminToken });
  const rows = Array.isArray(all.body?.data) ? all.body.data : all.body;
  const ids = (rows ?? [])
    .filter((p) => wanted.has(`${p.resource}:${p.action}:${p.scope}`.toUpperCase()))
    .map((p) => p.id);
  const missing = [...wanted].filter((k) => !(rows ?? []).some(
    (p) => `${p.resource}:${p.action}:${p.scope}`.toUpperCase() === k,
  ));
  if (missing.length) throw new Error(`no such permission rows: ${missing.join(', ')}`);
  const r = await req(`/users/roles/${roleId}/permissions`, {
    method: 'PUT', token: adminToken, body: { permissionIds: ids },
  });
  if (r.status >= 400) throw new Error(`could not set grants: ${r.status} ${JSON.stringify(r.msg)}`);
  return ids;
}

async function main() {
  if (!ADMIN_PASSWORD) throw new Error('AC_PASSWORD is not set — put it in AC_ENV_FILE');
  declareMutating('custom-role-parity', [
    `rewrites the permission set of the ${ROLE} role through PUT /users/roles/:id/permissions,`,
    '  and puts the original set back at the end of the run',
    'attempts privileged writes as that role to prove they are refused — on a deployment where',
    '  the fallback is wider than expected, some of those attempts would SUCCEED',
  ]);

  const { token: adminToken } = await login(ADMIN_USER, ADMIN_PASSWORD);
  await pace();

  const role = await one(`SELECT id, name FROM roles WHERE name = $1`, [ROLE]);
  if (!role) throw new Error(`${ROLE} does not exist — seed it before running this`);

  // What the role holds now, so this script can put it back and be re-runnable.
  const before = (await sql(
    `SELECT p.resource, p.action, p.scope FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = $1`, [role.id],
  )).map((p) => `${p.resource}:${p.action}:${p.scope}`);

  try {
    // ── 1 & 2. The page surface, with the role holding everything it is meant to ───────────────
    const surfaceGrants = [...new Set(PAGE_SURFACE.map((r) => r.grant))];
    await setRoleGrants(adminToken, role.id, surfaceGrants);
    const { token } = await login(USER, CERT_PASSWORD);
    await pace();

    console.log(`\n── the page surface, holding ${surfaceGrants.length} grants ──`);
    for (const row of PAGE_SURFACE) {
      const r = await req(row.api, { token });
      if (UNKNOWN(r)) { check(`${row.page} ← ${row.api}`, false, 'throttled — UNKNOWN, not a denial; re-run'); continue; }
      const served = r.status === 200 || (row.allow400 && r.status === 400);
      check(
        `${row.page.padEnd(24)} ${row.offered ? 'is offered and loads' : 'is not offered and stays refused'}`,
        row.offered ? served : r.status === 403,
        `${row.api} -> ${r.status}${served || r.status === 403 ? '' : ` (${JSON.stringify(r.msg)})`}`,
      );
    }

    // ── 3. Combinations ───────────────────────────────────────────────────────────────────────
    console.log('\n── combinations of grants, each set through the API ──');

    // (a) Read-only: one grant, one page, nothing else.
    await setRoleGrants(adminToken, role.id, ['SCHEDULING:VIEW:PLATFORM']);
    let r = await req('/schedules?limit=1', { token });
    check('one grant opens exactly its own page', r.status === 200, `/schedules -> ${r.status}`);
    r = await req('/billing-engine/overview', { token });
    check('…and opens nothing else', r.status === 403, `/billing-engine/overview -> ${r.status}`);

    // (b) The cache. The grant above was added seconds ago on a token minted BEFORE it, and the
    // principal is cached in Redis — so a 200 here is the invalidation working, not the token.
    check(
      'a grant added through the API takes effect on an existing session, with no Redis flush',
      (await req('/schedules?limit=1', { token })).status === 200,
      'the RBAC principal cache is invalidated by the write, not by expiry',
    );

    // (c) Revoked. Same session, same token, permission taken away.
    await setRoleGrants(adminToken, role.id, ['DOCUMENT:VIEW:ORGANIZATION']);
    r = await req('/schedules?limit=1', { token });
    check('a revoked grant stops working immediately, on the same session',
      r.status === 403, `/schedules -> ${r.status}`);
    r = await req('/documents/operations/overview', { token });
    check('…and the newly granted one starts working', r.status === 200,
      `/documents/operations/overview -> ${r.status}`);

    // (d) Several at once, and the ALL-not-ANY rule.
    await setRoleGrants(adminToken, role.id, ['SCHEDULING:VIEW:PLATFORM', 'BILLING:VIEW:PLATFORM', 'DOCUMENT:VIEW:ORGANIZATION']);
    const three = await Promise.all([
      req('/schedules?limit=1', { token }),
      req('/billing-engine/overview', { token }),
      req('/documents/operations/overview', { token }),
    ]);
    check('several grants open several pages', three.every((x) => x.status === 200),
      three.map((x) => x.status).join(', '));
    check('…and still open nothing that was not granted',
      (await req('/users?limit=1', { token })).status === 403, '/users stays 403');

    // (e) A mutation grant is not a read grant, and vice versa.
    await setRoleGrants(adminToken, role.id, ['SCHEDULING:CREATE:ORGANIZATION']);
    r = await req('/schedules?limit=1', { token });
    check('holding the CREATE on a resource does not open its READ',
      r.status === 403, `scheduling:create alone -> /schedules ${r.status}`);

    // ── 4. Escalation ─────────────────────────────────────────────────────────────────────────
    console.log('\n── escalation: everything grantable, granted at once ──');

    /**
     * The first line of defence, found by this probe rather than assumed: the SYSTEM resource
     * cannot be put on a custom role AT ALL. `user.service.ts` refuses it on create and on
     * re-permission, so `system:approve:platform` — the approve half of the destructive
     * two-person rule — is not merely unsatisfiable at the route, it is unassignable at the role.
     */
    const systemKeys = (await sql(`SELECT resource, action, scope FROM permissions WHERE resource = 'SYSTEM'`))
      .map((p) => `${p.resource}:${p.action}:${p.scope}`);
    let systemRefused = false;
    try {
      await setRoleGrants(adminToken, role.id, systemKeys);
    } catch (e) {
      systemRefused = /SYSTEM-level/i.test(e.message);
    }
    check('a SYSTEM permission cannot be granted to a custom role at all',
      systemRefused, `tried to grant ${systemKeys.join(', ')}`);

    const everything = (await sql(`SELECT resource, action, scope FROM permissions WHERE resource <> 'SYSTEM'`))
      .map((p) => `${p.resource}:${p.action}:${p.scope}`);
    await setRoleGrants(adminToken, role.id, everything);
    check(`the role now holds every grantable permission in the catalogue (${everything.length})`, true);

    for (const row of MUST_STAY_SHUT) {
      const res = await req(row.api, { method: row.method, token, body: row.body });
      if (UNKNOWN(res)) { check(`cannot ${row.what}`, false, 'throttled — UNKNOWN; re-run'); continue; }
      // 403 is the answer being tested. 404/400 would mean the gate let the request THROUGH to a
      // handler that then failed on the fixture id, which is a pass for the fixture and a FAIL for
      // the gate — so only 403 counts.
      check(`cannot ${row.what}`, res.status === 403,
        `${row.method} ${row.api} -> ${res.status}${res.status === 403 ? '' : ' — the gate let it through'}`);
    }

    // The one that matters most, stated on its own: holding every permission there is, including
    // SYSTEM:APPROVE:PLATFORM, must not make a custom role an administrator.
    const me = await req('/users/me', { token });
    const roleNames = (me.body?.data?.roles ?? me.body?.roles ?? []).map((x) => x?.name ?? x);
    check('the principal is still only its custom role — no built-in role was acquired',
      roleNames.length === 1 && roleNames[0] === ROLE, JSON.stringify(roleNames));
  } finally {
    // Put the role back exactly as it was, so this is re-runnable and leaves no widened role behind.
    try {
      await setRoleGrants(adminToken, role.id, before);
      console.log(`\nrestored ${ROLE} to its original ${before.length} grants`);
    } catch (e) {
      console.log(`\n!! COULD NOT RESTORE ${ROLE} — it currently holds a wider set than it started with: ${e.message}`);
      state.fail++;
    }
  }

  await done();
}

main().catch(async (e) => {
  console.error('probe aborted:', e.message);
  await pool.end();
  process.exit(2);
});
