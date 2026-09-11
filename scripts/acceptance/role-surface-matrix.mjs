#!/usr/bin/env node
/**
 * FAPOMS production acceptance — the role × surface matrix.
 *
 * One question, asked of a running deployment rather than of the source: for every screen the
 * product navigates to, and for every principal that can sign in, WHAT DOES THE API ACTUALLY SAY?
 *
 * Three claims are checked, in order of how much they are worth:
 *
 *   1. Every principal proves it is alive before any of its refusals count. A run where the
 *      tokens had quietly expired would otherwise read as "correctly denied everywhere", which is
 *      the most flattering possible way to fail.
 *
 *   2. `@RoleOnly()` is not satisfiable by permissions. Twenty-two routes carry that decorator
 *      precisely so that a role built in Admin -> Roles cannot reach them by holding the grants
 *      they declare. The probe therefore includes a CUSTOM ROLE that has been granted exactly
 *      those permissions: if it gets in, the decorator is decorative.
 *
 *   3. The web app and the API disagree about custom roles, and this measures the gap.
 *      `canAccessRoute` (packages/frontend/src/config/route-permissions.ts) applies a permission
 *      fallback on EVERY route that declares `requiredPermissions`. `RolesGuard`
 *      (packages/backend/src/modules/auth/guards.ts) applies it only where the route opts in with
 *      `@AllowPermissionFallback()` or `@RolesFallbackPermissions(...)` — six routes, of which two
 *      are reads. So a custom-role user can be handed a nav entry and a page shell whose own data
 *      fetch the API then refuses. Every such route is probed and every mismatch is reported.
 *      This script MEASURES that; it does not fix it.
 *
 * Discipline this script holds itself to:
 *   - A 403 is a 403 and a 404 is a 404. Statuses are never normalised, and a route that answers
 *     404 to hide its existence is named as doing so.
 *   - Before any path is probed with a token, it is probed WITHOUT one. An existing guarded route
 *     answers 401; a path this script got wrong answers 404. That separates "refused" from
 *     "misspelled", which no amount of 403-counting can.
 *   - Every refusal that feeds a check is issued twice. If the two disagree the cell is UNSTABLE
 *     and the check fails, rather than a flake being reported as a control.
 *   - A 429 is the rate limiter, not the product. It is retried once and then recorded as UNKNOWN.
 *     It is never counted as a denial.
 *
 * The surface table below is hand written from the source rather than parsed out of it. Parsing
 * TypeScript decorators from a shell script is a way to be confidently wrong; a table somebody can
 * read next to the controller is a way to be reviewably wrong. Each row names the file it came from.
 *
 * Usage:
 *   AC_PASSWORD=... CERT_PASSWORD=... node scripts/acceptance/role-surface-matrix.mjs \
 *     [--json out.json] [--delay 50] [--cleanup]
 *
 * `--cleanup` removes the custom-role fixture (role + user) this script provisions. Without it the
 * fixture is left in place and reused, which is what makes a second run a no-op rather than churn.
 */
/**
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * SAFETY CLASSIFICATION: DESTRUCTIVE
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * password    : ROTATES SEVERAL ACCOUNTS, each between AC_PASSWORD, CERT_PASSWORD and a
 *               bootstrap value, to get a usable session per role. Read that again before
 *               pointing this at a deployment.
 * role changes: CREATES a custom role, GRANTS it permissions, ASSIGNS it to a real user, then
 *               unassigns and DELETEs it. An aborted run leaves the user holding it.
 * deletion    : probes DELETE on platform settings, the notification catalog and rule-bypass
 *               with an __acceptance_probe__ id; ownerSafe:false entries can reach real state.
 * gate        : none of its own — it does not use _lib.mjs.
 *
 * The full table for every script here is in scripts/acceptance/README.md.
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const require = createRequire(
  process.env.AC_REPO ? `${process.env.AC_REPO}/package.json`
    : '/Users/deepstacker/WorkSpace/dupcq/gssAutomation/package.json');
const { Client } = require('pg');

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const JSON_OUT = argOf('--json', null);
const DELAY_MS = Number(argOf('--delay', 50));
const CLEANUP = argv.includes('--cleanup');

const API = process.env.AC_API || 'http://127.0.0.1:8080/api/v1';
const AC_PASSWORD = process.env.AC_PASSWORD;
const CERT_PASSWORD = process.env.CERT_PASSWORD || 'Cert!Walk2026x19961';
const DBC = {
  host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 55432),
  user: process.env.DB_USERNAME || 'fapoms', password: process.env.DB_PASSWORD || 'fapoms_dev',
  database: process.env.DB_DATABASE || 'fapoms',
};

/** The fixture this script provisions so a genuine custom-role principal exists to probe with. */
const CUSTOM_ROLE_NAME = 'CERT_SURFACE_CUSTOM';
const CUSTOM_USER = 'cert_surface_custom';
/** Deliberately NOT the password it rotates to — a change-password to the same value is refused. */
const BOOTSTRAP_PASSWORD = `${CERT_PASSWORD}Boot1`;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The two role vocabularies, copied from the source they must agree with
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** packages/shared/src/enums.ts — the closed set of built-in role names. */
const SYSTEM_ROLES = [
  'ADMIN', 'DEVELOPER', 'OPERATIONS', 'DESK', 'DESK_OPERATOR',
  'AUDITOR', 'PRODUCT_SUPPORT', 'CLIENT_USER', 'ASSAYER',
];

/**
 * packages/shared/src/role-hierarchy.ts — one-way implication. A DEVELOPER passes any gate that
 * admits ADMIN or PRODUCT_SUPPORT; an ADMIN never passes a DEVELOPER-only gate.
 */
const ROLE_IMPLICATIONS = { DEVELOPER: ['ADMIN', 'PRODUCT_SUPPORT'] };
const expandRoles = (names) => {
  const out = []; const seen = new Set();
  const push = (n) => { if (!seen.has(n)) { seen.add(n); out.push(n); } };
  for (const n of names) { push(n); for (const i of ROLE_IMPLICATIONS[n] ?? []) push(i); }
  return out;
};

/** packages/backend/src/modules/auth/staff-roles.ts */
const STAFF_ROLES = ['ADMIN', 'OPERATIONS', 'DESK', 'DESK_OPERATOR', 'AUDITOR', 'PRODUCT_SUPPORT'];
/** packages/backend/src/modules/billing-engine/billing-roles.ts */
const BILLING_READ_ROLES = ['ADMIN', 'OPERATIONS', 'AUDITOR'];
/** packages/backend/src/modules/feedback/feedback-roles.ts */
const FEEDBACK_TEAM_ROLES = ['DEVELOPER', 'PRODUCT_SUPPORT'];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The principals
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `passwords` is tried in order and the first that yields a token wins, so a stack whose accounts
 * have already been rotated by a sibling script is handled without a special case. `rotateTo` is
 * only used when the account answers PASSWORD_CHANGE_REQUIRED — and it is that account's OWN
 * canonical password, never a single shared one, because the cert accounts are shared with other
 * sessions and rotating them out from under those would be a hostile act.
 */
const PRINCIPALS = [
  { key: 'SYSTEM_ADMIN', role: 'ADMIN', username: 'admin',
    passwords: () => [AC_PASSWORD, CERT_PASSWORD, 'admin123'], rotateTo: () => AC_PASSWORD,
    changePath: '/users/me/change-password' },
  { key: 'DEVELOPER', role: 'DEVELOPER', username: 'cert_developer',
    passwords: () => [CERT_PASSWORD, AC_PASSWORD, 'admin123'], rotateTo: () => CERT_PASSWORD,
    changePath: '/users/me/change-password' },
  { key: 'OPERATIONS', role: 'OPERATIONS', username: 'executive',
    passwords: () => [AC_PASSWORD, CERT_PASSWORD, 'admin123'], rotateTo: () => AC_PASSWORD,
    changePath: '/users/me/change-password' },
  { key: 'DESK', role: 'DESK', username: 'cert_desk',
    passwords: () => [CERT_PASSWORD, AC_PASSWORD, 'admin123'], rotateTo: () => CERT_PASSWORD,
    changePath: '/users/me/change-password' },
  { key: 'DESK_OPERATOR', role: 'DESK_OPERATOR', username: 'validator',
    passwords: () => [AC_PASSWORD, CERT_PASSWORD, 'admin123'], rotateTo: () => AC_PASSWORD,
    changePath: '/users/me/change-password' },
  { key: 'AUDITOR', role: 'AUDITOR', username: 'cert_auditor',
    passwords: () => [CERT_PASSWORD, AC_PASSWORD, 'admin123'], rotateTo: () => CERT_PASSWORD,
    changePath: '/users/me/change-password' },
  { key: 'PRODUCT_SUPPORT', role: 'PRODUCT_SUPPORT', username: 'cert_product_support',
    passwords: () => [CERT_PASSWORD, AC_PASSWORD, 'admin123'], rotateTo: () => CERT_PASSWORD,
    changePath: '/users/me/change-password' },
  { key: 'CLIENT_USER', role: 'CLIENT_USER', username: 'cert_client_user',
    passwords: () => [CERT_PASSWORD, AC_PASSWORD, 'admin123'], rotateTo: () => CERT_PASSWORD,
    changePath: '/users/me/change-password' },
  // username discovered from the assayers table at run time; principal kind is different (the
  // token is issued from `assayers`, not `users`, and its change-password path differs).
  { key: 'ASSAYER', role: 'ASSAYER', username: null,
    passwords: () => [AC_PASSWORD, CERT_PASSWORD, 'assayer123'], rotateTo: () => AC_PASSWORD,
    changePath: '/assayers/me/change-password' },
  // Provisioned by this script; the whole point of the run. Its password is not guessed: every run
  // resets it to a known bootstrap value through the admin API and then rotates it, so the state
  // this principal starts in is the same whether or not a previous run left it half-configured.
  { key: 'CUSTOM_ROLE', role: CUSTOM_ROLE_NAME, username: CUSTOM_USER,
    passwords: () => [BOOTSTRAP_PASSWORD, CERT_PASSWORD], rotateTo: () => CERT_PASSWORD,
    changePath: '/users/me/change-password' },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The surfaces: every READ endpoint that backs a navigable screen
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `fe` mirrors one entry of ROUTE_PERMISSIONS in packages/frontend/src/config/route-permissions.ts.
 * `beRoles` / `bePerm` / `beFallback` mirror the decorators on the handler named in `src`.
 *
 * `beRoles: null` means the handler declares no @Roles at all — the route is permission-routed
 * (RolesGuard branch 2), where a custom role holding the permission IS admitted. Those are the
 * rows where the two sides already agree.
 */
const SURFACES = [
  { id: 'S01', page: '/dashboard', path: '/system-dashboard/operations',
    fe: { roles: ['ADMIN', 'OPERATIONS', 'DESK', 'DESK_OPERATOR', 'AUDITOR', 'CLIENT_USER'], perms: ['PROJECT:VIEW:ORGANIZATION'] },
    beRoles: ['ADMIN', 'OPERATIONS', 'DESK', 'DESK_OPERATOR', 'AUDITOR', 'CLIENT_USER'], bePerm: ['PROJECT:VIEW:ORGANIZATION'], beFallback: null,
    src: 'modules/user/system-dashboard.controller.ts' },
  { id: 'S02', page: '/feedback', path: '/feedback',
    fe: { roles: ['DEVELOPER', 'PRODUCT_SUPPORT'], perms: null },
    beRoles: FEEDBACK_TEAM_ROLES, bePerm: null, beFallback: null,
    src: 'modules/feedback/feedback.controller.ts' },
  { id: 'S03', page: '/executive-map', path: '/planning/command-center',
    fe: { roles: ['ADMIN', 'OPERATIONS', 'AUDITOR'], perms: ['PLANNING:VIEW:ORGANIZATION'] },
    beRoles: ['ADMIN', 'OPERATIONS', 'AUDITOR'], bePerm: ['PLANNING:VIEW:ORGANIZATION'], beFallback: null,
    src: 'modules/planning/planning.controller.ts' },
  { id: 'S04', page: '/projects', path: '/projects',
    fe: { roles: ['ADMIN', 'OPERATIONS', 'DESK', 'DESK_OPERATOR', 'AUDITOR'], perms: null },
    beRoles: STAFF_ROLES, bePerm: null, beFallback: null,
    src: 'modules/project/project.controller.ts (class @Roles)' },
  { id: 'S05', page: '/planning', path: '/planning/recommendations',
    fe: { roles: ['ADMIN', 'OPERATIONS'], perms: ['PLANNING:VIEW:ORGANIZATION'] },
    beRoles: ['ADMIN', 'OPERATIONS'], bePerm: ['PLANNING:VIEW:ORGANIZATION'], beFallback: null,
    src: 'modules/planning/planning.controller.ts' },
  { id: 'S06', page: '/inbox', path: '/assignments/inbox',
    fe: { roles: ['ADMIN', 'OPERATIONS'], perms: null },
    beRoles: STAFF_ROLES, bePerm: null, beFallback: null,
    src: 'modules/assignment/assignment.controller.ts' },
  { id: 'S07', page: '/falling-behind', path: '/assignments/falling-behind',
    fe: { roles: ['ADMIN', 'OPERATIONS'], perms: null },
    beRoles: STAFF_ROLES, bePerm: null, beFallback: null,
    src: 'modules/assignment/assignment.controller.ts' },
  { id: 'S08', page: '/assignments', path: '/assignments',
    fe: { roles: ['ADMIN', 'OPERATIONS', 'AUDITOR'], perms: null },
    beRoles: STAFF_ROLES, bePerm: null, beFallback: null,
    src: 'modules/assignment/assignment.controller.ts' },
  { id: 'S09', page: '/scheduling', path: '/schedules',
    fe: { roles: ['ADMIN', 'OPERATIONS', 'DESK', 'AUDITOR'], perms: ['SCHEDULING:VIEW:ORGANIZATION'] },
    beRoles: ['ADMIN', 'OPERATIONS', 'DESK', 'AUDITOR', 'CLIENT_USER'], bePerm: ['SCHEDULING:VIEW:ORGANIZATION'], beFallback: null,
    src: 'modules/scheduling/scheduling.controller.ts' },
  { id: 'S10', page: '/clients', path: '/clients',
    fe: { roles: ['ADMIN', 'OPERATIONS', 'AUDITOR'], perms: null },
    beRoles: STAFF_ROLES, bePerm: null, beFallback: null,
    src: 'modules/client/client.controller.ts (class @Roles)' },
  { id: 'S11', page: '/billing', path: '/billing-engine/overview',
    fe: { roles: ['ADMIN', 'OPERATIONS', 'AUDITOR'], perms: ['BILLING:VIEW:ORGANIZATION'] },
    beRoles: BILLING_READ_ROLES, bePerm: ['BILLING:VIEW:ORGANIZATION'], beFallback: null,
    src: 'modules/billing-engine/billing-engine.controller.ts' },
  { id: 'S12', page: '/branches', path: '/branches',
    fe: { roles: ['ADMIN', 'OPERATIONS', 'DESK', 'DESK_OPERATOR', 'AUDITOR'], perms: null },
    beRoles: STAFF_ROLES, bePerm: null, beFallback: null,
    src: 'modules/branch/branch.controller.ts (class @Roles)' },
  { id: 'S13', page: '/hr', path: '/hr/workforce',
    fe: { roles: ['ADMIN', 'OPERATIONS'], perms: ['ASSAYER:VIEW:ORGANIZATION'] },
    beRoles: ['ADMIN', 'OPERATIONS'], bePerm: ['ASSAYER:VIEW:ORGANIZATION'], beFallback: null,
    src: 'modules/assayer/hr.controller.ts' },
  // The wizard issues no read on mount (RegistrationWizard.tsx); its referrer step calls the whole
  // roster, so that read stands in for the page. Deliberately the same path as S32 with a
  // different frontend entry — the two entries ask for different permissions, and that is the point.
  { id: 'S14', page: '/hr/register', path: '/assayers',
    fe: { roles: ['ADMIN', 'OPERATIONS'], perms: ['ASSAYER:CREATE:ORGANIZATION'] },
    beRoles: ['ADMIN', 'OPERATIONS', 'AUDITOR', 'DESK', 'DESK_OPERATOR'], bePerm: ['ASSAYER:VIEW:ORGANIZATION'], beFallback: null,
    src: 'modules/assayer/assayer.controller.ts (stand-in: AssayerForms.tsx fetchWholeAssayerRoster)' },
  { id: 'S15', page: '/documents', path: '/documents/operations/overview',
    fe: { roles: ['ADMIN', 'OPERATIONS', 'DESK', 'DESK_OPERATOR', 'AUDITOR'], perms: ['DOCUMENT:VIEW:ORGANIZATION'] },
    beRoles: ['ADMIN', 'OPERATIONS', 'DESK', 'DESK_OPERATOR', 'AUDITOR'], bePerm: ['DOCUMENT:VIEW:ORGANIZATION'], beFallback: null,
    src: 'modules/document/document.controller.ts' },
  { id: 'S16', page: '/data-entry', path: '/validation/attention',
    fe: { roles: ['ADMIN', 'DESK', 'DESK_OPERATOR'], perms: ['VALIDATION:VIEW:ORGANIZATION'] },
    beRoles: ['ADMIN', 'DESK'], bePerm: ['VALIDATION:VIEW:ORGANIZATION'], beFallback: null,
    src: 'modules/validation/validation.controller.ts' },
  // A redirect into Platform Settings' travel section (App.tsx), so the page it actually lands on
  // is /admin/settings and the read that must succeed is that page's, not the rate card's own.
  { id: 'S17', page: '/transport-costs', path: '/platform-settings',
    fe: { roles: ['ADMIN', 'OPERATIONS', 'AUDITOR'], perms: null },
    beRoles: ['ADMIN', 'OPERATIONS', 'AUDITOR'], bePerm: null, beFallback: null,
    src: 'infrastructure/settings/platform-settings.controller.ts (redirect target)' },
  { id: 'S18', page: '/admin/settings', path: '/platform-settings',
    fe: { roles: ['ADMIN', 'OPERATIONS', 'AUDITOR'], perms: null },
    beRoles: ['ADMIN', 'OPERATIONS', 'AUDITOR'], bePerm: null, beFallback: null,
    src: 'infrastructure/settings/platform-settings.controller.ts' },
  { id: 'S19', page: '/admin/logs', path: '/admin/logs/services',
    fe: { roles: ['DEVELOPER'], perms: null },
    beRoles: ['DEVELOPER'], bePerm: null, beFallback: null,
    src: 'modules/platform/logs/service-logs.controller.ts (class @Roles)' },
  { id: 'S20', page: '/admin/approvals', path: '/admin/data-reset/requests',
    fe: { roles: ['ADMIN'], perms: null },
    beRoles: ['DEVELOPER', 'ADMIN'], bePerm: null, beFallback: null,
    src: 'infrastructure/data-reset/data-reset.controller.ts' },
  { id: 'S21', page: '/admin/compliance', path: '/admin/compliance/health',
    fe: { roles: ['ADMIN', 'AUDITOR'], perms: null },
    beRoles: ['ADMIN', 'AUDITOR'], bePerm: null, beFallback: null,
    src: 'modules/compliance/compliance.controller.ts' },
  { id: 'S22', page: '/admin/notifications', path: '/notification-admin/catalog',
    fe: { roles: ['ADMIN'], perms: null },
    beRoles: ['ADMIN'], bePerm: null, beFallback: null,
    src: 'modules/notifications/notification-admin.controller.ts (class @Roles)' },
  { id: 'S23', page: '/holidays', path: '/holidays',
    fe: { roles: ['ADMIN', 'OPERATIONS', 'AUDITOR'], perms: null },
    beRoles: STAFF_ROLES, bePerm: null, beFallback: null,
    src: 'modules/holiday/holiday.controller.ts (class @Roles)' },
  { id: 'S24', page: '/admin/rule-bypass', path: '/admin/rule-bypass/catalogue',
    fe: { roles: ['ADMIN'], perms: ['CONFIGURATION:VIEW:PLATFORM'] },
    beRoles: ['ADMIN'], bePerm: ['CONFIGURATION:VIEW:PLATFORM'], beFallback: 'AllowPermissionFallback',
    src: 'modules/platform/rule-bypass/rule-bypass.controller.ts' },
  { id: 'S25', page: '/admin/rule-bypass', path: '/admin/rule-bypass/history',
    fe: { roles: ['ADMIN'], perms: ['CONFIGURATION:VIEW:PLATFORM'] },
    beRoles: ['ADMIN'], bePerm: ['CONFIGURATION:VIEW:PLATFORM'], beFallback: 'AllowPermissionFallback',
    src: 'modules/platform/rule-bypass/rule-bypass.controller.ts' },
  // Also a redirect into Platform Settings (rules section) — same reasoning as S17.
  { id: 'S26', page: '/rules', path: '/platform-settings',
    fe: { roles: ['ADMIN', 'OPERATIONS'], perms: null },
    beRoles: ['ADMIN', 'OPERATIONS', 'AUDITOR'], bePerm: null, beFallback: null,
    src: 'infrastructure/settings/platform-settings.controller.ts (redirect target)' },
  { id: 'S27', page: '/zones', path: '/zones',
    fe: { roles: ['ADMIN', 'OPERATIONS'], perms: null },
    beRoles: STAFF_ROLES, bePerm: null, beFallback: null,
    src: 'modules/zone/zone.controller.ts (class @Roles)' },
  { id: 'S28', page: '/users', path: '/users',
    fe: { roles: ['ADMIN'], perms: ['USER:VIEW:ORGANIZATION'] },
    beRoles: ['ADMIN'], bePerm: ['USER:VIEW:ORGANIZATION'], beFallback: null,
    src: 'modules/user/user.controller.ts' },
  // `@PasswordChangeExempt()`, so a 200 here proves a token exists and NOTHING else — an account
  // still on an issued password answers 200 here and 403 everywhere. Flagged so the aliveness
  // check below refuses to accept it as proof of a usable session.
  { id: 'S29', page: '/settings', path: '/users/me', exemptFromPasswordChange: true,
    fe: { roles: [], perms: null, anyAuthenticated: true },
    beRoles: null, bePerm: null, beFallback: 'AnyAuthenticated',
    src: 'modules/user/user.controller.ts' },
  { id: 'S30', page: '/notifications', path: '/notifications',
    fe: { roles: [], perms: null, anyAuthenticated: true },
    beRoles: null, bePerm: null, beFallback: 'AnyAuthenticated',
    src: 'modules/notifications/notification.controller.ts' },
  // Redirect shim to /data-entry, so it must be able to load /data-entry's own read.
  { id: 'S31', page: '/validation', path: '/validation/attention',
    fe: { roles: ['ADMIN', 'DESK', 'DESK_OPERATOR'], perms: ['VALIDATION:VIEW:ORGANIZATION'] },
    beRoles: ['ADMIN', 'DESK'], bePerm: ['VALIDATION:VIEW:ORGANIZATION'], beFallback: null,
    src: 'modules/validation/validation.controller.ts (redirect target)' },
  { id: 'S32', page: '/assayers', path: '/assayers',
    fe: { roles: ['ADMIN', 'OPERATIONS'], perms: ['ASSAYER:VIEW:ORGANIZATION'] },
    beRoles: ['ADMIN', 'OPERATIONS', 'AUDITOR', 'DESK', 'DESK_OPERATOR'], bePerm: ['ASSAYER:VIEW:ORGANIZATION'], beFallback: null,
    src: 'modules/assayer/assayer.controller.ts' },
  // Not a web page: the field app's own screen. Present because it is the only surface an ASSAYER
  // is entitled to, and without it that principal could not prove itself alive.
  { id: 'S33', page: '(mobile) my claims', path: '/expenses/mine',
    fe: { roles: ['ASSAYER'], perms: null, notInTable: true },
    beRoles: ['ASSAYER'], bePerm: null, beFallback: null,
    src: 'modules/expense/expense.controller.ts' },
  // The rule-bypass page's FIRST read is the bypass state, and it is @AnyAuthenticated() — so the
  // page's own gate (ADMIN) and this read's gate disagree by design. Probed to record who can see
  // whether the platform's operational controls are currently suspended.
  { id: 'S34', page: '/admin/rule-bypass', path: '/admin/rule-bypass',
    fe: { roles: ['ADMIN'], perms: ['CONFIGURATION:VIEW:PLATFORM'] },
    beRoles: null, bePerm: null, beFallback: 'AnyAuthenticated',
    src: 'modules/platform/rule-bypass/rule-bypass.controller.ts' },
  // The desk-head branch of /data-entry reads the queue, whose @Roles list is wider than
  // /validation/*'s — the difference decides whether a DESK_OPERATOR sees anything at all.
  { id: 'S35', page: '/data-entry', path: '/documents/data-entry/queue',
    fe: { roles: ['ADMIN', 'DESK', 'DESK_OPERATOR'], perms: ['VALIDATION:VIEW:ORGANIZATION'] },
    beRoles: ['ADMIN', 'DESK', 'DESK_OPERATOR', 'OPERATIONS', 'AUDITOR'], bePerm: ['DOCUMENT:VIEW:ORGANIZATION'], beFallback: null,
    src: 'modules/document/document.controller.ts' },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The @RoleOnly() routes — all of them
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every route carrying `@RoleOnly()`, whether the decorator is on the handler or on the class.
 * `owners` is the @Roles list AFTER hierarchy expansion is accounted for: DEVELOPER reaches an
 * ADMIN-gated route by implication, so it is listed as an owner there too.
 *
 * Most of these are writes, so they are probed with their real verb and a body or path parameter
 * that cannot do any work. That is exact rather than merely cautious: NestJS runs guards BEFORE
 * the validation pipe and before the handler, so a 400 ("rules must be an array") or a 404 ("no
 * such request") from one of these is proof that the guard ADMITTED the caller — with nothing
 * mutated. A 403 is proof it refused. Verified live before this table was written.
 *
 * `ownerSafe: false` marks the three routes where no invalid input exists that stops the work:
 * running the digest sends real mail, enriching branch addresses drives the geocoder fleet, and
 * DELETE /admin/rule-bypass closes a live bypass window. Those are probed for REFUSAL only, and
 * their owner cell says so rather than guessing.
 */
const U = '00000000-0000-4000-8000-000000000000';
const ROLE_ONLY = [
  { id: 'R01', method: 'POST', path: `/admin/data-reset/requests/${U}/approve`, body: {}, owners: ['ADMIN', 'DEVELOPER'], perm: ['SYSTEM:APPROVE:PLATFORM'], ownerSafe: true, src: 'infrastructure/data-reset/data-reset.controller.ts' },
  { id: 'R02', method: 'POST', path: `/admin/data-reset/requests/${U}/reject`, body: {}, owners: ['ADMIN', 'DEVELOPER'], perm: ['SYSTEM:APPROVE:PLATFORM'], ownerSafe: true, src: 'infrastructure/data-reset/data-reset.controller.ts' },
  { id: 'R03', method: 'POST', path: '/ocr-boundary/jobs', body: {}, owners: ['DEVELOPER'], perm: ['OCR:CREATE:ORGANIZATION'], ownerSafe: true, src: 'infrastructure/ocr/ocr-boundary.controller.ts' },
  { id: 'R04', method: 'POST', path: `/ocr-boundary/jobs/${U}/results`, body: {}, owners: ['DEVELOPER'], perm: ['OCR:EDIT:ORGANIZATION'], ownerSafe: true, src: 'infrastructure/ocr/ocr-boundary.controller.ts' },
  { id: 'R05', method: 'GET', path: `/ocr-boundary/jobs/${U}`, body: undefined, owners: ['DEVELOPER', 'DESK'], perm: ['OCR:EDIT:ORGANIZATION'], ownerSafe: true, src: 'infrastructure/ocr/ocr-boundary.controller.ts' },
  { id: 'R06', method: 'POST', path: `/ocr-boundary/jobs/${U}/retry`, body: {}, owners: ['DEVELOPER', 'DESK'], perm: ['OCR:EDIT:ORGANIZATION'], ownerSafe: true, src: 'infrastructure/ocr/ocr-boundary.controller.ts' },
  { id: 'R07', method: 'GET', path: '/admin/outbox/health', body: undefined, owners: ['DEVELOPER'], perm: [], ownerSafe: true, src: 'infrastructure/persistence/outbox.controller.ts (class @RoleOnly)' },
  { id: 'R08', method: 'GET', path: '/admin/outbox/dead-letters', body: undefined, owners: ['DEVELOPER'], perm: [], ownerSafe: true, src: 'infrastructure/persistence/outbox.controller.ts (class @RoleOnly)' },
  { id: 'R09', method: 'GET', path: `/admin/outbox/dead-letters/${U}`, body: undefined, owners: ['DEVELOPER'], perm: [], ownerSafe: true, src: 'infrastructure/persistence/outbox.controller.ts (class @RoleOnly)' },
  { id: 'R10', method: 'POST', path: `/admin/outbox/dead-letters/${U}/replay`, body: {}, owners: ['DEVELOPER'], perm: [], ownerSafe: true, src: 'infrastructure/persistence/outbox.controller.ts (class @RoleOnly)' },
  { id: 'R11', method: 'PUT', path: '/platform-settings/__acceptance_probe__', body: {}, owners: ['ADMIN', 'DEVELOPER'], perm: ['CONFIGURATION:EDIT:PLATFORM'], ownerSafe: true, src: 'infrastructure/settings/platform-settings.controller.ts' },
  { id: 'R12', method: 'DELETE', path: '/platform-settings/__acceptance_probe__', body: undefined, owners: ['ADMIN', 'DEVELOPER'], perm: ['CONFIGURATION:EDIT:PLATFORM'], ownerSafe: true, src: 'infrastructure/settings/platform-settings.controller.ts' },
  { id: 'R13', method: 'GET', path: `/assayers/${U}/sensitive/pan`, body: undefined, owners: ['ADMIN', 'OPERATIONS', 'DEVELOPER'], perm: ['ASSAYER:VIEW:ORGANIZATION'], ownerSafe: true, src: 'modules/assayer/assayer.controller.ts' },
  { id: 'R14', method: 'POST', path: '/geo/precision/__acceptance_probe__/backfill', body: {}, owners: ['DEVELOPER'], perm: ['BRANCH:EDIT:ORGANIZATION', 'ASSAYER:EDIT:ORGANIZATION'], ownerSafe: true, src: 'modules/geo/geo.controller.ts' },
  { id: 'R15', method: 'POST', path: '/geo/branches/enrich-addresses', body: {}, owners: ['DEVELOPER'], perm: ['BRANCH:EDIT:ORGANIZATION'], ownerSafe: false, src: 'modules/geo/geo.controller.ts' },
  { id: 'R16', method: 'PUT', path: '/notification-admin/catalog/__acceptance_probe__', body: {}, owners: ['ADMIN', 'DEVELOPER'], perm: ['CONFIGURATION:EDIT:PLATFORM'], ownerSafe: true, src: 'modules/notifications/notification-admin.controller.ts' },
  { id: 'R17', method: 'DELETE', path: '/notification-admin/catalog/__acceptance_probe__', body: undefined, owners: ['ADMIN', 'DEVELOPER'], perm: ['CONFIGURATION:EDIT:PLATFORM'], ownerSafe: true, src: 'modules/notifications/notification-admin.controller.ts' },
  { id: 'R18', method: 'POST', path: '/notification-admin/email/test', body: {}, owners: ['DEVELOPER'], perm: ['SYSTEM:EDIT:PLATFORM'], ownerSafe: true, src: 'modules/notifications/notification-admin.controller.ts' },
  { id: 'R19', method: 'POST', path: '/notification-admin/digest/run', body: {}, owners: ['DEVELOPER'], perm: ['SYSTEM:EDIT:PLATFORM'], ownerSafe: false, src: 'modules/notifications/notification-admin.controller.ts' },
  { id: 'R20', method: 'POST', path: '/admin/rule-bypass', body: {}, owners: ['ADMIN', 'DEVELOPER'], perm: ['CONFIGURATION:EDIT:PLATFORM'], ownerSafe: true, src: 'modules/platform/rule-bypass/rule-bypass.controller.ts' },
  { id: 'R21', method: 'DELETE', path: '/admin/rule-bypass', body: undefined, owners: ['ADMIN', 'DEVELOPER'], perm: ['CONFIGURATION:EDIT:PLATFORM'], ownerSafe: false, src: 'modules/platform/rule-bypass/rule-bypass.controller.ts' },
  { id: 'R22', method: 'GET', path: '/system-dashboard/metrics', body: undefined, owners: ['ADMIN', 'OPERATIONS', 'DEVELOPER'], perm: ['PROJECT:VIEW:ORGANIZATION'], ownerSafe: true, src: 'modules/user/system-dashboard.controller.ts' },
];

/**
 * What the custom role is granted. Every permission any surface or any `@RoleOnly()` route above
 * declares, so that the `@RoleOnly()` claim is tested against a role that genuinely holds the
 * matching grants rather than against one that would have been refused on the permissions anyway.
 *
 * Two things the catalogue does that this has to respect:
 *
 *  - The grantable row for a read is usually PLATFORM-scoped (`BILLING:VIEW:PLATFORM`), and
 *    `permissionKeysHeldBy` widens a PLATFORM grant to every narrower scope at check time. So
 *    asking for `BILLING:VIEW:ORGANIZATION` means granting the PLATFORM row. `resolveGrant` below
 *    does that widening in the same direction the guard does.
 *
 *  - `SYSTEM:*` cannot be granted to a custom role AT ALL — `UserService.createRole` and
 *    `setRolePermissions` both refuse it outright. That is a second, independent defence on the
 *    four `@RoleOnly()` routes that declare a SYSTEM permission, and it means the `@RoleOnly()`
 *    claim cannot be tested against a matching grant for those four: the platform will not build
 *    the role. Recorded rather than quietly dropped, because "we could not test it" and "it
 *    passed" are different results.
 */
const UNGRANTABLE_TO_CUSTOM = (key) => key.toUpperCase().startsWith('SYSTEM:');
const CUSTOM_ROLE_GRANTS = [...new Set([
  ...SURFACES.flatMap((s) => s.bePerm ?? []),
  ...SURFACES.flatMap((s) => s.fe.perms ?? []),
  ...ROLE_ONLY.flatMap((r) => r.perm),
  'ASSAYER:EDIT:ORGANIZATION', // the four @RolesFallbackPermissions routes
])].sort();

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The frontend's own verdict, reimplemented from route-permissions.ts
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Longest-prefix match, name shortcut, then the custom-role-only permission fallback. */
function canAccessRouteFE(userRoles, userPermissions, path) {
  const matches = SURFACES.filter((s) => !s.fe.notInTable
    && (path === s.page || path.startsWith(`${s.page}/`)));
  if (matches.length === 0) return { allowed: false, via: 'no matching entry (fail closed)' };
  const cfg = matches.reduce((best, s) => (s.page.length > best.page.length ? s : best)).fe;

  if (cfg.anyAuthenticated) return { allowed: true, via: 'anyAuthenticated' };
  if (expandRoles(userRoles).some((r) => cfg.roles.includes(r))) return { allowed: true, via: 'role name' };

  const known = new Set(SYSTEM_ROLES);
  if (!userRoles.some((r) => !known.has(r))) return { allowed: false, via: 'built-in role, not listed' };

  const required = cfg.perms ?? [];
  if (required.length === 0) return { allowed: false, via: 'custom role, entry declares no permission' };
  const held = new Set(userPermissions.map((p) => p.toUpperCase()));
  return required.every((p) => held.has(p.toUpperCase()))
    ? { allowed: true, via: `permission fallback (${required.join(' + ')})` }
    : { allowed: false, via: 'custom role, permission not held' };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Plumbing
// ─────────────────────────────────────────────────────────────────────────────────────────────

const results = [];
const findings = [];
let db;
let requests = 0;
let throttled = 0;

const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const record = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  [${id}] ${detail}`);
};
const note = (detail) => console.log(`  ....  ${detail}`);

/**
 * One request. A 429 is the rate limiter and is retried once after a pause; if it persists the
 * caller is handed `throttled: true` and the cell becomes UNKNOWN. It never becomes a denial —
 * "the brake was on" and "the product refused you" are different facts and this script will not
 * let one wear the other's clothes.
 */
const call = async (token, method, path, body) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    await sleep(DELAY_MS);
    requests += 1;
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      return { status: 0, throttled: false, code: null, error: err.message };
    }
    const parsed = await res.json().catch(() => null);
    if (res.status === 429) { throttled += 1; if (attempt === 0) { await sleep(2500); continue; } return { status: 429, throttled: true, code: null, body: parsed }; }
    return { status: res.status, throttled: false, code: parsed?.code ?? null, body: parsed };
  }
  return { status: 429, throttled: true, code: null };
};

/**
 * `POST /auth/login` carries its OWN brake — `@Throttle({ limit: 20, ttl: 60_000 })` on
 * AuthController, which the raised global `THROTTLE_LIMIT` does not lift. Twenty sign-ins a minute
 * per IP, shared with whatever else is pointed at this stack.
 *
 * This matters far more than it looks. A 429 here is indistinguishable from a wrong password to
 * anything that only checks "did I get a token" — so an un-paced helper walks its candidate list,
 * exhausts it against a closed door, and reports "could not sign in", or worse rotates an
 * account's password on the strength of a throttled probe. Logins are therefore paced to stay
 * under the limit, and a 429 is waited out and retried rather than counted as a failed credential.
 */
const LOGIN_GAP_MS = Number(argOf('--login-gap', 3300));
let lastLoginAt = 0;
let loginAttempts = 0;
const login = async (username, password) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = Math.max(0, LOGIN_GAP_MS - (Date.now() - lastLoginAt));
    if (wait) await sleep(wait);
    lastLoginAt = Date.now();
    loginAttempts += 1;
    const r = await call(null, 'POST', '/auth/login', { username, password });
    if (r.status !== 429 && !r.throttled) return r;
    // The login brake, not a bad credential. Wait out the window rather than guess.
    note(`login brake hit for ${username} — waiting ${15 * (attempt + 1)}s (attempt ${attempt + 1}/4)`);
    await sleep(15000 * (attempt + 1));
  }
  return { status: 429, throttled: true, body: null };
};

/**
 * Sign in, coping with a forced rotation, and idempotent across runs.
 *
 * The rotated password is tried FIRST, which is what makes the second run a no-op. A candidate is
 * only abandoned on a genuine 401 — never on a 429, and never on a network error.
 *
 * Whether a rotation is needed is read from `mustChangePassword` on the login payload and then
 * CONFIRMED against a route that is not `@PasswordChangeExempt()`. Both, because each alone has
 * failed here: an earlier version of this helper used `/users/me` as its canary, which IS exempt,
 * so it never saw the forced-change state, never rotated, and handed the probe a session whose
 * every 403 said PASSWORD_CHANGE_REQUIRED. Seventeen "permission denials" in that run were nothing
 * of the kind.
 */
const signIn = async (p, canaryPath) => {
  let throttledOut = false;
  for (const pw of p.passwords().filter(Boolean)) {
    const r = await login(p.username, pw);
    if (r.throttled) { throttledOut = true; break; }
    const token = r.body?.data?.accessToken;
    if (!token) continue;                                  // genuine 401: try the next candidate
    const user = r.body.data.user ?? {};

    const canary = await call(token, 'GET', canaryPath);
    const mustChange = user.mustChangePassword === true || canary.code === 'PASSWORD_CHANGE_REQUIRED';
    if (!mustChange) {
      return { token, id: user.id, roles: user.roles ?? [], permissions: user.permissions ?? [],
        rotated: false, canary: canary.status };
    }

    const target = p.rotateTo();
    const chg = await call(token, 'POST', p.changePath, { currentPassword: pw, newPassword: target });
    if (chg.status >= 400) { note(`${p.username}: rotation refused (${chg.status} ${chg.body?.message ?? ''})`); continue; }
    const again = await login(p.username, target);
    if (again.throttled) { throttledOut = true; break; }
    const t2 = again.body?.data?.accessToken;
    if (!t2) continue;
    const u2 = again.body.data.user ?? {};
    const c2 = await call(t2, 'GET', canaryPath);
    if (c2.code === 'PASSWORD_CHANGE_REQUIRED') { note(`${p.username}: still forced to change password after rotating`); continue; }
    return { token: t2, id: u2.id, roles: u2.roles ?? [], permissions: u2.permissions ?? [],
      rotated: true, canary: c2.status };
  }
  return throttledOut ? { throttled: true } : null;
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The custom-role fixture
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Create (or find) the custom role, give it the grants, and put a user on it. Idempotent. */
const provisionCustomRole = async (adminToken) => {
  const rolesRes = await call(adminToken, 'GET', '/users/roles');
  if (rolesRes.status !== 200) throw new Error(`cannot read the role list as admin (${rolesRes.status})`);
  let role = (rolesRes.body?.data ?? []).find((r) => r.name === CUSTOM_ROLE_NAME);
  if (!role) {
    const created = await call(adminToken, 'POST', '/users/roles', {
      name: CUSTOM_ROLE_NAME, displayName: 'Acceptance surface probe',
      description: 'Provisioned by scripts/acceptance/role-surface-matrix.mjs. Safe to delete.',
    });
    if (created.status >= 400) throw new Error(`could not create the custom role (${created.status} ${created.body?.message ?? ''})`);
    role = created.body.data;
    note(`created custom role ${CUSTOM_ROLE_NAME}`);
  }

  const catRes = await call(adminToken, 'GET', '/users/permissions');
  const catalogue = catRes.body?.data ?? [];
  const byKey = new Map(catalogue.map((p) => [`${p.resource}:${p.action}:${p.scope}`.toUpperCase(), p.id]));
  /** Exact row, else the PLATFORM row the guard widens into it. */
  const resolveGrant = (key) => {
    const k = key.toUpperCase();
    if (byKey.has(k)) return byKey.get(k);
    const [resource, action] = k.split(':');
    return byKey.get(`${resource}:${action}:PLATFORM`) ?? null;
  };

  const wanted = []; const missing = []; const refusedByPolicy = [];
  for (const key of CUSTOM_ROLE_GRANTS) {
    if (UNGRANTABLE_TO_CUSTOM(key)) { refusedByPolicy.push(key); continue; }
    const id = resolveGrant(key);
    if (id) wanted.push(id); else missing.push(key);
  }
  if (refusedByPolicy.length) {
    findings.push({ kind: 'GRANT_REFUSED_BY_POLICY', detail:
      `UserService.setRolePermissions refuses SYSTEM-level permissions to any custom role, so the @RoleOnly() `
      + `claim on the routes declaring ${refusedByPolicy.join(', ')} could not be tested against a matching grant `
      + `— those routes carry a second, independent defence` });
    note(`${refusedByPolicy.length} permission(s) cannot be granted to a custom role by policy: ${refusedByPolicy.join(', ')}`);
  }
  if (missing.length) {
    findings.push({ kind: 'UNGRANTABLE_PERMISSION', detail:
      `not in the permission catalogue at any scope, so no custom role can ever hold ${missing.length === 1 ? 'it' : 'them'}: ${missing.join(', ')}` });
    note(`${missing.length} declared permission(s) are not in the catalogue: ${missing.join(', ')}`);
  }
  const setRes = await call(adminToken, 'PUT', `/users/roles/${role.id}/permissions`, { permissionIds: [...new Set(wanted)] });
  if (setRes.status >= 400) throw new Error(`could not grant the custom role its permissions (${setRes.status} ${setRes.body?.message ?? ''})`);

  const usersRes = await call(adminToken, 'GET', '/users?limit=2000');
  let user = (usersRes.body?.data ?? []).find((u) => u.username === CUSTOM_USER);
  if (!user) {
    const created = await call(adminToken, 'POST', '/users', {
      username: CUSTOM_USER, email: `${CUSTOM_USER}@fapoms.local`, password: BOOTSTRAP_PASSWORD,
      firstName: 'Acceptance', lastName: 'CustomRole', roleIds: [role.id],
    });
    if (created.status >= 400) throw new Error(`could not create the custom-role user (${created.status} ${created.body?.message ?? ''})`);
    user = created.body.data;
    note(`created custom-role user ${CUSTOM_USER}`);
  } else {
    // Re-assert the role assignment (a previous --cleanup may have stripped it), reactivate, and
    // put the password back to the known bootstrap value. Guessing at the state a previous run
    // left behind is how the fixture ends up unusable in a way that reads as a product refusal.
    await call(adminToken, 'PUT', `/users/${user.id}/roles`, { roleIds: [role.id] });
    await call(adminToken, 'POST', '/users/bulk/status', { ids: [user.id], status: 'ACTIVE' });
    const reset = await call(adminToken, 'POST', `/users/${user.id}/reset-password`, { newPassword: BOOTSTRAP_PASSWORD });
    if (reset.status >= 400) note(`could not reset ${CUSTOM_USER}'s password (${reset.status} ${reset.body?.message ?? ''})`);
  }
  return { role, user, granted: new Set(wanted).size, missing, refusedByPolicy };
};

const cleanupCustomRole = async (adminToken) => {
  const usersRes = await call(adminToken, 'GET', '/users?limit=2000');
  const user = (usersRes.body?.data ?? []).find((u) => u.username === CUSTOM_USER);
  if (user) {
    await call(adminToken, 'PUT', `/users/${user.id}/roles`, { roleIds: [] });
    const s = await call(adminToken, 'POST', '/users/bulk/status', { ids: [user.id], status: 'SUSPENDED' });
    note(`suspended ${CUSTOM_USER} (${s.status})`);
  }
  const rolesRes = await call(adminToken, 'GET', '/users/roles');
  const role = (rolesRes.body?.data ?? []).find((r) => r.name === CUSTOM_ROLE_NAME);
  if (role) {
    const d = await call(adminToken, 'DELETE', `/users/roles/${role.id}`);
    note(`deleted role ${CUSTOM_ROLE_NAME} (${d.status}${d.status >= 400 ? ` ${d.body?.message ?? ''}` : ''})`);
  }
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────────────────────

(async () => {
  if (!AC_PASSWORD) throw new Error('AC_PASSWORD is not set — nothing can sign in without it');
  db = new Client(DBC);
  await db.connect();

  console.log(`\n=== FAPOMS acceptance — role x surface matrix ===`);
  console.log(`API ${API}`);
  console.log(`DB  ${DBC.host}:${DBC.port}/${DBC.database}  (must be the SAME database the API uses)`);
  console.log(`${SURFACES.length} surfaces, ${ROLE_ONLY.length} @RoleOnly() routes, ${PRINCIPALS.length} principals, ${DELAY_MS}ms between requests\n`);

  // ── 0. every path this script will probe must actually exist ────────────────────────────────
  // Without a token an existing guarded route answers 401 and a path this script got wrong
  // answers 404. Doing this first means no later 404 can be silently read as "denied".
  console.log('-- 0. do the paths exist? (probed WITHOUT a token: 401 = exists and is guarded) --');
  const badPaths = [];
  for (const s of SURFACES) {
    const r = await call(null, 'GET', s.path);
    if (r.status !== 401) badPaths.push(`GET ${s.path} -> ${r.status}`);
  }
  for (const r of ROLE_ONLY) {
    const res = await call(null, r.method, r.path, r.body);
    if (res.status !== 401) badPaths.push(`${r.method} ${r.path} -> ${res.status}`);
  }
  record('EX-00', badPaths.length === 0,
    badPaths.length === 0
      ? `all ${SURFACES.length + ROLE_ONLY.length} probed paths exist and are guarded (401 to an anonymous caller)`
      : `${badPaths.length} probed path(s) did not answer 401 anonymously — the table is wrong, not the product: ${badPaths.join('; ')}`);

  // ── 1. sign every principal in ──────────────────────────────────────────────────────────────
  console.log('\n-- 1. principals --');
  /**
   * Not simply the first ACTIVE assayer. Plenty of them have no `password_hash` at all — bulk
   * imported, never issued a credential — and one of those is not a principal that "could not sign
   * in", it is a row that was never able to. Candidates must have a hash, and the ones that have
   * already rotated come first so a shared account's password is not changed by a probe.
   */
  const assayerCandidates = await q(
    `SELECT assayer_code, must_change_password FROM assayers
      WHERE is_active AND lifecycle_status='ACTIVE' AND password_hash IS NOT NULL
      ORDER BY must_change_password ASC, assayer_code LIMIT 4`);
  const admin0 = await signIn(PRINCIPALS[0], '/notifications');
  if (!admin0 || admin0.throttled) {
    throw new Error(admin0?.throttled
      ? 'the login brake (20/min on POST /auth/login) would not clear — nothing could be signed in. Re-run with a larger --login-gap.'
      : 'could not sign the administrator in — nothing else can be provisioned');
  }

  const fixture = CLEANUP ? null : await provisionCustomRole(admin0.token);
  if (CLEANUP) { await cleanupCustomRole(admin0.token); await db.end(); console.log('\ncleanup done.'); process.exit(0); }

  const sessions = {};
  for (const p of PRINCIPALS) {
    // The canary must NOT be @PasswordChangeExempt(), or the forced-change state is invisible.
    const canary = p.key === 'ASSAYER' ? '/expenses/mine' : '/notifications';
    let s;
    if (p.key === 'SYSTEM_ADMIN') {
      s = admin0;
    } else if (p.key === 'ASSAYER') {
      if (!assayerCandidates.length) { record('SI-ASSAYER', false, 'no ACTIVE assayer in the database has a password hash, so none can sign in'); continue; }
      for (const cand of assayerCandidates) {
        p.username = cand.assayer_code;
        s = await signIn(p, canary);
        if (s && !s.throttled) break;
      }
    } else {
      s = await signIn(p, canary);
    }
    if (!s || s.throttled) {
      record(`SI-${p.key}`, false, s?.throttled
        ? `${p.username} could not be signed in because the LOGIN BRAKE (20/min) stayed on — this is the rate limiter, not a credential or a permission problem; re-run with a larger --login-gap`
        : `could not sign in ${p.username} as ${p.key} (credentials rejected)`);
      continue;
    }
    sessions[p.key] = { ...s, username: p.username, principal: p };
    console.log(`  ${p.key.padEnd(16)} ${p.username.padEnd(22)} roles=[${s.roles.join(',')}] permissions=${s.permissions.length}${s.rotated ? ' (rotated)' : ''}`);
  }
  if (fixture) {
    console.log(`  custom role ${CUSTOM_ROLE_NAME}: ${fixture.granted} permission(s) granted${fixture.missing.length ? `, ${fixture.missing.length} ungrantable` : ''}`);
  }

  // The custom principal must genuinely BE custom, or claim 2 tests nothing.
  const custom = sessions.CUSTOM_ROLE;
  record('CR-00', !!custom && custom.roles.length > 0 && custom.roles.every((r) => !SYSTEM_ROLES.includes(r)),
    custom ? `the custom principal holds only non-built-in roles [${custom.roles.join(',')}] — the permission fallback is in play for it`
      : 'the custom-role principal could not sign in');
  // The permission list on the login payload is already widened (a PLATFORM grant appears at every
  // narrower scope), which is the same set the frontend hands `canAccessRoute`.
  const heldByCustom = new Set((custom?.permissions ?? []).map((p) => p.toUpperCase()));
  const expectable = CUSTOM_ROLE_GRANTS.filter((g) => !UNGRANTABLE_TO_CUSTOM(g));
  const short0 = expectable.filter((g) => !heldByCustom.has(g));
  record('CR-01', !!custom && short0.length === 0,
    short0.length === 0
      ? `and it holds every one of the ${expectable.length} grants a custom role is allowed to hold `
        + `(${CUSTOM_ROLE_GRANTS.length - expectable.length} SYSTEM-level one(s) the platform refuses to grant any custom role)`
      : `the custom principal is short of ${short0.length} grant(s) it was given: ${short0.join(', ')} — claim 2 would be testing the wrong thing`);

  const keys = Object.keys(sessions);

  /**
   * Probe as a principal, refusing to let a dead session masquerade as a refusal.
   *
   * These accounts are shared with whatever else is pointed at this deployment, and a token can
   * stop working mid-run — an access token ages out, or somebody else's script rotates a password
   * and revokes every session on the account. A 401 arriving halfway through the matrix then fills
   * the rest of that principal's column with something that LOOKS exactly like a wall of correct
   * denials. It happened on the run before this one: an AUDITOR token died at surface 12 and the
   * remaining 24 cells read as refusals.
   *
   * So a 401 on a token-bearing request is never recorded. The session is re-established once and
   * the cell is re-probed; only if that fails does the cell become UNKNOWN — never `denied`.
   */
  const reauths = [];
  const probeAs = async (k, method, path, body) => {
    let r = await call(sessions[k].token, method, path, body);
    if (r.status === 401) {
      const p = sessions[k].principal;
      const canary = k === 'ASSAYER' ? '/expenses/mine' : '/notifications';
      const fresh = await signIn(p, canary);
      if (fresh && !fresh.throttled) {
        reauths.push(`${k} at ${method} ${path}`);
        sessions[k] = { ...sessions[k], ...fresh };
        r = await call(sessions[k].token, method, path, body);
      }
    }
    if (r.throttled) return { status: 'UNKNOWN', reason: 'rate limited', code: null };
    if (r.status === 401) return { status: 'UNKNOWN', reason: 'session died and could not be re-established', code: r.code };
    return { status: r.status, code: r.code };
  };

  // ── 2. the matrix ───────────────────────────────────────────────────────────────────────────
  console.log('\n-- 2. probing every surface as every principal --');
  const matrix = {};   // matrix[surfaceId][principalKey] = { status, code }
  for (const s of SURFACES) {
    matrix[s.id] = {};
    for (const k of keys) matrix[s.id][k] = await probeAs(k, 'GET', s.path);
  }
  if (reauths.length) note(`re-established ${reauths.length} session(s) that died mid-run: ${reauths.join(', ')}`);

  // ── 3. aliveness: no blanket-401 run may pass itself off as a wall of correct refusals ───────
  console.log('\n-- 3. is every principal actually alive? --');
  for (const k of keys) {
    // A 200 on a @PasswordChangeExempt() route does not count. That is the exact shape of the
    // false pass this check exists to catch.
    const wins = SURFACES.filter((s) => matrix[s.id][k].status === 200 && !s.exemptFromPasswordChange);
    record(`AL-${k}`, wins.length > 0,
      wins.length > 0
        ? `${k} (${sessions[k].username}) is a live, usable session — 200 on ${wins.length} non-exempt surface(s), e.g. ${wins[0].path}`
        : `${k} (${sessions[k].username}) got 200 on no route that requires a usable session — its refusals below prove nothing`);
  }

  // Not every 403 is an authorization decision. Two of them mean "come back after doing one
  // specific thing", and counting either as a denial is how a broken fixture gets written up as a
  // working control.
  const notReallyDenied = [];
  for (const s of SURFACES) {
    for (const k of keys) {
      const c = matrix[s.id][k];
      if (c.code === 'PASSWORD_CHANGE_REQUIRED' || c.code === 'REGISTRATION_IN_PROGRESS') {
        notReallyDenied.push(`${k} on ${s.path} (${c.code})`);
      }
    }
  }
  record('AL-CODES', notReallyDenied.length === 0,
    notReallyDenied.length === 0
      ? 'and no cell in the matrix is a PASSWORD_CHANGE_REQUIRED or REGISTRATION_IN_PROGRESS 403 wearing a denial\'s clothes'
      : `${notReallyDenied.length} cell(s) are a forced-change/onboarding 403, NOT an authorization decision: ${notReallyDenied.slice(0, 8).join('; ')}`);

  // ── 4. @RoleOnly(): refused for everyone except the owner, custom role included ──────────────
  console.log('\n-- 4. @RoleOnly() — is the @Roles list really the whole gate? --');
  const roMatrix = {};
  for (const r of ROLE_ONLY) {
    roMatrix[r.id] = {};
    for (const k of keys) {
      const isOwner = k === 'CUSTOM_ROLE' ? false : r.owners.includes(sessions[k].roles[0]) || expandRoles(sessions[k].roles).some((n) => r.owners.includes(n));
      // `owner` must be set even when the cell is skipped, or the owner falls into the non-owner
      // bucket and its SKIP is counted as an indeterminate denial.
      if (isOwner && !r.ownerSafe) { roMatrix[r.id][k] = { status: 'SKIP', owner: true, reason: 'side-effecting; owner not probed' }; continue; }
      const res = await probeAs(k, r.method, r.path, r.body);
      let cell = { ...res, owner: isOwner };
      // Re-verify every refusal that feeds a check, so a flake cannot be reported as a control.
      if (cell.status === 403) {
        const again = await probeAs(k, r.method, r.path, r.body);
        if (again.status !== 403 && typeof again.status === 'number') {
          cell = { status: `UNSTABLE(403->${again.status})`, owner: isOwner };
        }
      }
      roMatrix[r.id][k] = cell;
    }
  }

  const admitted = (c) => typeof c.status === 'number' && c.status !== 401 && c.status !== 403;
  for (const r of ROLE_ONLY) {
    const owners = keys.filter((k) => roMatrix[r.id][k].owner);
    const nonOwners = keys.filter((k) => !roMatrix[r.id][k].owner);
    const leaked = nonOwners.filter((k) => admitted(roMatrix[r.id][k]));
    const unknown = nonOwners.filter((k) => typeof roMatrix[r.id][k].status !== 'number');
    record(`RO-${r.id}`, leaked.length === 0 && unknown.length === 0,
      leaked.length === 0 && unknown.length === 0
        ? `${r.method} ${r.path.replace(U, ':id')} refuses all ${nonOwners.length} non-owners (owners ${owners.join('/') || 'none probed'})`
        : `${r.method} ${r.path.replace(U, ':id')} — ADMITTED ${leaked.map((k) => `${k}:${roMatrix[r.id][k].status}`).join(', ') || 'nobody'}`
          + (unknown.length ? `; indeterminate for ${unknown.map((k) => `${k}:${roMatrix[r.id][k].status}`).join(', ')}` : ''));
    if (leaked.includes('CUSTOM_ROLE')) {
      findings.push({ kind: 'ROLE_ONLY_BYPASSED', route: `${r.method} ${r.path}`, permission: r.perm.join(' + '),
        detail: `a custom role holding ${r.perm.join(' + ') || '(no permission — @Roles is the only gate)'} was ADMITTED (${roMatrix[r.id].CUSTOM_ROLE.status})` });
    }
    // Say plainly whether the custom role was actually carrying the grants this route names. A
    // refusal of a role that held nothing relevant proves nothing about @RoleOnly().
    r.grantMatched = r.perm.length > 0 && r.perm.every((p) => heldByCustom.has(p.toUpperCase()));
  }
  const testable = ROLE_ONLY.filter((r) => r.grantMatched);
  const untestable = ROLE_ONLY.filter((r) => !r.grantMatched);
  record('RO-CUSTOM', testable.length > 0 && testable.every((r) => !admitted(roMatrix[r.id].CUSTOM_ROLE)),
    `on the ${testable.length} @RoleOnly() route(s) whose exact permissions the custom role DOES hold `
    + `(${testable.map((r) => r.id).join(', ')}), it was refused every time — @RoleOnly() is not satisfiable by permissions. `
    + `The other ${untestable.length} (${untestable.map((r) => r.id).join(', ')}) declare either no permission or a SYSTEM-level one no custom role may hold.`);
  const ownerProved = ROLE_ONLY.filter((r) => r.ownerSafe && keys.some((k) => roMatrix[r.id][k].owner && admitted(roMatrix[r.id][k])));
  const ownerBlocked = ROLE_ONLY.filter((r) => r.ownerSafe && !keys.some((k) => roMatrix[r.id][k].owner && admitted(roMatrix[r.id][k])));
  record('RO-OWNER', ownerBlocked.length === 0,
    ownerBlocked.length === 0
      ? `and every one of the ${ownerProved.length} safely-probeable @RoleOnly() routes DOES admit its owner (a 400/404 past the guard, nothing executed)`
      : `${ownerBlocked.length} @RoleOnly() route(s) refused their own owner: ${ownerBlocked.map((r) => r.id).join(', ')} — the denials above may be measuring a broken fixture`);
  record('RO-COUNT', ROLE_ONLY.length === 22,
    `this table carries ${ROLE_ONLY.length} @RoleOnly() routes (19 decorator sites; outbox.controller.ts declares it once at class level for 4 handlers)`);

  // ── 5. the divergence: the frontend's fallback against the API's ────────────────────────────
  console.log('\n-- 5. where the web app would let a custom role in, does the API agree? --');
  const divergences = [];
  const agreements = [];
  if (custom) {
    for (const s of SURFACES) {
      if (s.fe.notInTable) continue;
      const verdict = canAccessRouteFE(custom.roles, custom.permissions, s.page);
      const cell = matrix[s.id].CUSTOM_ROLE;
      if (!verdict.allowed) continue;                       // the web app hides it too; no divergence
      if (typeof cell.status !== 'number') continue;        // throttled: unknown, never a finding
      if (cell.status === 200) { agreements.push({ ...s, verdict, status: cell.status }); continue; }
      // Re-verify before calling it a divergence.
      const again = await call(custom.token, 'GET', s.path);
      divergences.push({
        id: s.id, page: s.page, path: s.path, permission: (s.fe.perms ?? []).join(' + '),
        feVerdict: `GRANT via ${verdict.via}`, apiStatus: cell.status, apiRecheck: again.status,
        apiCode: cell.code, beRoles: s.beRoles, bePerm: s.bePerm, beFallback: s.beFallback, src: s.src,
        stable: again.status === cell.status,
      });
    }
  }
  for (const d of divergences) {
    findings.push({ kind: 'FE_GRANTS_API_REFUSES', route: `GET ${d.path}`, page: d.page,
      permission: d.permission, detail: `web app opens ${d.page} for a custom role holding ${d.permission}; `
        + `the API answers ${d.apiStatus} (re-checked: ${d.apiRecheck}) because ${d.path} declares `
        + `@Roles(${(d.beRoles ?? []).join(', ')}) with no fallback decorator [${d.src}]` });
  }

  // Predicted from the decorators: FE grants, and the backing route has a @Roles list with no
  // fallback opt-in. The check is that reality contains no SURPRISES in either direction.
  const predicted = SURFACES.filter((s) => {
    if (s.fe.notInTable || !custom) return false;
    if (!canAccessRouteFE(custom.roles, custom.permissions, s.page).allowed) return false;
    return Array.isArray(s.beRoles) && s.beRoles.length > 0 && !s.beFallback;
  }).map((s) => s.id);
  const observed = divergences.map((d) => d.id);
  const surpriseRefusals = observed.filter((id) => !predicted.includes(id));
  const surpriseAdmissions = predicted.filter((id) => !observed.includes(id));
  record('DIV-00', surpriseRefusals.length === 0 && surpriseAdmissions.length === 0,
    surpriseRefusals.length === 0 && surpriseAdmissions.length === 0
      ? `the divergence is exactly where the decorators say it is: ${observed.length} route(s) the web app opens and the API refuses`
      : `unexplained: refused but not predicted [${surpriseRefusals.join(', ') || '-'}]; predicted but admitted [${surpriseAdmissions.join(', ') || '-'}]`);
  record('DIV-01', divergences.every((d) => d.stable),
    divergences.every((d) => d.stable)
      ? `and every one of those ${divergences.length} refusals reproduced on a second request`
      : `unstable: ${divergences.filter((d) => !d.stable).map((d) => `${d.path} ${d.apiStatus}->${d.apiRecheck}`).join(', ')}`);
  const fbSurfaces = SURFACES.filter((s) => s.beFallback === 'AllowPermissionFallback');
  const fbWorking = fbSurfaces.filter((s) => matrix[s.id].CUSTOM_ROLE.status === 200);
  record('DIV-02', fbSurfaces.length > 0 && fbWorking.length === fbSurfaces.length,
    fbWorking.length === fbSurfaces.length
      ? `where the backend DOES opt in (@AllowPermissionFallback on ${fbSurfaces.map((s) => s.path).join(', ')}), the custom role is admitted — so the mechanism works, it is just not applied`
      : `a route with @AllowPermissionFallback still refused the custom role: ${fbSurfaces.filter((s) => matrix[s.id].CUSTOM_ROLE.status !== 200).map((s) => `${s.path} -> ${matrix[s.id].CUSTOM_ROLE.status}`).join(', ')}`);

  // ── 6. 403 vs 404: which surfaces hide their existence? ──────────────────────────────────────
  console.log('\n-- 6. 403 or 404? (statuses are recorded as given, never normalised) --');
  const hidden = [];
  for (const s of SURFACES) {
    for (const k of keys) {
      if (matrix[s.id][k].status === 404) hidden.push(`${s.path} -> ${k}:404`);
    }
  }
  record('HD-00', true,
    hidden.length === 0
      ? 'no surface answered 404 to a principal it refused — every refusal is an honest 403'
      : `${hidden.length} cell(s) answered 404 rather than 403 (existence hidden, or a genuinely empty resource): ${hidden.join(', ')}`);
  if (hidden.length) findings.push({ kind: 'REFUSED_AS_404', detail: hidden.join(', ') });

  // ── 6b. is @RequirePermissions actually enforced where it is declared? ───────────────────────
  /**
   * `@RequirePermissions` only bites if `PermissionsGuard` is in the controller's `@UseGuards`
   * chain — it is NOT a global guard (app.module.ts registers only the throttler as APP_GUARD),
   * and `RolesGuard` reads the permission metadata only inside its custom-role fallback branch.
   * A controller that lists `@UseGuards(JwtAuthGuard, RolesGuard)` therefore declares permissions
   * that decide nothing for any caller matched by role name.
   *
   * This is observable without reading a line of source: if a principal was served 200 by a route
   * that declares a permission the principal does not hold, that permission is not being enforced.
   * Silence here is NOT proof of the opposite — it can equally mean every role named on those
   * routes happens to hold the grant, which is exactly what makes the gap easy to miss.
   */
  console.log('\n-- 6b. is @RequirePermissions enforced where it is declared? --');
  const permHoles = [];
  for (const s of SURFACES) {
    if (!s.bePerm?.length) continue;
    for (const k of keys) {
      if (matrix[s.id][k].status !== 200) continue;
      const held = new Set((sessions[k].permissions ?? []).map((p) => p.toUpperCase()));
      const short1 = s.bePerm.filter((p) => !held.has(p.toUpperCase()));
      if (short1.length) permHoles.push({ path: s.path, principal: k, missing: short1, src: s.src });
    }
  }
  record('PG-00', permHoles.length === 0,
    permHoles.length === 0
      ? 'no principal was served by a route whose declared permission it does not hold '
        + '(note: this cannot prove the permission is enforced, only that nothing contradicts it)'
      : `${permHoles.length} case(s) of a 200 from a route declaring a permission the caller does not hold — `
        + `@RequirePermissions is not being enforced there: `
        + permHoles.map((h) => `${h.principal} got 200 from ${h.path} without ${h.missing.join('+')}`).join('; '));
  for (const h of permHoles) {
    findings.push({ kind: 'PERMISSION_NOT_ENFORCED', route: `GET ${h.path}`, permission: h.missing.join(' + '),
      detail: `${h.principal} was served 200 without holding ${h.missing.join(' + ')} [${h.src}]` });
  }

  // ── 7. and were they still alive at the END? ─────────────────────────────────────────────────
  // Aliveness proved only at the start certifies nothing about the cells recorded afterwards.
  console.log('\n-- 7. was every session still alive when the probing finished? --');
  const died = [];
  for (const k of keys) {
    const c = await call(sessions[k].token, 'GET', k === 'ASSAYER' ? '/expenses/mine' : '/notifications');
    if (c.status === 401) died.push(`${k} (${sessions[k].username})`);
  }
  record('AL-END', died.length === 0,
    died.length === 0
      ? `all ${keys.length} sessions were still live after ${requests} requests, so every refusal above was recorded by a working token`
      : `${died.length} session(s) were dead by the end: ${died.join(', ')} — cells recorded for them may be session failures, not decisions`);
  const unknowns = [];
  for (const s of SURFACES) for (const k of keys) if (matrix[s.id][k].status === 'UNKNOWN') unknowns.push(`${k}@${s.path} (${matrix[s.id][k].reason})`);
  record('AL-UNK', unknowns.length === 0,
    unknowns.length === 0
      ? 'and no cell in the matrix is UNKNOWN — nothing was left indeterminate by the rate limiter or a dead token'
      : `${unknowns.length} indeterminate cell(s), recorded as UNKNOWN rather than as denials: ${unknowns.slice(0, 6).join('; ')}`);

  // ── output ──────────────────────────────────────────────────────────────────────────────────
  const short = (v) => (typeof v === 'number' ? String(v) : String(v).slice(0, 9));
  console.log('\n\n## Matrix — role x surface (HTTP status of a GET)\n');
  console.log(`| id | page | GET | ${keys.join(' | ')} |`);
  console.log(`|---|---|---|${keys.map(() => '---').join('|')}|`);
  for (const s of SURFACES) {
    console.log(`| ${s.id} | \`${s.page}\` | \`${s.path}\` | ${keys.map((k) => short(matrix[s.id][k].status)).join(' | ')} |`);
  }

  console.log('\n## Matrix — @RoleOnly() routes (real verb; 400/404 = the guard admitted, nothing ran)\n');
  console.log(`| id | route | owners | permission | ${keys.join(' | ')} |`);
  console.log(`|---|---|---|---|${keys.map(() => '---').join('|')}|`);
  for (const r of ROLE_ONLY) {
    console.log(`| ${r.id} | \`${r.method} ${r.path.replace(U, ':id')}\` | ${r.owners.join(', ')} | ${r.perm.join(' + ') || '(none)'} | `
      + `${keys.map((k) => short(roMatrix[r.id][k].status)).join(' | ')} |`);
  }

  if (divergences.length) {
    console.log('\n## Findings — the web app grants, the API refuses (step 5)\n');
    console.log('| page | backing GET | permission the web app honours | frontend | API | backend gate |');
    console.log('|---|---|---|---|---|---|');
    for (const d of divergences) {
      console.log(`| \`${d.page}\` | \`GET ${d.path}\` | ${d.permission} | ${d.feVerdict} | **${d.apiStatus}**${d.apiCode ? ` ${d.apiCode}` : ''} (recheck ${d.apiRecheck}) | @Roles(${(d.beRoles ?? []).join(', ')}), no fallback |`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed — ${requests} requests, ${throttled} throttled ===`);
  for (const f of failed) console.log(`  FAILED [${f.id}] ${f.detail}`);
  console.log(`\n${findings.length} finding(s):`);
  for (const f of findings) console.log(`  - [${f.kind}] ${f.route ?? ''} ${f.detail}`);
  console.log(`\nFixture left in place: role ${CUSTOM_ROLE_NAME}, user ${CUSTOM_USER}. Re-run to reuse; --cleanup to remove.`);

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({
      api: API, generatedAt: new Date().toISOString(), requests, throttled, loginAttempts, reauths,
      principals: Object.fromEntries(keys.map((k) => [k, {
        username: sessions[k].username, roles: sessions[k].roles, permissionCount: sessions[k].permissions.length,
      }])),
      surfaces: SURFACES.map((s) => ({ ...s, statuses: matrix[s.id] })),
      roleOnly: ROLE_ONLY.map((r) => ({ ...r, statuses: roMatrix[r.id] })),
      divergences, agreements: agreements.map((a) => ({ id: a.id, page: a.page, path: a.path, status: a.status })),
      checks: results, findings,
    }, null, 2));
    console.log(`\nJSON written to ${JSON_OUT}`);
  }

  await db.end();
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => {
  console.error('\nABORTED:', e.message);
  try { await db?.end(); } catch {}
  process.exit(2);
});
