import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * One authoritative answer to "which pages does a role built in Admin → Roles get?"
 *
 * ## The disagreement this ends
 *
 * Two tables decided that question and neither could see the other.
 *
 * The web app's `config/route-permissions.ts` opens a page to a custom role whenever the entry
 * names a permission the role holds. The API opens a route to a custom role only when the handler
 * has explicitly opted in, with `@AllowPermissionFallback()` or `@RolesFallbackPermissions(...)` —
 * without one, `RolesGuard` treats `@Roles(...)` as a closed whitelist of built-in names and
 * refuses an unrecognised role before it ever reads a permission.
 *
 * The web app applied the rule to every route declaring `requiredPermissions`. The API implemented
 * it on two. Measured live: a custom role holding 15 grants signed in, was offered ten navigation
 * entries, and nine of the ten backing APIs answered 403 — and each page rendered the refusal
 * differently, the worst of them (`/scheduling`) as "0 active schedules", an empty calendar and
 * "No audits scheduled for this date".
 *
 * ## What this spec is
 *
 * The map, written down once, with each row saying which way it was decided and why. It then
 * checks BOTH halves against their own source, so the two can no longer drift:
 *
 *  - `honoursFallback: true`  — the handler must carry the opt-in, and the web app's entry must
 *                              name the permission.
 *  - `honoursFallback: false` — the handler must NOT carry it, and the web app's entry must NOT
 *                              name a permission, so the page is not offered at all.
 *
 * Either state is a legitimate answer. A page that opens and cannot fill itself is not.
 */

const SRC = join(__dirname, '..', '..');
const FRONTEND_ROUTE_PERMISSIONS = join(
  __dirname, '..', '..', '..', '..', 'frontend', 'src', 'config', 'route-permissions.ts',
);

type Row = {
  /** The web app path a person navigates to. */
  page: string;
  /** The API call that fills it. */
  route: string;
  /** Source file, relative to `packages/backend/src`. */
  file: string;
  /** The handler method, used to find its decorator block. */
  handler: string;
  /** Whether a custom role holding the permission may call it. */
  honoursFallback: boolean;
  /** Why it was decided that way. */
  because: string;
};

/**
 * The primary fetch of each page a custom role could be offered, and the decision for it.
 *
 * "Primary" means the call without which the page has nothing to show. Secondary panels are listed
 * separately below, because a page whose main content loads and whose side panel says plainly why
 * it is empty is a working page; one that draws zeros over a refusal is not.
 */
const PAGES: Row[] = [
  {
    page: '/dashboard', route: 'GET /system-dashboard/operations',
    file: 'modules/user/system-dashboard.controller.ts', handler: 'getOperations',
    honoursFallback: true,
    because:
      'project:view:organization is deliberately the lowest common grant of the six roles this '
      + 'serves — the floor of the app. The payload is assembled per role, and an unrecognised '
      + 'role gets the two project-shaped sections (see UNRECOGNISED_ROLE_SECTIONS), not an '
      + "auditor's national audit-trail feed.",
  },
  {
    page: '/executive-map', route: 'GET /planning/command-center',
    file: 'modules/planning/planning.controller.ts', handler: 'commandCenter',
    honoursFallback: true,
    because: 'planning:view:organization is the gate; every planning READ on this controller honours it.',
  },
  {
    /**
     * The row that shows why "primary fetch" has to mean what fills the page, not what the page is
     * named after. `GET /planning/day-plans` honours the fallback and would answer this role — but
     * the workspace is keyed on a project it gets from `GET /projects`, and without that list it
     * announces "No branches in this project yet", which is a refusal wearing an empty state.
     */
    page: '/planning', route: 'GET /projects (the project picker this page is keyed on)',
    file: 'modules/project/project.controller.ts', handler: 'findAll',
    honoursFallback: false,
    because:
      'modules/project/** belongs to another workstream. GET /planning/* does honour the fallback '
      + '(see the note on PlanningController); the project list it needs does not, so the page is '
      + 'not offered. @RolesFallbackPermissions(\'project:view:organization\') on '
      + 'ProjectController.findAll flips this row.',
  },
  {
    page: '/scheduling', route: 'GET /schedules',
    file: 'modules/scheduling/scheduling.controller.ts', handler: 'findAll',
    honoursFallback: true,
    because:
      "scheduling:view:organization is the gate. CLIENT_USER's ceiling on this route is enforced "
      + "by findAll's branchScopeWhere(scope) on the data, not by the name on the @Roles line, so "
      + 'a custom role is scoped by the same call.',
  },
  {
    page: '/billing', route: 'GET /billing-engine/overview',
    file: 'modules/billing-engine/billing-engine.controller.ts', handler: 'overview',
    honoursFallback: true,
    because:
      'billing:view:organization opens the read side of the book. Nothing on the money-out side '
      + 'moves: create, edit and approve keep their name gates.',
  },
  {
    page: '/documents', route: 'GET /documents/operations/overview',
    file: 'modules/document/document.controller.ts', handler: 'operationsOverview',
    honoursFallback: true,
    because: 'document:view:organization; the route already declared it and its own comment already promised it.',
  },
  {
    page: '/users', route: 'GET /users',
    file: 'modules/user/user.controller.ts', handler: 'findAll',
    honoursFallback: true,
    because:
      'user:view:organization is a read. Every WRITE here stays a name, because '
      + 'PUT /users/roles/:id/permissions grants any key in the catalogue and PUT /users/:id/roles '
      + 'assigns any role — one grantable step from a custom role to ADMIN.',
  },
  {
    page: '/admin/rule-bypass', route: 'GET /admin/rule-bypass/catalogue',
    file: 'modules/platform/rule-bypass/rule-bypass.controller.ts', handler: 'catalogue',
    honoursFallback: true,
    because: 'the route that already worked, and the pattern every row above now follows.',
  },

  // ── The other answer: not offered, because the API will not serve it ────────────────────────

  {
    page: '/hr', route: 'GET /hr/workforce',
    file: 'modules/assayer/hr.controller.ts', handler: 'workforce',
    honoursFallback: false,
    because:
      'modules/assayer/** belongs to another workstream and this handler cannot be edited here. '
      + 'It declares assayer:view:organization and refuses every custom role, so the web app stops '
      + 'offering the page. One @AllowPermissionFallback() here flips this row to true.',
  },
  {
    page: '/data-entry', route: 'GET /validation/attention',
    file: 'modules/validation/validation.controller.ts', handler: 'attention',
    honoursFallback: false,
    because:
      'modules/validation/** belongs to another workstream. All three of the desk overview fetches '
      + '(attention, workload, activity) declare validation:view:organization and honour none of it.',
  },
];

/**
 * Panels that are not the page's main content, and what a custom role sees where they sit.
 *
 * Listed so the decision is on the record rather than discovered later as a blank card. Each of
 * these now renders the reason it is empty (see `components/LoadFailure.tsx`) instead of a zero.
 */
const SECONDARY: Row[] = [
  {
    page: '/scheduling', route: 'GET /assignments',
    file: 'modules/assignment/assignment.controller.ts', handler: 'findAll',
    honoursFallback: true,
    because:
      'the unscheduled-offer queue. @RolesFallbackPermissions and not @RequirePermissions, because '
      + 'PermissionsGuard enforces the latter on EVERY caller and PRODUCT_SUPPORT — on STAFF_ROLES '
      + 'here — holds no grants at all, so requiring one would take this list away from a role that '
      + 'reads it today.',
  },
  {
    page: '/scheduling', route: 'GET /holidays',
    file: 'modules/holiday/holiday.controller.ts', handler: 'findAll',
    honoursFallback: true,
    because: 'bank-holiday shading on the calendar; reference data, gated as reference data.',
  },
];

/** The decorator block above a handler: everything from the end of the previous member. */
function decoratorBlockOf(file: string, handler: string): string {
  const path = join(SRC, file);
  if (!existsSync(path)) throw new Error(`${file} does not exist — this map names a file that is gone`);
  const lines = readFileSync(path, 'utf8').split('\n');
  const sigAt = lines.findIndex((l) => new RegExp(`^\\s+(?:async\\s+)?${handler}\\s*\\(`).test(l));
  if (sigAt < 0) throw new Error(`${file}: no handler named ${handler}`);
  // Walk back to the previous member's closing brace (two-space indent) or the class line.
  let start = 0;
  for (let i = sigAt - 1; i >= 0; i--) {
    if (/^ {2}}\s*$/.test(lines[i]) || /^export class /.test(lines[i])) { start = i + 1; break; }
  }
  return lines.slice(start, sigAt + 1).join('\n');
}

/** What the web app's routing table says about a page: does its entry name a permission? */
function frontendNamesAPermission(page: string): boolean {
  const src = readFileSync(FRONTEND_ROUTE_PERMISSIONS, 'utf8');
  // Entries are object literals; find the one whose `path:` is this page and read to its close.
  const at = src.indexOf(`path: '${page}',`);
  if (at < 0) throw new Error(`route-permissions.ts has no entry for ${page}`);
  const end = src.indexOf('\n  },', at);
  return src.slice(at, end === -1 ? undefined : end).includes('requiredPermissions:');
}

const OPT_IN = /@AllowPermissionFallback\(\)|@RolesFallbackPermissions\(/;

describe('the pages a role built in Admin → Roles is offered', () => {
  /**
   * A broken search must not read as a clean result — the same guard `route-permission-parity.spec`
   * puts on its own grep.
   */
  it('finds every handler it names, so a rename cannot quietly empty this map', () => {
    for (const row of [...PAGES, ...SECONDARY]) {
      expect(decoratorBlockOf(row.file, row.handler).length).toBeGreaterThan(0);
    }
    expect(PAGES.length + SECONDARY.length).toBeGreaterThanOrEqual(12);
  });

  describe.each([...PAGES, ...SECONDARY])('$page ← $route', (row) => {
    it(`${row.honoursFallback ? 'lets a custom role in' : 'refuses every custom role'}`, () => {
      const block = decoratorBlockOf(row.file, row.handler);
      expect(OPT_IN.test(block)).toBe(row.honoursFallback);
    });
  });

  describe.each(PAGES)('$page, in the web app routing table', (row) => {
    /**
     * The half that closes the loop. A page whose API refuses custom roles must not name a
     * permission, or the navigation offers a page that cannot fill itself; a page whose API serves
     * them must name one, or the capability exists and nothing can reach it.
     */
    it(`${row.honoursFallback ? 'names the permission' : 'names no permission'} — ${row.because}`, () => {
      expect(frontendNamesAPermission(row.page)).toBe(row.honoursFallback);
    });
  });
});

/**
 * The line that must not move.
 *
 * `@RoleOnly()` marks a route whose `@Roles` list is the whole gate, and it exists because a few
 * routes deliberately declare the SAME permission as a broader one — the narrow role list is the
 * only thing between them. Widening the fallback across the codebase is exactly the change that
 * could erode it by accident, so it is asserted here, next to that widening.
 */
describe('@RoleOnly() stays unsatisfiable by any permission', () => {
  const ROLE_ONLY_ROUTES: { file: string; handler: string; what: string }[] = [
    { file: 'infrastructure/data-reset/data-reset.controller.ts', handler: 'approveRequest', what: 'approving a data wipe' },
    { file: 'infrastructure/data-reset/data-reset.controller.ts', handler: 'rejectRequest', what: 'rejecting a data wipe' },
    { file: 'infrastructure/settings/platform-settings.controller.ts', handler: 'set', what: 'writing a platform setting' },
    { file: 'infrastructure/settings/platform-settings.controller.ts', handler: 'reset', what: 'clearing a platform setting' },
    { file: 'modules/user/system-dashboard.controller.ts', handler: 'getMetrics', what: 'the platform-wide aggregates' },
    { file: 'modules/platform/rule-bypass/rule-bypass.controller.ts', handler: 'enable', what: 'suspending a business rule' },
    { file: 'modules/platform/rule-bypass/rule-bypass.controller.ts', handler: 'disable', what: 'ending a bypass window early' },
  ];

  it.each(ROLE_ONLY_ROUTES)('$what is still @RoleOnly()', ({ file, handler }) => {
    expect(decoratorBlockOf(file, handler)).toContain('@RoleOnly()');
  });

  /**
   * And the two decorators are mutually exclusive by construction: `RolesGuard` reads `@RoleOnly`
   * first and throws, so a route carrying both would silently be role-only. Carrying both is
   * therefore always a mistake, and this catches it in either direction.
   */
  it('no route in this codebase carries both @RoleOnly() and a permission fallback', () => {
    for (const { file, handler } of ROLE_ONLY_ROUTES) {
      expect(OPT_IN.test(decoratorBlockOf(file, handler))).toBe(false);
    }
  });
});
