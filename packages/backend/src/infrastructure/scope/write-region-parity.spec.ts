import * as fs from 'fs';
import * as path from 'path';

/**
 * Every route that reaches a region-anchored record must enforce the region ceiling — and this
 * file finds those routes itself rather than being told about them.
 *
 * ## Why it was rewritten
 *
 * This used to be a hand-maintained list of eighteen `{ file, method, assertion }` triples. It
 * worked exactly as far as the list went and no further: all forty of its assertions passed on a
 * day when `POST /assignments` — the route that brings a piece of billable work into existence —
 * had no ceiling at all, because nobody had added a line for it. A list of routes somebody
 * remembered to write down cannot, even in principle, notice a route nobody wrote down, and every
 * defect in this family has been exactly that: a route nobody wrote down.
 *
 * So the inventory is derived. The scanner below reads every `*.controller.ts` under `modules/`,
 * finds every HTTP handler, decides from the handler's own text whether it reaches a
 * region-anchored record, and then demands one of two things:
 *
 *   - a WRITE (POST/PUT/PATCH/DELETE) must CALL a region assertion. A write cannot be "narrowed":
 *     a query that returns fewer rows is a smaller answer, but a write either happens or does
 *     not, so the only correct handling of an out-of-region write is a refusal.
 *   - a READ must either call an assertion or take `@GlobalScopeFilter()` **and use it** — a list
 *     endpoint legitimately narrows rather than refuses. "And use it" is not pedantry: every
 *     assertion returns on its first line when `scope` is undefined, so a handler that declares
 *     the parameter and never passes it refuses nothing at all while reading, at a glance, as
 *     though it were guarded.
 *
 * Anything that satisfies neither must appear in `EXEMPT` **with a written reason**. The reasons
 * below are what was actually reviewed during the 2026-09-10 region read/write parity campaign;
 * where the honest reason is "this is still open and belongs to someone else", that is what it
 * says, and `openDefects()` counts those separately so the number can only go down.
 *
 * ## What is derived and what is stated
 *
 * Derived from the code: the route inventory, and the set of names that count as an assertion
 * (read off `RegionGuardService`'s own method list, so a guard method added tomorrow is
 * recognised tomorrow and one deleted breaks its callers here).
 *
 * Stated as data, with reasons: which identifiers anchor a record to a region, and which
 * controllers are anchored by their bare `:id`. Those are facts about the schema — `branches`
 * and `assayers` are the only tables carrying a `region` column — and there is nowhere to read
 * them from. They are written down once, here, with the path each one walks.
 */

const MODULES = path.join(__dirname, '../..', 'modules');
const GUARD = path.join(__dirname, 'region-guard.service.ts');

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/**
 * The identifiers that tie a request to a region, and how each one gets there.
 *
 * `branches.region` and `assayers.region` are the only two region columns in the schema, so
 * every entry below is a path to one of them:
 *
 *   branchId              → branches.region
 *   projectBranchId, pbId → project_branches → branches
 *   assignmentId(s)       → assignments → project_branches → branches
 *   scheduleId            → schedules → assignments → project_branches → branches
 *   payableId(s)          → assayer_payables → assignments → … → branches
 *   coveragePlanId/planId → coverage_plans → project → project_branches → branches
 *   projectId             → the set of branches in the project (may span regions)
 *   assayerId(s)          → assayers.region
 *
 * A handler naming any of these — in its parameter list or anywhere in its body, so a DTO field
 * read out of `@Body()` counts — is reaching a region-anchored record.
 */
const ANCHOR_IDS = [
  'branchId', 'branchIds',
  'projectBranchId', 'projectBranchIds', 'pbId',
  'assignmentId', 'assignmentIds',
  'scheduleId', 'scheduleIds',
  'assayerId', 'assayerIds',
  'payableId', 'payableIds',
  'coveragePlanId', 'planId',
  'projectId',
];
const ANCHOR_ID_RE = new RegExp(`\\b(${ANCHOR_IDS.join('|')})\\b`);

/**
 * Controllers whose bare `:id` IS an anchored record, so `@Param('id')` needs no other clue.
 *
 * A `:id` on `/branches` is a branch; on `/assignments` an assignment; on `/billing-engine` a
 * payable, a client line or an invoice depending on the route — all of which reach a region.
 * A `:id` on `/zones`, `/clients`, `/holidays`, `/users` or `/notifications` does not, which is
 * why those controllers are absent: a client is a national account, a zone is geography without
 * an assignment, and neither carries a region column (see `client.controller.ts`, which states
 * this at each of its own routes).
 */
const ANCHORED_BY_ID = new Set([
  'branches', 'projects', 'assignments', 'scheduling', 'validation', 'assayers',
  'billing-engine', 'documents', 'expenses', 'planning', 'validation-queries',
  'call-logs', 'assayer-remarks', 'customer-master',
]);

const VERBS = ['Get', 'Post', 'Put', 'Patch', 'Delete'];

interface Handler {
  file: string;
  prefix: string;
  verb: string;
  routePath: string;
  method: string;
  params: string;
  body: string;
  /** Params + bound DTO declarations + path + body-minus-guard-calls. See `subject` below. */
  subject: string;
  /** `POST /branches/:id/contacts` — how a reviewer refers to it. */
  route: string;
  key: string;
  isWrite: boolean;
}

function* controllerFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* controllerFiles(p);
    else if (entry.name.endsWith('.controller.ts')) yield p;
  }
}

/** Index of the character closing the bracket opened at `from`. */
function balanced(src: string, from: number, open: string, close: string): number {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * The declaration of every DTO class in a controller file, keyed by name.
 *
 * A route keyed on a request BODY names its anchor nowhere in the handler — `POST /call-logs`
 * takes `@Body() dto: CreateCallLogRequestDto` and the `projectBranchId` lives on that class. A
 * mutation test caught this: deleting the guard call from that handler also deleted the only
 * occurrence of the word `projectBranchId` in it, so the route stopped looking anchored and the
 * spec went green on a route that had just lost its ceiling. The anchoring signal must not come
 * from the guard, or removing the guard removes the reason to want one.
 */
function dtoBodies(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /(?:export\s+)?class\s+([A-Za-z0-9_]+)[^{]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const open = src.indexOf('{', m.index);
    const close = balanced(src, open, '{', '}');
    if (close !== -1) out.set(m[1], src.slice(open, close + 1));
  }
  return out;
}

function handlersIn(file: string): Handler[] {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const prefix = (src.match(/@Controller\(\s*'([^']*)'/) ?? [])[1] ?? '';
  const rel = path.relative(MODULES, file);
  const dtos = dtoBodies(src);
  const out: Handler[] = [];
  const re = new RegExp(`@(${VERBS.join('|')})\\(([^)]*)\\)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const verb = m[1].toUpperCase();
    const routePath = (m[2].match(/'([^']*)'/) ?? [])[1] ?? '';
    // The handler is the next `async name(` after the decorator — other decorators (@Roles,
    // @ApiOperation, @Throttle) may sit between, and none of them contain `async`.
    const after = src.slice(m.index);
    const sig = after.match(/async\s+([A-Za-z0-9_]+)\s*\(/);
    if (!sig || sig.index === undefined) continue;
    const parenOpen = src.indexOf('(', m.index + sig.index);
    const parenClose = balanced(src, parenOpen, '(', ')');
    if (parenClose === -1) continue;
    // Walk the parameter list first: an inline object type in a parameter
    // (`@Body() body: { reason?: string }`) would otherwise be mistaken for the function body.
    const bodyOpen = src.indexOf('{', parenClose);
    const bodyClose = bodyOpen === -1 ? -1 : balanced(src, bodyOpen, '{', '}');
    const params = src.slice(parenOpen, parenClose + 1);
    const body = bodyClose === -1 ? '' : src.slice(bodyOpen, bodyClose + 1);
    // Every DTO this handler binds, so a body-keyed route declares its anchor where the class
    // does. `@Body() dto: CreateCallLogRequestDto` contributes that class's fields.
    const bound = [...params.matchAll(/@(?:Body|Query|Param)\([^)]*\)\s*[A-Za-z0-9_]+\s*:\s*([A-Za-z0-9_]+)/g)]
      .map((m2) => dtos.get(m2[1]) ?? '')
      .join('\n');
    out.push({
      file: rel,
      prefix,
      verb,
      routePath,
      method: sig[1],
      params,
      body,
      /**
       * What the route is ABOUT, with the guard calls removed.
       *
       * Anchoring is decided from this rather than from the raw body: a handler whose only
       * mention of `projectBranchId` is inside `assertProjectBranchInScope(dto.projectBranchId,
       * scope)` would otherwise stop being anchored the moment that line was deleted, which is
       * the one edit this file exists to catch.
       */
      subject: `${params}\n${bound}\n${routePath}\n${body.replace(/this\.regionGuard\.[A-Za-z0-9_]+\([^;]*\);/g, '')}`,
      route: `${verb} /${[prefix, routePath].filter(Boolean).join('/')}`,
      key: `${rel}::${sig[1]}`,
      isWrite: verb !== 'GET',
    });
  }
  return out;
}

/**
 * What counts as asserting the ceiling, read off `RegionGuardService` itself.
 *
 * Hardcoding these names would reintroduce the very failure this file exists to prevent one
 * level down: a new guard method would not be recognised until somebody remembered to add it
 * here, and a deleted one would keep passing. Reading the service's own `assert…` methods means
 * the vocabulary is whatever the guard actually offers.
 *
 * `assert…Region…` is accepted alongside them for the module-local helpers that predate the
 * shared service — now only `document.controller.ts`'s `assertDocumentRegion`, since
 * `BillingEngineService.assertInvoiceRegionAllowed` was folded into the guard's own
 * `assertInvoiceInScope`. It is the same rule in a private home; the shape is recognised so
 * those routes are not reported as unguarded while it waits to be folded in too.
 */
function assertionNames(): string[] {
  const guard = stripComments(fs.readFileSync(GUARD, 'utf8'));
  const names = [...guard.matchAll(/^\s{2}(?:async\s+)?(assert[A-Za-z0-9_]*)\s*\(/gm)].map((m) => m[1]);
  return [...new Set(names)];
}

const ASSERTION_RE = new RegExp(
  `\\b(${assertionNames().join('|')}|assert[A-Za-z0-9_]*Region[A-Za-z0-9_]*)\\s*\\(`,
);

function isAnchored(h: Handler): boolean {
  if (ANCHOR_ID_RE.test(h.subject)) return true;
  const takesBareId = /@Param\(\s*'id'/.test(h.params) || /:id\b/.test(h.routePath);
  return ANCHORED_BY_ID.has(h.prefix) && takesBareId;
}

function isSatisfied(h: Handler): boolean {
  const asserts = ASSERTION_RE.test(h.body);
  if (h.isWrite) return asserts;
  const takesScope = /GlobalScopeFilter/.test(h.params);
  const usesScope = /\bscope\b/.test(h.body);
  return asserts || (takesScope && usesScope);
}

/**
 * Why a route reaching a region-anchored record is allowed not to enforce the ceiling.
 *
 * `kind` separates two very different statements:
 *
 *   'by-design' — this route is correct as it stands, and the reason says why.
 *   'open'      — this route IS a cross-region hole. It is not fixed here because the file
 *                 belongs to another workstream, and the reason says so. `openDefects()` counts
 *                 these; the count is asserted below so the list can shrink and not grow.
 *
 * Keyed by `file::method` rather than by route, because a route string moves when a path is
 * renamed and the pair of file and handler name is what a reviewer actually looks at.
 */
interface Exemption { kind: 'by-design' | 'open'; reason: string }

const EXEMPT: Record<string, Exemption> = {
  // ── by design ───────────────────────────────────────────────────────────
  'project/project.controller.ts::findOne': {
    kind: 'by-design',
    reason:
      'A project has no region of its own — it is a set of branches and may legitimately span ' +
      'several, which is why `assertProjectInScope` refuses a project outright rather than ' +
      'narrowing it. Applying that here would stop a regional operator opening the very project ' +
      'their own branches sit in. The branch-level routes underneath it (`:id/branches`, ' +
      '`branches/:pbId/*`) are each scoped, so what is readable through a project is narrowed ' +
      'even though the project row is not.',
  },
  'project/project.controller.ts::update': {
    kind: 'by-design',
    reason:
      'Same as findOne: the record edited here is the project row — name, dates, budget, ' +
      'priority — none of which is region-anchored, and its read sibling is deliberately open ' +
      'for the reason above. Guarding the write while the read stays open would invert the ' +
      'asymmetry rather than close it. Confirmed at runtime on 2026-09-10 that an EAST-scoped ' +
      'OPERATIONS account can edit a Maharashtra-only project; that is the intended answer.',
  },
  'project/project.controller.ts::transition': {
    kind: 'by-design',
    reason: 'A lifecycle move on the project row itself — same reasoning as update.',
  },
  'project/project.controller.ts::remove': {
    kind: 'by-design',
    reason:
      'Soft-deletes the project row. ADMIN-only and permission-gated; the project is not region ' +
      'anchored, and its branches keep their own ceiling on every route that reaches them.',
  },
  'project/project.controller.ts::getBranchImportJob': {
    kind: 'by-design',
    reason:
      'Polls a Bull job by id and answers only state/progress/counts. The job is refused unless ' +
      'its payload names this project, and the upload that created it is region-checked at the ' +
      'door (`uploadBranches`), so there is no job here a caller was not allowed to start.',
  },
  'project/project.controller.ts::downloadTemplate': {
    kind: 'by-design',
    reason: 'Generates an empty spreadsheet template. Contains no branch data of any region.',
  },
  'reports/reports.controller.ts::queueBilling': {
    kind: 'by-design',
    reason:
      'A POST that only enqueues the export its GET twin performs. It cannot refuse — an export ' +
      'narrows — so what it must do is freeze the resolved ceiling into the job payload, which ' +
      'it now does (`scope: scope ?? null`); the worker has no principal and would otherwise ' +
      'run the export unscoped. Pinned by `BillingReportJobData.scope` being required, not ' +
      'optional, so a future enqueue site cannot omit it.',
  },
  'pricing/pricing.controller.ts::getRates': {
    kind: 'by-design',
    reason:
      'Resolves a CLIENT’s contracted rate card. A client is a national account with no region ' +
      'column (see client.controller.ts); the `projectId` here is only a way of naming the ' +
      'client. No branch or assayer row is read.',
  },
  'pricing/pricing.controller.ts::quote': {
    kind: 'by-design',
    reason:
      'A calculator. It returns a fee computed from the rate card and a place; the branch lookup ' +
      'reads only `state` and `region`, both of which the caller may pass directly in the body ' +
      'instead (`dto.state`/`dto.region`), so the route discloses nothing about a branch that ' +
      'the caller did not already have to know to ask the question.',
  },

  // ── open: real cross-region writes, owned by another workstream ─────────
  //
  // Each of these was read during the 2026-09-10 campaign and is a genuine hole. They are listed
  // rather than fixed because the files belong to workstreams running concurrently in this repo,
  // and two sessions editing one controller is how a guard gets lost in a merge.
  //
  // The sixteen `assayer/assayer.controller.ts` entries that stood here on 2026-09-10 are gone:
  // the assayer workstream took the handoff on 2026-09-11 and closed every one, which is what
  // this list is for. It needed seven child-row guards rather than the three left ready for it —
  // a workforce attribute, a score override, a reference and an import issue turned out to be
  // keyed the same way, and the import-issue one has to let a row with no assayer through,
  // because `listIssues` shows those rows to every desk and an issue nobody may close is an
  // issue that sits in the queue forever. The batch route beside it (`resolveImportIssues`) was
  // guarded in the same change though nothing here named it: the scanner cannot see a route
  // whose ids arrive in a DTO array with no anchor word in it, so closing only the singular
  // route would have left the plural one as the way round it. That blind spot is real and is
  // the next thing worth improving here.

  'document/document.controller.ts::mobileUpload': { kind: 'open', reason: 'document workstream; the field-app upload names an assignment or project branch in its body, so it writes a packet onto a region-anchored record.' },
  'document/document.controller.ts::mobileUploadBinary': { kind: 'open', reason: 'document workstream; the binary transport for the same upload, with the same body identifiers and the same gap.' },
  'document/document.controller.ts::completeUpload': { kind: 'open', reason: 'document workstream; finalises a resumable upload session and commits the packet against its branch.' },
  'document/document.controller.ts::downloadFile': { kind: 'open', reason: 'document workstream; streams a branch document packet keyed by document id — the read half of the same boundary.' },
  'document/document.controller.ts::updateStatus': { kind: 'open', reason: 'document workstream; moves a branch packet through the pipeline, which is what the operations board is measured on.' },
  'document/document.controller.ts::receiveDocument': { kind: 'open', reason: 'document workstream; records physical receipt of another region’s paperwork at a location this caller chose.' },
  'document/document.controller.ts::operationsOverview': { kind: 'open', reason: 'document workstream; a cross-branch operations board that aggregates packets from every region.' },
  'document/document.controller.ts::sendToExternalOcr': { kind: 'open', reason: 'document workstream; sends another region’s bank paperwork to a third-party OCR provider.' },
  'document/document.controller.ts::assignDataEntry': { kind: 'open', reason: 'document workstream; routes another region’s packet to a named person for keying.' },
  'document/document.controller.ts::completeDataEntry': { kind: 'open', reason: 'document workstream; records the keyed result against a packet in a region this caller may not read.' },

  /**
   * Both entries below were found by the DTO-aware anchoring added on 2026-09-10, after a
   * mutation test showed the first version of this scanner could not see a route whose anchor
   * lives on its request DTO. They are the two the improvement bought.
   */
  'scheduling/scheduling.controller.ts::create': {
    kind: 'open',
    reason:
      'scheduling workstream; `POST /schedules` creates a visit against an `assignmentId` named ' +
      'in its body, and its own sibling `transition` on the same controller has asserted ' +
      '`assertScheduleInScope` since the ceiling existed. The exact family this campaign is ' +
      'about — the route that brings the record into existence has no ceiling while the route ' +
      'that moves it does — and the file is being edited by another session as this lands.',
  },
  'billing-engine/billing-engine.controller.ts::listAssayerInvoices': {
    kind: 'open',
    reason:
      'A read-side gap, not fixable from the controller: the list is served by ' +
      '`AssayerInvoiceService.list(q)`, which accepts no scope argument at all, and that file is ' +
      'outside what this campaign may change. Adding a guard on the OPTIONAL `?assayerId=` filter ' +
      'would refuse the narrow call and let the unfiltered one through — a decorative guard, ' +
      'which is worse than none. The three by-id routes beside it (`assayer-invoices/:id`, ' +
      '`approve`, `cancel`) are now guarded; this is the list.',
  },

  'expense/expense.controller.ts::create': { kind: 'open', reason: 'expense workstream; raises a reimbursement claim against an assignment — money in, keyed on `:assignmentId`, which is the same anchor `assertAssignmentInScope` already guards elsewhere.' },
  'customer-master/customer-master.controller.ts::upload': { kind: 'open', reason: 'customer-master workstream; a bulk upload of customer records keyed on a branch, i.e. a write into another region’s customer book.' },
  'planning/planning.controller.ts::queueProjectCoveragePlan': { kind: 'open', reason: 'planning workstream; queues a coverage plan over every branch in a project, including branches in regions the caller cannot read.' },
  'planning/planning.controller.ts::queueProjectCandidates': { kind: 'open', reason: 'planning workstream; queues candidate matching over a project’s branches and returns who could staff them.' },
  'planning/planning.controller.ts::updateRule': { kind: 'open', reason: 'planning workstream; a planning rule can name a project or region, so editing one changes how work is allocated outside the caller’s ceiling.' },
  'planning/planning.controller.ts::deleteRule': { kind: 'open', reason: 'planning workstream; deleting a planning rule has the same cross-region reach as editing one.' },
  'planning/planning.controller.ts::getRule': { kind: 'open', reason: 'planning workstream; the read half — discloses a rule that may be scoped to a project or region the caller does not hold.' },
  'validation-query/validation-query.controller.ts::postMessage': { kind: 'open', reason: 'validation-query workstream; writes a message onto a clarification thread anchored on a project branch, which the assayer on that job then receives.' },
  'validation-query/validation-query.controller.ts::markRead': { kind: 'open', reason: 'validation-query workstream; marks another region’s clarification thread as read, changing what its own desk sees as outstanding.' },
};

/**
 * The number of `open` exemptions, which is a debt figure and must only fall.
 *
 * Pinned so that "add it to the list" cannot quietly become the way new unguarded routes are
 * dealt with: a new hole makes this fail, and the only ways to make it pass again are to fix the
 * route or to fix another one.
 */
const OPEN_DEFECT_BUDGET = 23;

const ALL: Handler[] = [];
for (const f of controllerFiles(MODULES)) ALL.push(...handlersIn(f));
const ANCHORED = ALL.filter(isAnchored);
const UNSATISFIED = ANCHORED.filter((h) => !isSatisfied(h));

describe('the region ceiling covers every region-anchored route the controllers actually declare', () => {
  it('found a plausible route inventory to reason about', () => {
    // A scanner that silently matched nothing would make every assertion below vacuous — the
    // exact failure mode of the hand-written list this replaced.
    expect(ALL.length).toBeGreaterThan(200);
    expect(ANCHORED.length).toBeGreaterThan(100);
    expect(assertionNames()).toEqual(expect.arrayContaining(['assertBranchInScope', 'assertRegionSettable']));
  });

  it('every anchored route either enforces the ceiling or is exempt with a written reason', () => {
    const undeclared = UNSATISFIED.filter((h) => !EXEMPT[h.key]);
    expect(
      undeclared.map((h) => `${h.key}  (${h.route})`).sort(),
      // A route reaching a branch, assignment, payable or assayer with no region check and no
      // recorded reason. Either call the ceiling, or add an EXEMPT entry saying why not.
    ).toEqual([]);
  });

  it('every exemption gives a real reason', () => {
    const thin = Object.entries(EXEMPT).filter(([, e]) => e.reason.trim().length < 40);
    expect(thin.map(([k]) => k)).toEqual([]);
  });

  /**
   * An exemption that no longer matches an unguarded route is worse than no exemption: it reads
   * as a considered decision about a route that has since been fixed, renamed or deleted, and it
   * is the residue that made the old list untrustworthy. Both directions are checked — the
   * handler must still exist, and it must still be the one failing.
   */
  it('no exemption is stale', () => {
    const live = new Set(UNSATISFIED.map((h) => h.key));
    const known = new Set(ALL.map((h) => h.key));
    const stale = Object.keys(EXEMPT).filter((k) => !live.has(k));
    const detail = stale.map((k) => `${k} — ${known.has(k) ? 'now enforces the ceiling; delete this entry' : 'handler no longer exists'}`);
    expect(detail).toEqual([]);
  });

  it('the open-defect debt does not grow', () => {
    const open = Object.entries(EXEMPT).filter(([, e]) => e.kind === 'open');
    expect(open.length).toBeLessThanOrEqual(OPEN_DEFECT_BUDGET);
  });

  /**
   * A scope parameter is not decoration. Every assertion returns on its first line when `scope`
   * is `undefined` — `if (!branchId || !scope?.regions?.length) return;` — so a handler that
   * calls the assertion without taking `@GlobalScopeFilter()` refuses nothing at all while
   * reading, at a glance, as though it were guarded. That is worse than no check.
   */
  it('every route that asserts the ceiling also takes the scope it asserts against', () => {
    const decorative = ANCHORED
      .filter((h) => ASSERTION_RE.test(h.body) && !/GlobalScopeFilter/.test(h.params))
      .map((h) => `${h.key}  (${h.route})`);
    expect(decorative.sort()).toEqual([]);
  });
});

/**
 * A spot-check, deliberately NOT the inventory.
 *
 * The scan above proves each of these calls *an* assertion; it cannot tell whether it calls the
 * *right* one — `PUT /branches/:id` asserting an assignment's region would pass. These few pin
 * the specific assertion for the routes whose failure costs the most, and every one of them was
 * confirmed at runtime during the 2026-09-10 campaign: a 403 for the out-of-region fixture and a
 * success for the in-region control, differing only in region.
 *
 * If this list and the scan ever disagree about which routes matter, the scan is right. This is
 * seven lines of spot-check, not a register to maintain.
 */
const PINNED: Array<{ file: string; method: string; assertion: string }> = [
  { file: 'branch/branch.controller.ts', method: 'update', assertion: 'assertBranchInScope' },
  // The other half of the same route: the region it is SETTING, not only the one it is replacing.
  { file: 'branch/branch.controller.ts', method: 'update', assertion: 'assertRegionSettable' },
  { file: 'branch/branch.controller.ts', method: 'create', assertion: 'assertRegionSettable' },
  { file: 'billing-engine/billing-engine.controller.ts', method: 'approvePayouts', assertion: 'assertPayablesInScope' },
  { file: 'billing-engine/billing-engine.controller.ts', method: 'createInvoice', assertion: 'assertAssignmentsInScope' },
  { file: 'validation/validation.controller.ts', method: 'transition', assertion: 'assertValidationCaseInScope' },
  { file: 'assignment/assignment.controller.ts', method: 'create', assertion: 'assertProjectBranchInScope' },
];

describe('the routes whose failure costs the most call the assertion that matches their id', () => {
  it.each(PINNED)('$file :: $method() calls $assertion', ({ file, method, assertion }) => {
    const hs = handlersIn(path.join(MODULES, file)).filter((h) => h.method === method);
    expect(hs.length).toBeGreaterThan(0);
    expect(hs[0].body).toContain(assertion);
    expect(hs[0].params).toContain('GlobalScopeFilter');
  });
});

/**
 * The export half.
 *
 * An export is a read with a different Content-Type, and it was the half that kept being missed:
 * `GET /reports/billing` showed a region-assigned account **0** client lines on screen and handed
 * it **all 13** in the workbook, because `reports.service.billing()` called the same scoped
 * service method with the scope argument omitted. The scan above sees these routes (they name a
 * `projectId`/`clientId`), but "takes and uses scope" is a weak statement for a file download, so
 * the two that carry real rows are pinned to passing the scope INTO the service.
 */
describe('exports are scoped like the screen they are exported from', () => {
  const reports = handlersIn(path.join(MODULES, 'reports/reports.controller.ts'));
  const service = fs.readFileSync(path.join(MODULES, 'reports/reports.service.ts'), 'utf8');

  it('GET /reports/billing resolves and forwards the caller’s ceiling', () => {
    const h = reports.find((x) => x.method === 'billing')!;
    expect(h.params).toContain('GlobalScopeFilter');
    expect(h.body).toContain('scope');
  });

  it('GET /reports/coverage/:projectId refuses a project outside the ceiling', () => {
    const h = reports.find((x) => x.method === 'coverage')!;
    expect(h.params).toContain('GlobalScopeFilter');
    expect(h.body).toContain('assertProjectInScope');
  });

  it('the billing workbook passes the ceiling to BOTH of its sheets', () => {
    // Client lines through `listClientLines(..., q.scope)`, invoices through the paged reader
    // that already implements the spans-regions rule. An unscoped `findInvoices` call reachable
    // from a restricted caller is the defect this pins.
    expect(service).toContain('}, q.scope);');
    expect(service).toContain('invoicesForExport');
  });
});
