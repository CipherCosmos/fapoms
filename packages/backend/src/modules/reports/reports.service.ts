import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectBranchStatus } from '@fapoms/shared';
import { AssignmentService } from '../assignment/assignment.service';
import { BillingEngineService } from '../billing-engine/billing-engine.service';
import { CommandCenterService } from '../planning/command-center.service';
import { AssayerService } from '../assayer/assayer.service';
import { AssayerEntity } from '../assayer/assayer.entity';
import { ProjectQueryService } from '../project/project-query.service';
import { scopeAssayerListForRoles, rolesOf } from '../assayer/assayer-visibility';
import { GlobalScope } from '../../infrastructure/scope/global-scope';
import { buildWorkbook, inr, toDate } from './excel-export';

/**
 * Spreadsheet exports for operational reporting. Each method returns an .xlsx Buffer built
 * from the same live data the matching screens show, so an exported figure equals the one
 * on screen and both trace to the same source. Follows the "download a workbook" pattern the
 * branch/assayer template endpoints already use (xlsx library, attachment response).
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

    const classify = (status: string | undefined): 'SCHEDULED' | 'CONFIRMED' | 'REMAINING' => {
      if (
        status === ProjectBranchStatus.SCHEDULED ||
        status === ProjectBranchStatus.CLOSED ||
        status === ProjectBranchStatus.VALIDATION_COMPLETED
      ) {
        return 'SCHEDULED';
      }
      if (status === ProjectBranchStatus.ASSIGNMENT_CONFIRMED) return 'CONFIRMED';
      return 'REMAINING';
    };

    const rows = branches.map((pb) => {
      const coverage = classify(pb.status);
      const assigned = (pb.assignments ?? []).filter((a) => a.isActive !== false);
      return [
        pb.branch?.branchCode ?? '',
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

    const scheduled = rows.filter((r) => r[5] === 'SCHEDULED').length;
    const confirmed = rows.filter((r) => r[5] === 'CONFIRMED').length;
    const remaining = rows.filter((r) => r[5] === 'REMAINING').length;
    const total = rows.length;
    const coveragePercentage = total > 0 ? parseFloat((((scheduled + confirmed) / total) * 100).toFixed(1)) : 0;

    return buildWorkbook([
      {
        name: 'Summary',
        headers: ['Total Branches', 'Scheduled', 'Confirmed', 'Remaining', 'Coverage %'],
        rows: [[total, scheduled, confirmed, remaining, coveragePercentage]],
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
  }): Promise<Buffer> {
    const { assignments } = await this.assignmentService.findAll(
      q.page ?? 1,
      q.limit ?? 5000,
      q.status,
      q.projectBranchStatus,
      undefined,
      undefined,
      q.priority,
      q.scope,
    );

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
          'Proposed Fee',
          'Agreed Fee',
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

  /** Billing entries and invoices, matching the finance screens. */
  async billing(q: { clientId?: string; projectId?: string; assayerId?: string; state?: string }): Promise<Buffer> {
    const entries = await this.billingService.findEntriesEnriched({
      clientId: q.clientId,
      projectId: q.projectId,
      assayerId: q.assayerId,
      state: q.state as any,
    });
    const invoices = await this.billingService.findInvoices({
      clientId: q.clientId,
      projectId: q.projectId,
    });

    const entryRows = entries.map((e: any) => [
      e.entryNumber,
      e.level,
      e.state,
      e.paymentState,
      e.clientName ?? '',
      e.projectName ?? '',
      e.assignmentNumber ?? '',
      e.branchName ?? '',
      e.assayerName ?? '',
      toDate(e.billingPeriodStart),
      toDate(e.billingPeriodEnd),
      inr(e.baseAmount),
      inr(e.travelAmount),
      inr(e.adjustmentAmount),
      inr(e.discountAmount),
      inr(e.taxAmount),
      inr(e.tdsAmount),
      inr(e.totalAmount),
      inr(e.billedAmount),
      inr(e.paidAmount),
      inr(e.outstandingAmount),
      inr(e.disputedAmount),
      e.isActive === false ? 'DELETED' : 'ACTIVE',
    ]);

    const invoiceRows = (invoices as any[]).map((inv) => [
      inv.invoiceNumber,
      inv.type,
      inv.status,
      toDate(inv.issueDate),
      toDate(inv.dueDate),
      inv.currency ?? 'INR',
      inr(inv.subtotal),
      inr(inv.discountAmount),
      inr(inv.taxAmount),
      inr(inv.tdsAmount),
      inr(inv.total),
      inr(inv.paidAmount),
      inr(inv.outstandingAmount),
      (inv.entries ?? []).length,
      inv.notes ?? '',
    ]);

    return buildWorkbook([
      {
        name: 'Entries',
        headers: [
          'Entry No',
          'Level',
          'State',
          'Payment State',
          'Client',
          'Project',
          'Assignment',
          'Branch',
          'Assayer',
          'Period Start',
          'Period End',
          'Base',
          'Travel',
          'Adjustment',
          'Discount',
          'Tax',
          'TDS',
          'Total',
          'Billed',
          'Paid',
          'Outstanding',
          'Disputed',
          'Active',
        ],
        rows: entryRows,
      },
      {
        name: 'Invoices',
        headers: [
          'Invoice No',
          'Type',
          'Status',
          'Issue Date',
          'Due Date',
          'Currency',
          'Subtotal',
          'Discount',
          'Tax',
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
  async commandCenter(scope: Partial<GlobalScope> = {}): Promise<Buffer> {
    const data = await this.commandCenterService.overview(scope);

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
      b.branchCode ?? '',
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
  async assayerRoster(user: any, q: { page?: number; limit?: number; scope?: Partial<GlobalScope> }): Promise<Buffer> {
    const { assayers } = await this.assayerService.findAll(q.page ?? 1, q.limit ?? 5000, q.scope);
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
      a.totalEarnings != null ? inr(a.totalEarnings) : '',
      a.averageRating ?? '',
    ]);

    const profiles = await this.assayerService.getRosterCommercialProfiles();
    const byId = new Map<string, any>();
    for (const a of scoped) byId.set(a.id, a);

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
          'Total Earnings',
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