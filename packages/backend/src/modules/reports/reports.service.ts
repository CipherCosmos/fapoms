import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { coverageBucketOf, coverageFromStatuses } from '@fapoms/shared';
import { ASSIGNED_ASSIGNMENT_STATUSES } from '../assignment/assignment-workload';
import { AssignmentService } from '../assignment/assignment.service';
import { BillingEngineService } from '../billing-engine/billing-engine.service';
import { CommandCenterService } from '../planning/command-center.service';
import { AssayerService } from '../assayer/assayer.service';
import { AssayerEntity } from '../assayer/assayer.entity';
import { ProjectQueryService } from '../project/project-query.service';
import { scopeAssayerListForRoles, rolesOf } from '../assayer/assayer-visibility';
import { GlobalScope } from '../../infrastructure/scope/global-scope';
import { buildWorkbook, inr, toDate } from './excel-export';
// Type-only: these methods report which phase they are in and stay ignorant of whether a queue
// is watching. See `ReportJobsWorker` for the only adapter onto a Bull job.
import type { ProgressCallback } from '../../infrastructure/queue/queued-job';

/**
 * Why progress here is phase-based rather than row-based.
 *
 * Each export is three steps: hydrate, map rows, serialise. The mapping step is the one with a
 * countable loop in it and the one that costs almost nothing — a few thousand array entries.
 * Essentially all of the wall clock is in the other two: the hydration query (`findAll` at the
 * 5000-row page cap, `commandCenterService.overview` across every branch and assayer) and
 * `xlsx.write`, which is synchronous CPU with no yield point inside it.
 *
 * A per-row bar would therefore sprint from 0 to 100 during the cheap step and then sit at 100
 * for the expensive one, which is a worse lie than three honest phases. `EXPORT_PHASES` is what
 * the fractions below are out of.
 */
const EXPORT_PHASES = 3;

/**
 * Row ceiling shared by every export that hydrates an unbounded list. `assignments()` and
 * `assayerRoster()` already passed this to their `findAll(page, limit, ...)` calls as a literal
 * `5000` each; `billing()` did not, because `BillingEngineService.listClientLines` (billing-engine
 * is a different module's file, not touched here) takes no page/limit at all — it always returns
 * every matching row. That gap meant a billing export with a wide filter (or none) could still
 * hit the same `xlsx.write` blocking-CPU cost this whole queued-export mechanism exists to move
 * off the request path, uncapped. Slicing here does not reduce the query cost (the rows are
 * already fetched), but it does cap workbook size and serialisation time, which is what actually
 * blocks the event loop — see `EXPORT_PHASES` above.
 */
const EXPORT_ROW_CAP = 5000;

/**
 * Spreadsheet exports for operational reporting. Each method returns an .xlsx Buffer built
 * from the same live data the matching screens show, so an exported figure equals the one
 * on screen and both trace to the same source. Follows the "download a workbook" pattern the
 * branch/assayer template endpoints already use (xlsx library, attachment response).
 *
 * Every method takes an optional `onProgress`. Supplied, this export is running as a queued job
 * and something is watching a progress bar; omitted, it is the original synchronous route and
 * behaves exactly as it always did.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly assignmentService: AssignmentService,
    private readonly billingService: BillingEngineService,
    private readonly commandCenterService: CommandCenterService,
    private readonly assayerService: AssayerService,
    private readonly projectQueryService: ProjectQueryService,
    @InjectRepository(AssayerEntity)
    private readonly assayerRepository: Repository<AssayerEntity>,
  ) {}

  // ── Coverage ─────────────────────────────────────────────────────────────

  /**
   * Per-branch coverage for a project, mirroring the summary the planning screen shows
   * (scheduled / confirmed / remaining) but row-per-branch so it can be filtered and totalled
   * in Excel.
   */
  async coverage(projectId: string): Promise<Buffer> {
    const branches = await this.projectQueryService.findProjectBranches(projectId);

    /**
     * `findProjectBranches` is a plain `.find()` — it has no opinion on whether `projectId`
     * names a real project, so a project that genuinely has zero branches yet and a project id
     * that is simply wrong (a typo, a stale bookmark, a copy-paste from the wrong tab) both
     * arrive here as the same empty array. Confirming existence only in this branch — rather
     * than unconditionally, on every call — costs a second query solely on the empty path,
     * which is exactly where the ambiguity needs resolving. `findOne` throws `NotFoundException`
     * on its own, so a bad id now 404s instead of silently downloading a "0 of 0, 0% coverage"
     * workbook that reads as a real answer about a real project.
     */
    if (branches.length === 0) {
      await this.projectQueryService.findOne(projectId);
    }

    const rows = branches.map((pb) => {
      /**
       * Coverage as the client reads it, from `@fapoms/shared` rather than a hand-written list.
       *
       * `AUDIT_COMPLETED` was missing from the list that used to sit here, and it is the status a
       * branch holds between the audit being done and validation finishing — so delivered work
       * was exported to the client as REMAINING, i.e. as if we had not been. That was fixed here
       * and nowhere else, which left `GET /planning/projects/:id/coverage` reporting 9.1% on the
       * project this workbook reported as 45.5%. `coverageBucketOf` is now the only copy of the
       * rule, and the planning endpoint reads it too.
       */
      const coverage = coverageBucketOf(pb.status);
      /**
       * Who is actually on this branch — not merely which rows survive `is_active`.
       *
       * This filtered on `isActive` alone, and terminal assignments deliberately keep that flag
       * set (see the note in `assignment-workload.ts`: `is_active` means "not deleted", never
       * "finished"). So the client-facing coverage workbook counted cancelled and rejected work
       * as assigned, and printed the name of an assayer who had declined the job. Verified live:
       * a REJECTED branch reported "Assigned 1" and named the assayer who turned it down.
       *
       * COMPLETED is included on purpose — a delivered audit is genuinely covered, and the row
       * should say who did it. What must not appear is work that ended without being done. That
       * is exactly `ASSIGNED_ASSIGNMENT_STATUSES`, so this reads the shared set rather than
       * naming CANCELLED and REJECTED again; the Command Centre and the project branch list ask
       * the same question and used to answer it with their own copies of the same two names.
       */
      const assigned = (pb.assignments ?? []).filter(
        (a) => a.isActive !== false && ASSIGNED_ASSIGNMENT_STATUSES.includes(a.status),
      );
      return [
        pb.branch?.solId ?? '',
        pb.branch?.name ?? '',
        pb.branch?.district ?? '',
        pb.branch?.state ?? '',
        pb.status ?? '',
        coverage,
        assigned.length,
        assigned.map((a) => a.assayer?.displayName ?? '').join('; '),
        toDate(pb.scheduledDate),
      ];
    });

    // Delivered work counts as covered. It previously fell into REMAINING, which both
    // understated the client's coverage and overstated what was still outstanding. The summing
    // is `coverageFromStatuses`' job, not this method's, so the workbook's totals and the
    // planning endpoint's cannot drift the way the bucketing above already had.
    const { total, completed, scheduled, confirmed, remaining, coveragePercentage } =
      coverageFromStatuses(branches.map((pb) => pb.status));

    return buildWorkbook([
      {
        name: 'Summary',
        headers: ['Total Branches', 'Completed', 'Scheduled', 'Confirmed', 'Remaining', 'Coverage %'],
        rows: [[total, completed, scheduled, confirmed, remaining, coveragePercentage]],
      },
      {
        name: 'Branch Coverage',
        headers: ['Branch Code', 'Branch Name', 'District', 'State', 'PB Status', 'Coverage', 'Assigned', 'Assayer(s)', 'Scheduled Date'],
        rows,
      },
    ]);
  }

  // ── Assignment status ────────────────────────────────────────────────────

  /** The operational assignment list with its current status, flattened for the grid. */
  async assignments(q: {
    page?: number;
    limit?: number;
    status?: string;
    projectBranchStatus?: string;
    priority?: string;
    scope?: Partial<GlobalScope>;
  }, onProgress?: ProgressCallback): Promise<Buffer> {
    await onProgress?.(0, EXPORT_PHASES, 'Loading assignments');
    const { assignments } = await this.assignmentService.findAll(
      q.page ?? 1,
      q.limit ?? EXPORT_ROW_CAP,
      q.status,
      q.projectBranchStatus,
      undefined,
      q.priority,
      q.scope,
    );
    await onProgress?.(1, EXPORT_PHASES, 'Building rows');

    const rows = assignments.map((a) => [
      a.assignmentNumber,
      toDate(a.scheduledDate),
      a.status,
      a.priority,
      a.assayer?.displayName ?? '',
      a.assayer?.assayerCode ?? '',
      a.project?.name ?? '',
      a.projectBranch?.branch?.name ?? '',
      a.projectBranch?.branch?.state ?? '',
      a.projectBranch?.status ?? '',
      a.proposedFee ?? null,
      a.agreedFee ?? null,
      a.slaStatus ?? '',
      toDate(a.checkedInAt),
      toDate(a.completionDate),
      a.cancelReason ?? a.rejectReason ?? '',
      a.isActive === false ? 'DELETED' : 'ACTIVE',
    ]);

    // Reported before the call, not after: `buildWorkbook` is synchronous, so nothing this
    // method could write afterwards would reach Redis until the serialisation had finished —
    // which is exactly the phase the bar is meant to be reporting.
    await onProgress?.(2, EXPORT_PHASES, 'Writing workbook');
    return buildWorkbook([
      {
        name: 'Assignments',
        headers: [
          'Assignment No',
          'Scheduled Date',
          'Status',
          'Priority',
          'Assayer',
          'Assayer Code',
          'Project',
          'Branch',
          'State',
          'Branch Status',
          // The values are bare numbers, not `inr()`-formatted strings — unlike the Billing and
          // Command Center exports — because a numeric-typed column stays sortable/summable in
          // the workbook, which a "₹1,234" string cell would not. The unit therefore has to live
          // in the header. `PlanningWorkspace.tsx`'s own CSV export of this same field already
          // spells it exactly this way ('Proposed Fee (₹)') — matched here rather than invented,
          // so the same field reads identically wherever it is exported from.
          'Proposed Fee (₹)',
          'Agreed Fee (₹)',
          'SLA Status',
          'Checked In',
          'Completed',
          'Cancel / Reject Reason',
          'Active',
        ],
        rows,
      },
    ]);
  }

  // ── Billing ──────────────────────────────────────────────────────────────

  /** Client lines and invoices, matching the finance screens. */
  async billing(
    q: { clientId?: string; projectId?: string; assayerId?: string; state?: string },
    onProgress?: ProgressCallback,
  ): Promise<Buffer> {
    await onProgress?.(0, EXPORT_PHASES, 'Loading client lines and invoices');
    const allEntries = await this.billingService.listClientLines({
      clientId: q.clientId,
      projectId: q.projectId,
      assayerId: q.assayerId,
      state: q.state as any,
    });
    // listClientLines has no page/limit of its own (see EXPORT_ROW_CAP comment) — cap here so a
    // wide or unfiltered billing export can't outgrow the other exports' 5000-row ceiling.
    const truncated = allEntries.length > EXPORT_ROW_CAP;
    const entries = truncated ? allEntries.slice(0, EXPORT_ROW_CAP) : allEntries;
    const invoices = await this.billingService.findInvoices({
      clientId: q.clientId,
      projectId: q.projectId,
    });
    await onProgress?.(1, EXPORT_PHASES, 'Building rows');

    const entryRows = entries.map((e: any) => [
      e.entryNumber,
      e.state,
      e.onHold ? `ON HOLD — ${e.holdReason ?? ''}` : '',
      e.clientName ?? '',
      e.projectName ?? '',
      e.assignmentNumber ?? '',
      e.branchName ?? '',
      e.assayerName ?? '',
      toDate(e.serviceDate),
      inr(e.baseAmount),
      inr(e.travelAmount),
      inr(e.adjustmentAmount),
      e.adjustmentReason ?? '',
      inr(e.taxableAmount),
      inr(e.taxAmount),
      inr(e.tdsAmount),
      inr(e.totalAmount),
      inr(e.paidAmount),
      inr(e.outstandingAmount),
      e.isActive === false ? 'DELETED' : 'ACTIVE',
    ]);

    const invoiceRows = (invoices as any[]).map((inv) => [
      inv.invoiceNumber,
      inv.status,
      toDate(inv.issueDate),
      toDate(inv.dueDate),
      inv.currency ?? 'INR',
      inr(inv.subtotal),
      inr(inv.taxAmount),
      inr(inv.tdsAmount),
      inr(inv.total),
      inr(inv.paidAmount),
      inr(inv.outstandingAmount),
      (inv.entries ?? []).length,
      inv.notes ?? '',
    ]);

    await onProgress?.(2, EXPORT_PHASES, 'Writing workbook');
    return buildWorkbook([
      // Only present when the cap above actually cut rows, so an unaffected export gets exactly
      // the two sheets it always had rather than a permanent empty notice.
      ...(truncated
        ? [
            {
              name: 'Notice',
              headers: ['Message'],
              rows: [[
                `Showing the first ${EXPORT_ROW_CAP.toLocaleString()} of ${allEntries.length.toLocaleString()} matching client lines. Narrow the filters (client, project, assayer or state) to see the rest.`,
              ]],
            },
          ]
        : []),
      {
        name: 'Client Lines',
        headers: [
          'Line No',
          'State',
          'Hold',
          'Client',
          'Project',
          'Assignment',
          'Branch',
          'Assayer',
          'Service Date',
          'Base',
          'Travel',
          'Adjustment',
          'Adjustment Reason',
          'Taxable',
          'GST',
          'TDS',
          'Total',
          'Paid',
          'Outstanding',
          'Active',
        ],
        rows: entryRows,
      },
      {
        name: 'Invoices',
        headers: [
          'Invoice No',
          'Status',
          'Issue Date',
          'Due Date',
          'Currency',
          'Subtotal',
          'GST',
          'TDS',
          'Total',
          'Paid',
          'Outstanding',
          'Line Items',
          'Notes',
        ],
        rows: invoiceRows,
      },
    ]);
  }

  // ── Command Center / territory summary ──────────────────────────────────

  /** Executive geographic summary: territories, per-branch points, per-assayer points. */
  async commandCenter(scope: Partial<GlobalScope> = {}, onProgress?: ProgressCallback): Promise<Buffer> {
    // By far the longest phase of this export: `overview` computes territory aggregates, nearest
    // assayer per branch and realised revenue across the whole book. It was measured at 5m22s
    // before it was batched and cached, and at 6.4s after — which is still most of this method.
    await onProgress?.(0, EXPORT_PHASES, 'Computing territory overview');
    const data = await this.commandCenterService.overview(scope);
    await onProgress?.(1, EXPORT_PHASES, 'Building rows');

    const totals = data?.totals ?? {};
    const territoryRows = (data?.territories ?? []).map((t: any) => [
      t.state,
      t.branches ?? 0,
      t.assignedBranches ?? 0,
      t.unassignedBranches ?? 0,
      t.packets ?? 0,
      t.auditHours ?? 0,
      t.demandAssayerDays ?? 0,
      t.assayers ?? 0,
      t.dailyCapacity ?? 0,
      t.loadRatio ?? '',
      t.avgNearestAssayerKm ?? '',
      t.unassignedShare ?? '',
      t.isolatedBranches ?? 0,
      t.realisedRevenue != null ? inr(t.realisedRevenue) : '',
      t.pipelineValue != null ? inr(t.pipelineValue) : '',
      t.posture ?? '',
    ]);

    const branchRows = (data?.branchPoints ?? []).map((b: any) => [
      b.name ?? '',
      b.solId ?? '',
      b.district ?? '',
      b.state ?? '',
      b.status ?? '',
      b.clientName ?? '',
      b.packets ?? 0,
      b.auditHours ?? 0,
      toDate(b.scheduledDate),
      b.assigned ? 'YES' : 'NO',
      b.nearestAssayerName ?? '',
      b.nearestAssayerKm ?? '',
      b.assayersInRange ?? 0,
      b.isolated ? 'YES' : 'NO',
      b.realisedRevenue != null ? inr(b.realisedRevenue) : '',
    ]);

    const assayerRows = (data?.assayerPoints ?? []).map((a: any) => [
      a.name ?? '',
      a.assayerCode ?? '',
      a.district ?? '',
      a.state ?? '',
      a.maxDailyWorkload ?? '',
      a.baseFee != null ? inr(a.baseFee) : '',
      a.openAssignments ?? 0,
    ]);

    const summaryRow = [
      totals.branches ?? 0,
      totals.packets ?? 0,
      totals.auditHours ?? 0,
      totals.assayers ?? 0,
      totals.unassignedBranches ?? 0,
      totals.isolatedBranches ?? 0,
      totals.demandAssayerDays ?? 0,
      totals.dailyCapacity ?? 0,
      totals.realisedRevenue != null ? inr(totals.realisedRevenue) : '',
      totals.pipelineValue != null ? inr(totals.pipelineValue) : '',
      totals.statesCovered ?? 0,
    ];

    await onProgress?.(2, EXPORT_PHASES, 'Writing workbook');
    return buildWorkbook([
      {
        name: 'Summary',
        headers: [
          'Branches',
          'Packets',
          'Audit Hours',
          'Assayers',
          'Unassigned',
          'Isolated',
          'Demand (days)',
          'Daily Capacity',
          'Realised Revenue',
          'Pipeline Value',
          'States Covered',
        ],
        rows: [summaryRow],
      },
      {
        name: 'Territories',
        headers: [
          'State',
          'Branches',
          'Assigned',
          'Unassigned',
          'Packets',
          'Audit Hours',
          'Demand (days)',
          'Assayers',
          'Daily Capacity',
          'Load Ratio',
          'Avg Nearest (km)',
          'Unassigned %',
          'Isolated',
          'Realised Revenue',
          'Pipeline Value',
          'Posture',
        ],
        rows: territoryRows,
      },
      {
        name: 'Branch Detail',
        headers: [
          'Branch',
          'Code',
          'District',
          'State',
          'Status',
          'Client',
          'Packets',
          'Audit Hours',
          'Scheduled Date',
          'Assigned',
          'Nearest Assayer',
          'Nearest (km)',
          'Assayers in Range',
          'Isolated',
          'Realised Revenue',
        ],
        rows: branchRows,
      },
      {
        name: 'Assayer Detail',
        headers: ['Assayer', 'Code', 'District', 'State', 'Max Daily Load', 'Base Fee', 'Open Assignments'],
        rows: assayerRows,
      },
    ]);
  }

  // ── Assayer roster / payroll ─────────────────────────────────────────────

  /**
   * Roster prior to the same role-based PII scoping the assayer list applies, plus a payroll
   * sheet with the in-force commercial rate per assayer.
   */
  async assayerRoster(
    user: any,
    q: { page?: number; limit?: number; scope?: Partial<GlobalScope> },
    onProgress?: ProgressCallback,
  ): Promise<Buffer> {
    await onProgress?.(0, EXPORT_PHASES, 'Loading roster');
    const { assayers } = await this.assayerService.findAll(q.page ?? 1, q.limit ?? EXPORT_ROW_CAP, q.scope);
    // `rolesOf` reads only `user.roles`, so a queued run can pass a `{ id, roles }` snapshot
    // rather than storing a whole user record — with its PAN, bank and contact columns — in
    // Redis for the life of the job. See `PrincipalSnapshot`.
    const scoped = scopeAssayerListForRoles(assayers as any[], rolesOf(user)) as any[];

    const rosterRows = scoped.map((a) => [
      a.assayerCode ?? '',
      a.displayName ?? `${a.firstName ?? ''} ${a.lastName ?? ''}`.trim(),
      a.phone ?? '',
      a.email ?? '',
      a.lifecycleStatus ?? a.status ?? '',
      a.region ?? '',
      a.state ?? '',
      a.district ?? '',
      a.employmentType ?? '',
      toDate(a.joiningDate),
      toDate(a.exitDate ?? a.terminationDate),
      a.totalAssignments ?? 0,
      a.completedAssignments ?? 0,
      a.averageRating ?? '',
    ]);

    const byId = new Map<string, any>();
    for (const a of scoped) byId.set(a.id, a);

    await onProgress?.(1, EXPORT_PHASES, 'Loading rate cards');
    // `getRosterCommercialProfiles()` takes no scope — it is one query across every active
    // assayer in the organisation, by design (see its own comment). Filtering to `byId` here is
    // what actually confines the Pay Roll sheet to the same roster the caller was scoped to see.
    //
    // Without this filter, a regionally-scoped caller (e.g. an OPERATIONS user assigned only
    // `SOUTH`) got a Roster sheet correctly limited to their region but a Pay Roll sheet with
    // every assayer nationwide — 1164 rows against a 395-row roster on the live database. Every
    // row for an out-of-scope assayer rendered with a blank code and name (the `byId.get` below
    // returning `undefined`) but a populated base fee, daily rate and allowances: unnamed rows
    // are not anonymous once the figures next to them are real compensation data for a specific
    // person outside the caller's permitted region. `scopeAssayerListForRoles` only redacts
    // fields — it never drops a record — so `byId`'s key set is exactly the region- and
    // role-scoped roster `q.scope` and the caller's role already produced, and filtering on it
    // here confines the payroll sheet to precisely that set.
    const profiles = (await this.assayerService.getRosterCommercialProfiles())
      .filter(({ assayerId }) => byId.has(assayerId));

    const payrollRows = profiles.map(({ assayerId, profile, hasFutureProfile }) => {
      const a = byId.get(assayerId);
      return [
        a?.assayerCode ?? '',
        a?.displayName ?? '',
        profile?.baseFee ?? null,
        profile?.dailyRate ?? null,
        profile?.hourlyRate ?? null,
        profile?.travelReimbursement ?? null,
        profile?.accommodationAllowance ?? null,
        profile?.mealAllowance ?? null,
        profile?.currency ?? 'INR',
        toDate(profile?.effectiveStartDate),
        toDate(profile?.effectiveEndDate),
        profile ? 'IN_FORCE' : 'NO_PROFILE',
        hasFutureProfile ? 'YES' : 'NO',
      ];
    });

    await onProgress?.(2, EXPORT_PHASES, 'Writing workbook');
    return buildWorkbook([
      {
        name: 'Roster',
        headers: [
          'Assayer Code',
          'Name',
          'Phone',
          'Email',
          'Status',
          'Region',
          'State',
          'District',
          'Employment Type',
          'Joining Date',
          'Exit Date',
          'Total Assignments',
          'Completed Assignments',
          'Avg Rating',
        ],
        rows: rosterRows,
      },
      {
        name: 'Pay Roll',
        headers: [
          'Assayer Code',
          'Name',
          'Base Fee',
          'Daily Rate',
          'Hourly Rate',
          'Travel Reimb.',
          'Accommodation',
          'Meal Allowance',
          'Currency',
          'Effective From',
          'Effective To',
          'Rate Status',
          'Future Rate',
        ],
        rows: payrollRows,
      },
    ]);
  }
}