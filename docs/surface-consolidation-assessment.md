# FAPOMS — Surface Consolidation Assessment

**Question being answered:** "too many things, no clear scope of what to do with what and when" — so:
what is *unwanted* (remove), what can *merge*, what can *simplify* — **without losing any capability** —
and how to organize it so each role knows *what to do when*.

**Method:** three evidence-based passes (frontend page/data redundancy, backend dead-code & data model,
role-based task journeys), each citing files. Verdicts below are grounded in "who actually consumes this",
not names.

**The one-line diagnosis:** the navigation is organized by **module type** (four fixed groups: Overview /
Operations / Management / Administration), not by **workflow** or **role**. The audit pipeline — a 12-step
sequence — is scattered across those groups, so no role has an ordered "home" that tells it what comes next.
The sprawl is real but **mostly re-organizable, not rewrite-able**: little is truly duplicated logic; a lot is
the same capability shown in two places or placed with no sequence.

---

## PART A — REMOVE (dead; zero consumers; no capability lost)

> **CORRECTION (2026-08-09, verified against current source).** The first three rows below were re-checked
> line-by-line before any deletion. Two were **mislabelled** and must NOT be removed; the third is real but
> is *not* a clean delete. Discipline note: look at the target before deleting — if the code contradicts how
> it was described, surface that rather than proceeding. The corrected findings are in the right-hand column.

| Target | Original claim | **Verified status (do this instead)** |
|---|---|---|
| **`modules/audit`** (AuditPlatformModule — `startAudit`/`closeAudit`, `AuditController`) | "Genuinely dead; billing superseded by the unified engine." | **WRONG — un-integrated, not dead.** `closeAudit` is the *live caller* of `billingEngine.syncPayableForAssignment` (books the assayer payable, idempotent-by-design), and `audit:started`/`audit:closed` are consumed by `realtime/events.gateway.ts:393`. Registered in `app.module.ts:168`. The only dead surface is the **HTTP controller** (`/audits/*` has no client caller). **Do NOT delete.** Decision needed: wire `closeAudit` into assignment-completion / expose the routes to a client, **or** consciously retire the feature — but that's an integration call, not cruft removal. |
| **`modules/audit-history`** (AuditHistory + AuditEvidence) | "Write-only tables with a dead writer; remove with `modules/audit`." | **WRONG — live.** Its `AuditHistoryService.createRecord` is called by the (live) `AuditService.startAudit` above, and the module is registered directly in `app.module.ts:166`. Ties to the same audit lifecycle. **Do NOT delete.** |
| **`PlatformFoundationModule`** + its 7 `@Global` providers | "Parallel dead twins; 0 external consumers." | **Partly right, but not a clean delete.** Re-grep confirms **0** real external consumers (the lone `BackgroundQueueManager` hit was the interface's own `implements`). It *is* an unadopted abstraction layer. **But** it registers `AuditLogEntity` (whose `audit_log` table is indexed by migration `1787400000000`) and a `background-jobs` Bull queue, and shadows the `core/audit` log concept. Removal needs a migration + queue rehome + coordination — **park as a deliberate task, not a blind `rm`.** Live `PlatformModule` (RuleEngine/WorkflowEngine/ConfigurationResolver) stays untouched. |
| **`pages/FieldIssues`** *(was dead: route existed, no permission entry → unreachable)* | The concurrent effort has since added its `/field-issues` permission entry, so it is now reachable — **no longer remove; verify it's intended.** | Watch item, not a delete. |
| Frontend `api.ts` `getNotifications()` marked `@deprecated`; redirect shims `/validation`→`/data-entry`, `/assayers`→`/hr/roster` | Live back-compat; low priority | Remove after callers/links migrate. |

**Capability check:** after correction, Part A has **no safe automatic removals**. The audit lifecycle is un-integrated
(not dead) and its removal would delete a near-complete audit→payable path; `PlatformFoundationModule` is unadopted
but entangled with a table + queue. Net: nothing deleted this pass — the value delivered was *catching a wrong
delete before it happened.*

---

## PART B — MERGE (same capability shown in two+ places; unify, keep both entry points)

Ranked by value / inconsistency risk.

1. **Single-assayer dossier rendered twice** — `pages/AssayerProfile.tsx` (full page, `/assayers/:id`) vs
   `pages/hr/AssayerDetailDrawer.tsx` (drawer). Both fetch the *same* endpoints
   (`/assayers/:id/commercial|workforce-attribute|remark|activity|government-document`) and do the same
   lifecycle/remark mutations. ~460 LOC of divergent duplication. **Fix:** one dossier component, mounted in a
   drawer from the roster *and* full-page at `/assayers/:id`. Both entry points kept.

2. **Client billing settings editable in two places with different field sets** — `clients/BillingPanel`
   (paymentTerms/currency/taxIdentifier/invoiceCycle/billingAddress) vs `billing/ClientBillingSettingsPage`
   (paymentTerms/**gstRate/tdsRate**). Same resource, *divergent fields* = a real data-integrity risk.
   **Fix:** one client-billing form component, reused in both places, unified field set.

3. **Customer-master step fragmented across 3 surfaces** *(partly self-inflicted — the page I just added)* —
   uploaded + shown per-day in `documents/DailyRunPanel` (`/documents`), but **approved** in
   `CustomerMasterVersions` (`/customer-master`). A user uploads on one page and must navigate to another to
   approve before the same Daily Run will generate packets. **Fix:** surface the version list + Approve inside
   the Documents Daily Run panel (collapse `/customer-master` into a Documents tab). Both use
   `services/customer-master.ts` → low-risk merge.

4. **Finance scattered across 4 routes + Expense Review** *(also partly self-inflicted)* — `/billing` already
   has 8 in-page `?tab=` tabs, yet `/billing/ledger`, `/billing/settings`, `/billing/statement` are separate
   routes and my `/expenses` is a 4th finance surface. The page's own comment says the sub-routes were split
   only for linkability — which query-param tabs already give. **Fix:** fold ledger/settings/statement in as
   tabs; add an **"Assayer Pay"** tab unifying Payables + Expense claims + Statement (all = money owed to one
   assayer).

5. **HR Deployment + Utilisation slice one payload two ways** — both read the single `useHrWorkforce` object;
   overlapping idle/territory cuts. **Fix:** merge into one "Capacity & Deployment" tab; keep Overview as
   summary.

**Capability check:** every merge relocates/unifies existing UI; no feature is dropped. Net effect: top-level
items drop from ~22 to ~13.

### Do NOT merge (verified legitimate, to prevent a bad call)
- **Dashboard vs Command Room (ExecutiveMap)** — different data (`/system-dashboard/operations` vs
  `/planning/command-center`) and different jobs (role-filtered action list vs coordinate map). Dashboard
  deep-links *into* the map. **Keep both.** *(This corrects an earlier surface-level suggestion to merge them.)*
- **Planning vs Scheduling vs Assignments** — a real pipeline (create → schedule → manage), sharing only the
  `/assignments/:id/transition` verb, not panels. **Keep the split.**

---

## PART C — SIMPLIFY

- **The "one audit" data model.** `assessments` is ~85% redundant with `project_branches` (same
  `(project,branch)` key, dual-written in lock-step in `project.service.ts:381-404` and `:608-633`; assessment's
  extra fields `auditDate`/`assignedAssessorId`/`agreedFee`/`coverageFlag` are *copied from* the assignment via
  `syncAssessmentStatus`). It **cannot be deleted losslessly today** for one reason: `AssessmentStatus` carries
  the **post-audit document-pipeline states** (`PDF_GENERATED`…`DELIVERED_TO_CLIENT`) that `ProjectBranchStatus`
  collapses into three. **Fix (structural):** fold `assessments` into `project_branches` and replace the two
  enums with **one unified status machine** = ProjectBranch operational states + Assessment's document-pipeline
  tail. Removes the dual-write and the whole `ASSESSMENT_STATUS_MAP`. Load-bearing machines that stay:
  `ProjectBranchStatus`, `AssignmentStatus`. `ScheduleStatus` (4 states) is a thin near-duplicate worth folding;
  `audits`/`assayer_audit_history` statuses die with Part A.
- **God pages.** `PlanningWorkspace.tsx` (2,459 LOC) and `Documents.tsx` — the Documents merge (B3) plus
  finishing the planning API extraction already started reduce both.
- **4 nav groups → a workflow spine (Part D).**

---

## PART D — "WHAT TO DO WHEN": a workflow-organized navigation + per-role homes

The real fix for "no scope of what to do with what and when." Reorganize nav to **mirror the audit lifecycle**
so the nav itself teaches the sequence, and give every role a default landing page.

### Proposed navigation
```
🏠 Home                 Dashboard  ·  Command Room (both kept — not merged)

📋 Audit Pipeline       the sequential core, in order:
   1. Projects & Branches      intake
   2. Planning                 assign assayers
   3. Scheduling               dispatch dates
   4. Field Execution          assignments  (+ Field Issues)
   5. Customer Data & Documents customer-master approve → PDF → dispatch   ← merge B3 lands here
   6. Data Entry & Validation   process → clarifications → report

💰 Finance              Billing · Invoices · Payables · Assayer Pay (expenses+statement)   ← merge B4

👥 Workforce            HR (roster · onboarding · compliance · pay · capacity)   ← merge B5

⚙️ Setup & Admin        Clients · Zones · Holidays · Rules · Users
```

### Per-role default "home" (add per-role landing redirect — none exists today; everyone dumps on `/dashboard`)
| Role | Home | Why |
|---|---|---|
| OPERATIONS_MANAGER | `/planning` (or Command Room) | owns the pipeline hub |
| OPERATIONS_EXECUTIVE | `/assignments` | daily execution queue |
| DOCUMENT_EXECUTIVE | `/documents` | dispatch desk |
| DATA_ENTRY_HEAD | `/data-entry` | returned-paperwork queue |
| VALIDATOR / VALIDATION_MANAGER | `/data-entry` (validation) | the worklist |
| FINANCE_MANAGER | `/billing` | the money |
| HR_MANAGER | `/hr` | the workforce |
| ASSAYER | (mobile only) | no meaningful web page — send to a minimal status/redirect, not a dead dashboard |

### Cross-role hand-off gaps to close (the "after X, who does Y and where?" problem)
- **Customer-master approved (OPS_MGR) → PDF uploaded/dispatched (DOC_EXEC):** DOC_EXEC is *not* in
  `/customer-master`'s allowed roles, so cannot see the upstream state that triggers their work. Add DOC_EXEC
  view access (they already hold `validate-customer-excel`).
- **Returned PDF → data-entry → validation:** chain crosses `/documents`→`/data-entry` with no linking nav; the
  clarification loop (`validation-query`) has **no top-level route** at all (only an App.tsx `clarifications`
  child, invisible in the sidebar). Surface it.
- **Validation approved → delivery (Phase 12):** no distinct approval/delivery surface; folded into
  `/data-entry` — acceptable, but label the stage.

### Trim "reachable but no action" noise (pages a role sees but can't act on)
- OPS_EXECUTIVE: `/planning`, `/customer-master`, `/branches`, `/zones` are largely read-only for them
  (writes are OPS_MGR-only) → buttons that 403. Either hide or clearly mark read-only.
- FINANCE_MANAGER: `/assignments`, `/projects`, `/branches` are context-only.
- VALIDATOR/VAL_MGR: `/projects`, `/branches` with no write use.
- HR_MANAGER: `/scheduling`, `/projects`, `/branches` context-only.

### Route inconsistencies to fix
- `/customer-master` excludes DOC_EXEC even though DOC_EXEC acts on customer-master upload/validation.
- (`/field-issues` missing-permission issue: resolved by the concurrent effort — verify.)

---

## PART E — Prioritized, sequenced plan (with coordination caveats)

**Reality:** a second effort ("Track B") is actively editing the backend *and* the same nav files
(`App.tsx`, `route-permissions.ts`, `Sidebar.tsx` — they just added Zones + Field Issues). So **nav reorg and
backend module removal will collide** if done uncoordinated. Sequence accordingly:

**Tier 1 — safe, self-contained, do first (low collision):**
- Merge B1 (one assayer dossier component) and B2 (one client-billing form) — isolated component work,
  build-verifiable, removes real duplication + an inconsistency risk.
- Merge B3 (Customer Master → Documents tab) and B4 (Expense Review → Billing tab) — **undo the sprawl I added**;
  isolated to those pages + one nav entry each.

**Tier 2 — coordinate with Track B (shared files):**
- The nav reorganization (Part D) + per-role home redirects — touches `Sidebar.tsx`/`App.tsx` that Track B edits.
- Backend Part-A removals (`modules/audit`, `audit-history`, `PlatformFoundationModule`) — touch `app.module.ts`.
  Do these once the tree is consolidated/committed.

**Tier 3 — structural, plan explicitly:**
- Unify `assessments` into `project_branches` + one status machine (Part C). Data migration on the busiest
  tables; sequence after the repository/UoW seam if that lands.

**Non-negotiable principle throughout:** no capability is removed — Part A is dead code, Part B/D relocate or
unify existing UI, Part C keeps every state.
</content>
