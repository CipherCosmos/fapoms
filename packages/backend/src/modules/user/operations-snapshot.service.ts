import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { branchStatusLabel, ProjectBranchStatus } from '@fapoms/shared';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { GlobalScope } from '../../infrastructure/scope/global-scope';

/**
 * The operational home view: what is stuck, what is due, and what it is worth.
 *
 * Replaces a dashboard built from master-data counts — how many clients, users
 * and branches exist. Those never change day to day and nobody acts on them. It
 * also showed a per-project completion bar computed from a `branches` field the
 * projects endpoint does not return, so every bar read 0% permanently.
 *
 * Everything here is a queue someone has to clear or a number someone has to
 * defend, assembled in one snapshot so the figures cannot disagree with each
 * other the way four separate client-side calls would.
 */
@Injectable()
export class OperationsSnapshotService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly cache: CacheService,
  ) {}

  /**
   * Which sections a role is shown.
   *
   * Everyone was previously given the same page regardless of what they do, so a
   * validator opened a screen about branch coverage and a finance manager one
   * about paperwork dispatch. Sections are declared per role and the payload only
   * carries what the viewer's roles actually include — the dashboard is not a
   * place to render blocks the reader has no authority to act on.
   */
  private static readonly ROLE_SECTIONS: Record<string, string[]> = {
    SUPER_ADMINISTRATOR:  ['attention', 'due', 'funnel', 'capacity', 'documents', 'money', 'projects', 'validation', 'activity'],
    ADMINISTRATOR:        ['attention', 'due', 'funnel', 'capacity', 'documents', 'money', 'projects', 'validation', 'activity'],
    // Runs the book: coverage, capacity and what is at risk this week.
    OPERATIONS_MANAGER:   ['attention', 'due', 'funnel', 'capacity', 'documents', 'projects', 'activity'],
    // Works the queues rather than steering the book — no money, no portfolio view.
    OPERATIONS_EXECUTIVE: ['attention', 'due', 'funnel', 'documents'],
    FINANCE_MANAGER:      ['money', 'projects', 'activity'],
    // HR steer people, not the audit book: capacity tells them whether the
    // workforce can absorb the work, activity gives them the audit trail. The
    // detail lives in the dedicated workforce console at /hr.
    HR_MANAGER:           ['capacity', 'activity'],
    DOCUMENT_EXECUTIVE:   ['documents', 'due'],
    DATA_ENTRY_HEAD:      ['documents'],
    VALIDATION_MANAGER:   ['validation', 'documents', 'activity'],
    VALIDATOR:            ['validation'],
    READ_ONLY_AUDITOR:    ['funnel', 'projects', 'activity'],
    CLIENT_USER:          ['projects'],
  };

  /** Headline shown at the top, so the page states whose view it is. */
  private static readonly ROLE_FOCUS: Record<string, string> = {
    SUPER_ADMINISTRATOR:  'Full operational picture',
    ADMINISTRATOR:        'Full operational picture',
    OPERATIONS_MANAGER:   'Coverage, capacity and delivery risk',
    OPERATIONS_EXECUTIVE: 'Your queues for today',
    FINANCE_MANAGER:      'Billing, collections and margin',
    HR_MANAGER:           'Workforce readiness, compliance and staffing gaps',
    DOCUMENT_EXECUTIVE:   'Paperwork in and out',
    DATA_ENTRY_HEAD:      'Returned paperwork awaiting processing',
    VALIDATION_MANAGER:   'Validation throughput and open queries',
    VALIDATOR:            'Your validation queue',
    READ_ONLY_AUDITOR:    'Read-only overview',
    CLIENT_USER:          'Your audit programme',
  };

  /**
   * The desk model, applied to the dashboard.
   *
   * The sections split the same way the application's desks do. `funnel`, `due`, `capacity`
   * and `projects` describe the audit book on the ground — branches, dates, people in a
   * territory — so they follow the caller's global scope, and an operator running the West
   * opens a dashboard about the West. `documents`, `validation`, `money` and `activity` are
   * national desk queues (data entry, validation, finance, audit trail): those desks take
   * whatever work arrives regardless of territory, so scoping them would only make their
   * numbers disagree with the queues they describe.
   */
  private static readonly TERRITORIAL_SECTIONS = ['funnel', 'due', 'capacity', 'projects'];

  async snapshot(roles: string[] = [], userId?: string, scope?: Partial<GlobalScope>): Promise<any> {
    // Union of every section the viewer's roles allow. Unknown roles fall back to
    // the read-only set rather than being shown nothing at all.
    const sections = new Set<string>();
    for (const r of roles) {
      (OperationsSnapshotService.ROLE_SECTIONS[r] ?? OperationsSnapshotService.ROLE_SECTIONS.READ_ONLY_AUDITOR)
        .forEach((s) => sections.add(s));
    }
    if (sections.size === 0) OperationsSnapshotService.ROLE_SECTIONS.READ_ONLY_AUDITOR.forEach((s) => sections.add(s));

    const focus = roles.map((r) => OperationsSnapshotService.ROLE_FOCUS[r]).find(Boolean)
      ?? OperationsSnapshotService.ROLE_FOCUS.READ_ONLY_AUDITOR;

    const n = (v: any) => Number(v ?? 0);

    // ── The funnel: where every branch in the book currently sits ──────────
    // Ordered by the lifecycle rather than alphabetically, so a pile-up at one
    // stage is visible as a shape rather than having to be read off.
    /**
     * Ordering is a lifecycle fact and belongs here; the wording is not, and belongs to
     * @fapoms/shared. These labels were written out by hand and six of the ten disagreed with
     * the canon — "Assayer confirmed" against "Assigned", "Audited" against "Audit Completed" —
     * so the dashboard funnel named the same stage differently from every table and badge that
     * showed it.
     */
    const STAGE_ORDER: ProjectBranchStatus[] = [
      ProjectBranchStatus.IMPORTED,
      ProjectBranchStatus.PLANNING,
      ProjectBranchStatus.CANDIDATE_SEARCH,
      ProjectBranchStatus.CONTACT_INITIATED,
      ProjectBranchStatus.NEGOTIATION,
      ProjectBranchStatus.ASSIGNMENT_CONFIRMED,
      ProjectBranchStatus.SCHEDULED,
      ProjectBranchStatus.AUDIT_COMPLETED,
      ProjectBranchStatus.VALIDATION_COMPLETED,
      ProjectBranchStatus.CLOSED,
    ];
    const STAGES = STAGE_ORDER.map((key) => ({ key, label: branchStatusLabel(key) }));

    // ── Scope predicates for the territorial queries ───────────────────────
    // One params array shared by the branch-based territorial queries; each includes only the
    // fragments whose aliases it actually has. Placeholder indexes are allocated once, so a
    // fragment means the same thing in every query that uses it. The capacity query queries
    // `assayers` rather than `branches` and so binds its own array, below.
    const sp: any[] = [];
    const frag = { region: '', state: '', zone: '', client: '', project: '' };
    if (scope?.regions?.length) {
      sp.push(scope.regions);
      frag.region = ` AND b.region = ANY($${sp.length})`;
    }
    // UPPER() both sides: this column holds the same state in multiple casings (see apply-scope).
    if (scope?.state) { sp.push(scope.state); frag.state = ` AND UPPER(b.state) = UPPER($${sp.length})`; }
    if (scope?.zoneId) { sp.push(scope.zoneId); frag.zone = ` AND b.zone_id = $${sp.length}`; }
    if (scope?.clientId) { sp.push(scope.clientId); frag.client = ` AND p.client_id = $${sp.length}`; }
    if (scope?.projectId) { sp.push(scope.projectId); frag.project = ` AND p.id = $${sp.length}`; }
    const branchFrag = frag.region + frag.state + frag.zone;
    const isScoped = sp.length > 0;

    // Capacity query needs a separate parameter binding array because assayers only have home region,
    // and passing unmatched parameter arrays will throw error in node-postgres.
    const capacityParams: any[] = [];
    let capacityAssayerRegionFrag = '';
    if (scope?.regions?.length) {
      capacityParams.push(scope.regions);
      capacityAssayerRegionFrag = ` AND a.region = ANY($1)`;
    }

    const DASH_TTL = Number(process.env.DASHBOARD_CACHE_TTL_S) || 15;

    // ── National bundle: documents, money, activity ────────────────────────
    // These describe the data-entry, finance and audit-trail desks, which take work from the
    // whole country regardless of any operator's territory — deliberately NOT scoped, and
    // therefore cacheable under one org-wide key shared by every viewer.
    const [docRows, moneyRows, activityRows] =
      await this.cache.wrap('dash:snapshot:orgwide:v2', DASH_TTL, () => Promise.all([
      this.dataSource.query(`
        SELECT
          COUNT(*) FILTER (WHERE type='PRE_FIELD_AUDIT_PDF' AND status='UPLOADED')::int      AS packets_unsent,
          COUNT(*) FILTER (WHERE type='PRE_FIELD_AUDIT_PDF' AND status='DISPATCHED')::int    AS awaiting_return,
          COUNT(*) FILTER (WHERE type='AUDITED_RETURN_PDF'  AND status='RECEIVED')::int      AS awaiting_ocr,
          COUNT(*) FILTER (WHERE type='AUDITED_RETURN_PDF'  AND status='SENT_TO_EXTERNAL_OCR')::int AS in_ocr
          FROM documents WHERE is_active = true`),

      this.dataSource.query(`
        SELECT
          COALESCE(SUM(taxable_amount) FILTER (WHERE state IN
            ('PENDING_BILLING','READY_FOR_BILLING','DRAFT','SUBMITTED','UNDER_REVIEW','APPROVED')),0) AS unbilled,
          COALESCE(SUM(outstanding_amount),0) AS outstanding,
          COALESCE(SUM(paid_amount),0)        AS collected
          FROM billing_entries WHERE is_active = true`),

      this.dataSource.query(`
        SELECT id, event_type AS action, remarks AS detail, occurred_at AS "occurredAt"
          FROM audit_events ORDER BY occurred_at DESC LIMIT 12`),
    ]));

    // ── Territorial bundle: funnel, due, capacity, projects ────────────────
    // Keyed by the scope, never by the org-wide key: a shared key here would serve one
    // operator's region to the next viewer within the TTL — the same cache-poisoning trap the
    // command-center map had. Unscoped viewers all share the ':all' key, so the org-wide
    // caching benefit is kept for the common case.
    const scopeCacheKey = isScoped
      ? `dash:snapshot:scoped:v2:${sp.map((v) => (Array.isArray(v) ? v.join('+') : v)).join(':')}`
      : 'dash:snapshot:scoped:v2:all';
    const [funnelRows, dueRows, capacityRows, projectRows] =
      await this.cache.wrap(scopeCacheKey, DASH_TTL, () => Promise.all([
      this.dataSource.query(`
        SELECT pb.status, COUNT(*)::int AS c, COALESCE(SUM(pb.packet_count),0)::int AS packets
          FROM project_branches pb
          JOIN projects p ON p.id = pb.project_id AND p.is_active = true
          JOIN branches b ON b.id = pb.branch_id
         WHERE pb.is_active = true${branchFrag}${frag.client}${frag.project}
         GROUP BY pb.status`, sp),

      // Audits landing in the next week, and whether each is actually ready:
      // an assayer confirmed and the paperwork released. A date in the diary with
      // neither of those is the thing that fails on the morning.
      this.dataSource.query(`
        SELECT pb.id, pb.scheduled_date, pb.status,
               b.name AS branch_name, b.district, b.state,
               (pb.scheduled_date - CURRENT_DATE)::int AS days_away,
               EXISTS (SELECT 1 FROM assignments a
                        WHERE a.project_branch_id = pb.id AND a.is_active = true
                          AND a.status IN ('ACCEPTED','CHECKED_IN','IN_PROGRESS','COMPLETED')) AS has_assayer,
               EXISTS (SELECT 1 FROM documents d
                        JOIN assessments asm ON asm.id = d.assessment_id
                       WHERE asm.project_id = pb.project_id AND asm.branch_id = pb.branch_id
                          AND d.is_active = true AND d.type = 'PRE_FIELD_AUDIT_PDF'
                          AND d.status <> 'UPLOADED') AS packet_sent
          FROM project_branches pb
          JOIN branches b ON b.id = pb.branch_id
          JOIN projects p ON p.id = pb.project_id
         WHERE pb.is_active = true
           AND pb.scheduled_date IS NOT NULL
           AND pb.scheduled_date BETWEEN CURRENT_DATE - 3 AND CURRENT_DATE + 7${branchFrag}${frag.client}${frag.project}
         ORDER BY pb.scheduled_date`, sp),

      // Idle vs loaded people, against the work waiting to be placed. Scoped by the assayer's
      // own home region only — an assayer has no client or zone — so the capacity figure
      // describes the same workforce the scoped map and roster show.
      this.dataSource.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE open_count = 0)::int AS idle,
          COALESCE(SUM(max_daily_workload),0)::int AS daily_capacity
          FROM (
            SELECT a.id, a.max_daily_workload,
                   (SELECT COUNT(*) FROM assignments asg
                     WHERE asg.assayer_id = a.id AND asg.is_active = true
                       AND asg.status IN ('PENDING','ACCEPTED','CHECKED_IN','IN_PROGRESS')) AS open_count
              FROM assayers a
             WHERE a.is_active = true AND a.status = 'ACTIVE'${capacityAssayerRegionFrag}
          ) s`, capacityParams),

      // Real per-project progress. Under a geographic scope the branch counts cover only the
      // in-scope branches, and projects with none of them drop out (the HAVING) — a project
      // row claiming 0-of-0 progress in a region it does not touch is noise, not information.
      this.dataSource.query(`
        SELECT p.id, p.name, p.project_number, p.status, c.name AS client_name,
               COUNT(pb.id)::int AS total_branches,
               COUNT(*) FILTER (WHERE pb.status IN ('AUDIT_COMPLETED','VALIDATION_COMPLETED','CLOSED'))::int AS audited,
               COUNT(*) FILTER (WHERE pb.status IN ('IMPORTED','PLANNING','CANDIDATE_SEARCH'))::int AS unplanned,
               COALESCE(SUM(pb.packet_count),0)::int AS packets
          FROM projects p
          JOIN clients c ON c.id = p.client_id
          LEFT JOIN project_branches pb ON pb.project_id = p.id AND pb.is_active = true
          LEFT JOIN branches b ON b.id = pb.branch_id
         WHERE p.is_active = true${frag.client}${frag.project}
           ${isScoped ? `AND (pb.id IS NULL OR (b.id IS NOT NULL${branchFrag}))` : ''}
         GROUP BY p.id, p.name, p.project_number, p.status, c.name
         ${isScoped ? 'HAVING COUNT(pb.id) > 0' : ''}
         ORDER BY total_branches DESC`, sp),
    ]));

    // Validation is only queried for roles that can act on it — a validator's
    // queue is meaningless to finance and vice versa.
    const validation = sections.has('validation')
      ? (await this.dataSource.query(`
          SELECT
            COUNT(*) FILTER (WHERE vc.status = 'PENDING')::int             AS pending,
            COUNT(*) FILTER (WHERE vc.status = 'HUMAN_REVIEW')::int        AS in_review,
            COUNT(*) FILTER (WHERE vc.status = 'CORRECTION_REQUIRED')::int AS needs_correction,
            COUNT(*) FILTER (WHERE vc.reviewer_id = $1)::int               AS assigned_to_me,
            (SELECT COUNT(*) FROM validation_queries q
              WHERE q.is_active = true AND q.status = 'OPEN')::int         AS open_queries,
            (SELECT COUNT(*) FROM validation_queries q
              WHERE q.is_active = true AND q.status = 'OPEN'
                AND q.sla_due_date IS NOT NULL AND q.sla_due_date < NOW())::int AS overdue_queries
            FROM validation_cases vc WHERE vc.is_active = true`, [userId ?? null]))[0]
      : null;

    const byStatus = new Map(funnelRows.map((r: any) => [r.status, r]));
    const funnel = STAGES.map((s) => ({
      key: s.key,
      label: s.label,
      count: n((byStatus.get(s.key) as any)?.c),
      packets: n((byStatus.get(s.key) as any)?.packets),
    }));

    const due = dueRows.map((r: any) => ({
      projectBranchId: r.id,
      branchName: r.branch_name,
      district: r.district,
      state: r.state,
      scheduledDate: r.scheduled_date,
      daysAway: n(r.days_away),
      hasAssayer: !!r.has_assayer,
      packetSent: !!r.packet_sent,
      // What would actually stop this audit happening.
      blocker: !r.has_assayer ? 'NO_ASSAYER' : !r.packet_sent ? 'PACKET_NOT_SENT' : null,
    }));

    const docs = docRows[0] ?? {};
    const money = moneyRows[0] ?? {};
    const cap = capacityRows[0] ?? {};

    const atRisk = due.filter((d: any) => d.blocker && d.daysAway >= 0);
    const overdueStart = due.filter((d: any) => d.blocker && d.daysAway < 0);

    // Ordered by urgency: things already past their date first.
    const attention = [
      {
        key: 'AUDITS_PASSED_UNREADY', severity: 'critical',
        count: overdueStart.length,
        label: 'Audit date passed, still not ready',
        detail: 'Scheduled date has gone by without an assayer or without the packet released.',
        link: '/scheduling',
      },
      {
        key: 'AUDITS_AT_RISK', severity: 'high',
        count: atRisk.length,
        label: 'Audits due this week not ready',
        detail: 'Confirmed dates in the next 7 days missing an assayer or an unreleased packet.',
        link: '/scheduling',
      },
      {
        key: 'PACKETS_UNSENT', severity: 'high',
        count: n(docs.packets_unsent),
        label: 'Packets prepared but not sent',
        detail: 'The assayer cannot download these until they are released.',
        link: '/documents',
      },
      {
        key: 'AWAITING_OCR', severity: 'medium',
        count: n(docs.awaiting_ocr),
        label: 'Returned paperwork awaiting OCR',
        detail: 'Field paperwork is back and sitting with data entry.',
        link: '/documents',
      },
      {
        key: 'OVERDUE_QUERIES', severity: 'high',
        count: n(validation?.overdue_queries),
        label: 'Clarifications overdue',
        detail: 'Questions raised with assayers that have passed their response deadline.',
        link: '/validation',
      },
      {
        key: 'UNBILLED', severity: 'medium',
        count: Math.round(n(money.unbilled)),
        label: 'Unbilled revenue',
        detail: 'Work delivered or in progress that is not yet on an invoice.',
        link: '/billing',
        isMoney: true,
      },
    ].filter((a) => a.count > 0);

    // Only sections the viewer's roles include are populated; the rest are null so
    // the client renders nothing rather than an empty-looking block.
    const has = (k: string) => sections.has(k);

    return {
      generatedAt: new Date().toISOString(),
      roles,
      focus,
      sections: [...sections],

      attention: has('attention') ? attention : [],
      funnel: has('funnel') ? funnel : null,
      due: has('due') ? due : null,
      documents: has('documents') ? {
        packetsUnsent: n(docs.packets_unsent),
        awaitingReturn: n(docs.awaiting_return),
        awaitingOcr: n(docs.awaiting_ocr),
        inOcr: n(docs.in_ocr),
      } : null,
      money: has('money') ? {
        unbilled: Math.round(n(money.unbilled)),
        outstanding: Math.round(n(money.outstanding)),
        collected: Math.round(n(money.collected)),
      } : null,
      capacity: has('capacity') ? {
        assayers: n(cap.total),
        idle: n(cap.idle),
        dailyCapacity: n(cap.daily_capacity),
      } : null,
      validation: validation ? {
        pending: n(validation.pending),
        inReview: n(validation.in_review),
        needsCorrection: n(validation.needs_correction),
        assignedToMe: n(validation.assigned_to_me),
        openQueries: n(validation.open_queries),
        overdueQueries: n(validation.overdue_queries),
      } : null,
      projects: has('projects') ? projectRows.map((p: any) => ({
        id: p.id,
        name: p.name,
        projectNumber: p.project_number,
        status: p.status,
        clientName: p.client_name,
        totalBranches: n(p.total_branches),
        audited: n(p.audited),
        unplanned: n(p.unplanned),
        packets: n(p.packets),
        progressPct: n(p.total_branches) > 0 ? Math.round((n(p.audited) / n(p.total_branches)) * 100) : 0,
      })) : null,
      activities: has('activity') ? activityRows : null,
    };
  }
}
