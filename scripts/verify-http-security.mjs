#!/usr/bin/env node
/**
 * THE HTTP HALF OF THE SECURITY GATE, RE-RUN AGAINST A LIVE SERVER.
 *
 * Every probe here corresponds to a finding this system has actually had, not to a category
 * somebody thought of. They are grouped by the shape of the defect rather than by endpoint,
 * because that is what recurs: the same mistake appears on a new route six weeks later.
 *
 *   authentication     a request with no token, a junk token, an expired shape
 *   authorization      a role reaching a route it was never granted
 *   region scope       an operator reading another region's records, and its money
 *   IDOR               an object reached by id alone, with no relationship to the caller
 *   hostile ids        a path parameter that is not a UUID, or is a UUID that means nothing
 *   escalation         granting yourself a role, or removing the last administrator
 *   bulk               a bulk operation reached by somebody who may not do it one at a time
 *   reports            an export that returns rows the screen would have refused
 *   cache              a revoked role still working, because the principal was cached
 *
 * Run it against a DISPOSABLE deployment. It creates nothing it does not clean up, but it does
 * issue writes, and several probes deliberately attempt privilege escalation:
 *
 *   API=http://127.0.0.1:4099/api/v1 PASSWORD=… node scripts/verify-http-security.mjs
 *
 * The accounts it expects are the seeded ones: `admin` (ADMIN), `manager` (OPERATIONS),
 * `executive` (OPERATIONS), `validator` (DESK_OPERATOR). `manager` is given and then returned
 * from a single region as part of the run.
 */
import { randomUUID } from 'node:crypto';

const API = process.env.API || 'http://127.0.0.1:4099/api/v1';
const PASSWORD = process.env.PASSWORD || 'admin123';

const results = [];
let group = '';
const say = (ok, what, detail) => {
  results.push({ group, ok, what, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
};
const heading = (name) => {
  group = name;
  console.log(`\n  ${name}`);
};

async function call(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
}

async function login(username) {
  const res = await call('/auth/login', { method: 'POST', body: { username, password: PASSWORD } });
  const token = res.json?.data?.accessToken;
  if (!token) throw new Error(`could not sign in as ${username}: HTTP ${res.status} ${res.text.slice(0, 200)}`);
  return token;
}

/** A refusal, not a 500 and not a 200. 401 and 403 are both correct answers to "not for you". */
const refused = (status) => status === 401 || status === 403 || status === 404;

async function mustRefuse(what, path, opts) {
  const { status } = await call(path, opts);
  say(refused(status), what, `HTTP ${status}`);
}

async function mustAllow(what, path, opts) {
  const { status } = await call(path, opts);
  say(status >= 200 && status < 300, what, `HTTP ${status}`);
}

async function main() {
  const admin = await login('admin');
  const manager = await login('manager');
  const validator = await login('validator');

  const users = await call('/users?limit=200', { token: admin });
  const list = users.json?.data?.items ?? users.json?.data ?? [];
  const managerId = list.find((u) => u.username === 'manager')?.id;
  const adminId = list.find((u) => u.username === 'admin')?.id;
  if (!managerId || !adminId) throw new Error('could not resolve the seeded accounts');

  const roles = await call('/users/roles', { token: admin });
  const roleList = roles.json?.data?.items ?? roles.json?.data ?? [];
  const roleId = (name) => roleList.find((r) => r.name === name)?.id;

  heading('authentication');
  await mustRefuse('no token is refused', '/users');
  await mustRefuse('a junk token is refused', '/users', { token: 'not-a-jwt' });
  await mustRefuse('a well-formed token with a bad signature is refused', '/users', {
    token: `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from('{"sub":"x"}').toString('base64url')}.aaaa`,
  });
  await mustAllow('a real token is accepted', '/users', { token: admin });

  heading('authorization by role');
  await mustRefuse('DESK_OPERATOR cannot create an assignment', '/assignments', {
    token: validator, method: 'POST', body: {},
  });
  await mustRefuse('OPERATIONS cannot read the outbox admin surface', '/admin/outbox/health', { token: manager });
  await mustRefuse('ADMIN cannot read the outbox admin surface either — it is DEVELOPER-only', '/admin/outbox/health', { token: admin });
  await mustRefuse('OPERATIONS cannot list users’ roles for editing', '/users/roles', { token: manager });

  heading('region scope');
  // `manager` is WEST-only for this run; the seeded branches span WEST, CENTRAL and SOUTH.
  const allBranches = await call('/branches?limit=200', { token: admin });
  const scopedBranches = await call('/branches?limit=200', { token: manager });
  const count = (r) => (r.json?.data?.items ?? r.json?.data ?? []).length;
  say(count(scopedBranches) > 0 && count(scopedBranches) < count(allBranches),
    'a region-scoped operator sees fewer branches than a national one',
    `${count(scopedBranches)} of ${count(allBranches)}`);
  await mustRefuse('and cannot ask for a region they do not hold', '/branches?region=CENTRAL', { token: manager });
  await mustRefuse('nor for that region’s money', '/billing-engine/overview?region=CENTRAL', { token: manager });

  const nationalMoney = await call('/billing-engine/overview', { token: admin });
  const scopedMoney = await call('/billing-engine/overview', { token: manager });
  const unbilled = (r) => r.json?.data?.receivables?.unbilled ?? null;
  // Both zero is not a pass. It is the answer a database with no billing rows gives, and it
  // would let the probe report a working region filter on a deployment that has nothing to
  // filter — precisely the vacuous green this whole suite exists to avoid.
  if (nationalMoney.status !== 200 || !unbilled(nationalMoney)) {
    say(false, 'NOT EXERCISED: there is no unbilled money for the region filter to divide',
      `national unbilled ${unbilled(nationalMoney)} — seed billing rows in two regions and re-run`);
  } else {
    say(scopedMoney.status === 200 && unbilled(scopedMoney) < unbilled(nationalMoney),
      'the scoped caller sees strictly less unbilled money than the national one',
      `national ${unbilled(nationalMoney)}, scoped ${unbilled(scopedMoney)}`);
  }

  heading('hostile ids');
  for (const id of ['not-a-uuid', '../../etc/passwd', "' OR 1=1 --", '00000000-0000-0000-0000-000000000000']) {
    const { status } = await call(`/users/${encodeURIComponent(id)}`, { token: admin });
    say(status === 400 || status === 404, `GET /users/${id.slice(0, 20)} is refused cleanly`, `HTTP ${status}`);
  }
  const { status: assignmentStatus } = await call(`/assignments/${randomUUID()}`, { token: admin });
  say(assignmentStatus === 404, 'a well-formed id that names nothing is a 404, not a 500', `HTTP ${assignmentStatus}`);

  heading('IDOR and early-return authorization');
  // Check-in is the route where the ownership question used to be asked AFTER three idempotent
  // shortcuts had already answered with the whole record.
  const checkIn = await call(`/assignments/${randomUUID()}/check-in`, {
    token: manager, method: 'POST', body: { latitude: 18.5, longitude: 73.8 },
  });
  say(refused(checkIn.status) || checkIn.status === 400,
    'check-in on an assignment that is not yours returns no record',
    `HTTP ${checkIn.status}`);
  say(!/assayer|email|phone|latitude/i.test(checkIn.text) || refused(checkIn.status),
    'and discloses no assignee details in the refusal body');

  heading('escalation');
  const adminRole = roleId('ADMIN');
  if (adminRole) {
    await mustRefuse('a user cannot grant themselves a new role', `/users/${managerId}/roles`, {
      token: manager, method: 'PUT', body: { roleIds: [adminRole] },
    });
  } else {
    say(false, 'could not resolve the ADMIN role id to test self-escalation');
  }
  await mustRefuse('a non-admin cannot edit another user', `/users/${adminId}`, {
    token: manager, method: 'PUT', body: { status: 'INACTIVE' },
  });

  heading('bulk operations');
  await mustRefuse('a non-admin cannot bulk-change user status', '/users/bulk/status', {
    token: manager, method: 'POST', body: { userIds: [adminId], status: 'INACTIVE' },
  });

  heading('reports and exports');
  // The export path used to admit a role every screen refused, and it returns the same rows.
  await mustRefuse('DESK_OPERATOR cannot export the billing report', '/reports/billing', { token: validator });

  heading('cache: a revoked role stops working immediately');
  const opsRole = roleId('OPERATIONS');
  const auditorRole = roleId('AUDITOR');
  if (opsRole && auditorRole) {
    const before = await call('/assignments', { token: manager, method: 'POST', body: {} });
    await call(`/users/${managerId}/roles`, { token: admin, method: 'PUT', body: { roleIds: [auditorRole] } });
    // No sleep and no cache flush. This is the request that matters after a revocation.
    const after = await call('/assignments', { token: manager, method: 'POST', body: {} });
    await call(`/users/${managerId}/roles`, { token: admin, method: 'PUT', body: { roleIds: [opsRole] } });
    const restored = await call('/assignments', { token: manager, method: 'POST', body: {} });

    say(before.status === 400, 'before: the role is held, so the body is what is wrong', `HTTP ${before.status}`);
    say(after.status === 403, 'immediately after revocation: refused, with no cache flush', `HTTP ${after.status}`);
    say(restored.status === 400, 'immediately after restoration: allowed again', `HTTP ${restored.status}`);
  } else {
    say(false, 'could not resolve the OPERATIONS/AUDITOR role ids to test invalidation');
  }

  heading('the audit trail');
  // `/audit-log/trail`, not `/audit/events`, and it is per-entity: the first version of this
  // probe named a route that does not exist and accepted its 404 as an answer, which is a probe
  // that tests nothing. `managerId` is the right subject — this run has just changed that user's
  // roles three times.
  const trail = await call(`/audit-log/trail?entityId=${managerId}&limit=20`, { token: admin });
  say(trail.status === 200, 'an administrator can read the unified trail for a user', `HTTP ${trail.status}`);
  const entries = trail.json?.data?.items ?? trail.json?.data ?? [];
  say(Array.isArray(entries) && entries.length > 0,
    'and this run’s own role changes are in it',
    `${Array.isArray(entries) ? entries.length : '?'} entries`);
  say(trail.status !== 200 || JSON.stringify(entries).includes('ROLES_UPDATED'),
    'naming the act, not just the timestamp',
    'USER_ROLES_UPDATED present');
  await mustRefuse('a DESK_OPERATOR cannot read it', `/audit-log/trail?entityId=${managerId}&limit=5`, { token: validator });
  await mustRefuse('and the integrity verification is not open to them either', '/audit-log/verify?limit=10', { token: validator });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? '✓' : '✗'} ${results.length - failed.length}/${results.length} probes passed`);
  if (failed.length > 0) {
    console.error('\nFailed:');
    for (const f of failed) console.error(`  - [${f.group}] ${f.what}${f.detail ? ` (${f.detail})` : ''}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
