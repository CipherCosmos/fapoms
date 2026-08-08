import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { canonicalState } from '../planning/command-center.service';
import { IN_FLIGHT_ASSIGNMENT_STATUSES, sqlStatusList } from '../assignment/assignment-workload';

/**
 * FAPOMS — HR workforce analytics.
 *
 * HR own the people, not the audit book, so this deliberately answers different
 * questions from the operations dashboard. Operations ask "can we cover tomorrow";
 * HR ask "is this workforce complete, compliant, staffed in the right places, and
 * is anyone falling through a gap".
 *
 * Everything here is derived from rows that already exist. Where the data is
 * missing — and on this deployment most of the HR record *is* missing — that
 * absence is reported as the finding rather than hidden behind a zero.
 */

/** Lifecycle order for onboarding. A candidate walks these in sequence. */
const ONBOARDING_STAGES = [
  { key: 'INVITED', label: 'Invited' },
  { key: 'DOCUMENT_VERIFICATION', label: 'Document check' },
  { key: 'BACKGROUND_VERIFICATION', label: 'Background check' },
  { key: 'TRAINING', label: 'Training' },
  { key: 'ACTIVE', label: 'Active' },
];

/** Past this many days in one onboarding stage, a candidate is stalled. */
const STALLED_AFTER_DAYS = 7;

/** An active assayer with no work for this long is a retention risk. */
const IDLE_AFTER_DAYS = 30;

/**
 * Fields that make up a complete workforce record, and why each one matters.
 * `critical` fields block something concrete — payroll, statutory filing, or
 * emergency response — so they are reported separately from merely-thin data.
 */
const RECORD_FIELDS: {
  column: string;
  label: string;
  critical: boolean;
  blocks: string;
}[] = [
  { column: 'pan_number', label: 'PAN', critical: true, blocks: 'TDS deduction and statutory filing' },
  { column: 'bank_account_number', label: 'Bank account', critical: true, blocks: 'Payouts' },
  { column: 'ifsc_code', label: 'IFSC', critical: true, blocks: 'Payouts' },
  { column: 'joining_date', label: 'Joining date', critical: true, blocks: 'Tenure, leave accrual and exit settlement' },
  { column: 'emergency_contact_phone', label: 'Emergency contact', critical: true, blocks: 'Duty-of-care for field staff' },
  { column: 'email', label: 'Email', critical: false, blocks: 'System notifications' },
  { column: 'employment_type', label: 'Employment type', critical: false, blocks: 'Contract terms' },
  { column: 'manager_id', label: 'Reporting manager', critical: false, blocks: 'Escalation path' },
  { column: 'photograph', label: 'Photograph', critical: false, blocks: 'Field ID verification' },
  { column: 'address', label: 'Address', critical: false, blocks: 'Travel planning' },
];

@Injectable()
export class HrWorkforceService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private static num(v: any): number {
    return Number(v ?? 0);
  }

  async overview(): Promise<any> {
    const [
      headcount,
      pipeline,
      compliance,
      expiries,
      capability,
      deployment,
      utilisation,
      attrition,
      activity,
    ] = await Promise.all([
      this.headcount(),
      this.onboardingPipeline(),
      this.recordCompliance(),
      this.expiries(),
      this.capability(),
      this.deployment(),
      this.utilisation(),
      this.attrition(),
      this.recentActivity(),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      headcount,
      pipeline,
      compliance,
      expiries,
      capability,
      deployment,
      utilisation,
      attrition,
      activity,
      // Surfaced first in the UI: the handful of things HR should act on today,
      // ranked, rather than left for someone to infer from nine panels.
      actions: this.deriveActions({ pipeline, compliance, expiries, deployment, utilisation }),
    };
  }

  // ── Headcount ────────────────────────────────────────────────────────────

  private async headcount() {
    const byLifecycle = await this.dataSource.query(`
      SELECT COALESCE(lifecycle_status::text, 'UNKNOWN') AS stage, COUNT(*)::int AS count
      FROM assayers GROUP BY 1 ORDER BY 2 DESC
    `);
    const byEmployment = await this.dataSource.query(`
      SELECT COALESCE(employment_type, 'UNSPECIFIED') AS type, COUNT(*)::int AS count
      FROM assayers WHERE exit_date IS NULL AND termination_date IS NULL
      GROUP BY 1 ORDER BY 2 DESC
    `);
    const tenure = await this.dataSource.query(`
      SELECT
        COUNT(*) FILTER (WHERE joining_date IS NULL)::int                                          AS unknown,
        COUNT(*) FILTER (WHERE joining_date > NOW() - INTERVAL '3 months')::int                    AS under_3m,
        COUNT(*) FILTER (WHERE joining_date <= NOW() - INTERVAL '3 months'
                           AND joining_date > NOW() - INTERVAL '1 year')::int                      AS m3_to_1y,
        COUNT(*) FILTER (WHERE joining_date <= NOW() - INTERVAL '1 year')::int                     AS over_1y
      FROM assayers WHERE exit_date IS NULL AND termination_date IS NULL
    `);
    const totals = await this.dataSource.query(`
      SELECT
        COUNT(*)::int                                                              AS total,
        COUNT(*) FILTER (WHERE lifecycle_status = 'ACTIVE')::int                   AS active,
        COUNT(*) FILTER (WHERE lifecycle_status IN ('INVITED','DOCUMENT_VERIFICATION','BACKGROUND_VERIFICATION','TRAINING')
                           AND exit_date IS NULL AND termination_date IS NULL)::int AS onboarding,
        COUNT(*) FILTER (WHERE exit_date IS NOT NULL OR termination_date IS NOT NULL)::int AS exited
      FROM assayers
    `);

    return {
      ...totals[0],
      byLifecycle,
      byEmployment,
      tenure: tenure[0],
    };
  }

  // ── Onboarding pipeline ──────────────────────────────────────────────────

  /**
   * Counts per stage, plus how long each candidate has sat there. Time-in-stage
   * comes from the last LIFECYCLE_TRANSITION into the current stage; a candidate
   * with no transition row falls back to when the record was created.
   */
  private async onboardingPipeline() {
    const rows = await this.dataSource.query(
      `
      WITH last_move AS (
        SELECT DISTINCT ON (act.assayer_id) act.assayer_id, act.occurred_at,
               COALESCE(
                 act.performed_by_name,
                 NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
                 u.username
               ) AS performed_by_name
        FROM assayer_activities act
        LEFT JOIN users u ON act.performed_by::text ~ '^[0-9a-fA-F-]{36}$' AND u.id = act.performed_by::uuid
        WHERE act.event_type = 'LIFECYCLE_TRANSITION'
        ORDER BY act.assayer_id, act.occurred_at DESC
      )
      SELECT a.id, a.assayer_code AS "assayerCode", a.display_name AS "displayName",
             a.lifecycle_status AS stage, a.state, a.district,
             COALESCE(lm.occurred_at, a.created_at) AS "since",
             lm.performed_by_name AS "movedBy",
             EXTRACT(DAY FROM NOW() - COALESCE(lm.occurred_at, a.created_at))::int AS "daysInStage"
      FROM assayers a
      LEFT JOIN last_move lm ON lm.assayer_id = a.id
      WHERE a.exit_date IS NULL AND a.termination_date IS NULL
      ORDER BY "daysInStage" DESC
    `,
    );

    const stages = ONBOARDING_STAGES.map((s) => {
      const inStage = rows.filter((r: any) => r.stage === s.key);
      return {
        ...s,
        count: inStage.length,
        stalled: inStage.filter((r: any) => r.daysInStage >= STALLED_AFTER_DAYS).length,
        // Only pre-ACTIVE stages have a meaningful "average wait".
        avgDaysInStage: inStage.length
          ? Math.round(inStage.reduce((t: number, r: any) => t + r.daysInStage, 0) / inStage.length)
          : 0,
      };
    });

    const stalled = rows
      .filter((r: any) => r.stage !== 'ACTIVE' && r.daysInStage >= STALLED_AFTER_DAYS)
      .slice(0, 25);

    return {
      stalledAfterDays: STALLED_AFTER_DAYS,
      stages,
      stalled,
      inProgress: rows.filter((r: any) => r.stage !== 'ACTIVE').length,
    };
  }

  // ── Record completeness ──────────────────────────────────────────────────

  /**
   * The single most useful HR view on this deployment: which parts of the
   * workforce record are actually filled in. A payout cannot be made without a
   * bank account, and TDS cannot be deducted without a PAN — so an empty column
   * here is an operational blocker, not a cosmetic gap.
   */
  private async recordCompliance() {
    const selects = RECORD_FIELDS.map(
      (f) => `COUNT(*) FILTER (WHERE ${f.column} IS NOT NULL AND ${f.column}::text <> '')::int AS "${f.column}"`,
    ).join(',\n        ');

    const [filled] = await this.dataSource.query(`
      SELECT COUNT(*)::int AS total,
        ${selects}
      FROM assayers
      WHERE exit_date IS NULL AND termination_date IS NULL
    `);

    const total = HrWorkforceService.num(filled.total);
    const fields = RECORD_FIELDS.map((f) => {
      const have = HrWorkforceService.num(filled[f.column]);
      return {
        label: f.label,
        column: f.column,
        critical: f.critical,
        blocks: f.blocks,
        have,
        missing: total - have,
        pct: total ? Math.round((have / total) * 100) : 0,
      };
    }).sort((a, b) => Number(b.critical) - Number(a.critical) || a.pct - b.pct);

    // Who specifically is missing something critical — HR need names, not a bar.
    const criticalCols = RECORD_FIELDS.filter((f) => f.critical).map((f) => f.column);
    const missingExpr = criticalCols
      .map((c) => `CASE WHEN ${c} IS NULL OR ${c}::text = '' THEN '${c}' END`)
      .join(', ');

    const incomplete = await this.dataSource.query(`
      SELECT id, assayer_code AS "assayerCode", display_name AS "displayName",
             state, district, lifecycle_status AS "lifecycleStatus",
             ARRAY_REMOVE(ARRAY[${missingExpr}], NULL) AS "missing"
      FROM assayers
      WHERE exit_date IS NULL AND termination_date IS NULL
        AND (${criticalCols.map((c) => `${c} IS NULL OR ${c}::text = ''`).join(' OR ')})
      ORDER BY ARRAY_LENGTH(ARRAY_REMOVE(ARRAY[${missingExpr}], NULL), 1) DESC NULLS LAST,
               assayer_code
      LIMIT 100
    `);

    const govDocs = await this.dataSource.query(`
      SELECT COALESCE(verification_status, 'PENDING') AS status, COUNT(*)::int AS count
      FROM assayer_government_documents WHERE is_active = true GROUP BY 1
    `);

    const [docCoverage] = await this.dataSource.query(`
      SELECT
        (SELECT COUNT(*)::int FROM assayers WHERE exit_date IS NULL AND termination_date IS NULL) AS roster,
        (SELECT COUNT(DISTINCT assayer_id)::int FROM assayer_government_documents WHERE is_active = true) AS "withGovDoc",
        (SELECT COUNT(DISTINCT assayer_id)::int FROM assayer_documents WHERE is_active = true) AS "withFile"
    `);

    return {
      roster: total,
      fields,
      incomplete,
      incompleteCount: incomplete.length,
      governmentDocuments: { byStatus: govDocs, ...docCoverage },
    };
  }

  // ── Expiring credentials ─────────────────────────────────────────────────

  /** Certifications and identity documents falling due, so renewals start early. */
  private async expiries() {
    const certifications = await this.dataSource.query(`
      SELECT w.id, w.name, w.type, w.level, w.expiry_date AS "expiryDate",
             a.id AS "assayerId", a.assayer_code AS "assayerCode", a.display_name AS "displayName",
             a.state,
             (w.expiry_date::date - CURRENT_DATE)::int AS "daysToExpiry"
      FROM workforce_attributes w
      JOIN assayers a ON a.id = w.assayer_id
      WHERE w.is_active = true AND w.expiry_date IS NOT NULL
        AND a.exit_date IS NULL AND a.termination_date IS NULL
        AND w.expiry_date::date <= CURRENT_DATE + INTERVAL '180 days'
      ORDER BY w.expiry_date ASC
      LIMIT 100
    `);

    const documents = await this.dataSource.query(`
      SELECT g.id, g.document_type AS "documentType", g.expiry_date AS "expiryDate",
             g.verification_status AS "verificationStatus",
             a.id AS "assayerId", a.assayer_code AS "assayerCode", a.display_name AS "displayName",
             (g.expiry_date::date - CURRENT_DATE)::int AS "daysToExpiry"
      FROM assayer_government_documents g
      JOIN assayers a ON a.id = g.assayer_id
      WHERE g.is_active = true AND g.expiry_date IS NOT NULL
        AND a.exit_date IS NULL AND a.termination_date IS NULL
        AND g.expiry_date::date <= CURRENT_DATE + INTERVAL '180 days'
      ORDER BY g.expiry_date ASC
      LIMIT 100
    `);

    const bucket = (rows: any[]) => ({
      expired: rows.filter((r) => r.daysToExpiry < 0).length,
      within30: rows.filter((r) => r.daysToExpiry >= 0 && r.daysToExpiry <= 30).length,
      within90: rows.filter((r) => r.daysToExpiry > 30 && r.daysToExpiry <= 90).length,
      within180: rows.filter((r) => r.daysToExpiry > 90).length,
    });

    return {
      certifications: { rows: certifications, ...bucket(certifications) },
      documents: { rows: documents, ...bucket(documents) },
    };
  }

  // ── Capability inventory ─────────────────────────────────────────────────

  /**
   * What the workforce can actually do. Language matters operationally here: an
   * audit in Tamil Nadu goes better with a Tamil speaker, so language coverage is
   * reported against where the branches are, not just as a total.
   */
  private async capability() {
    const byType = await this.dataSource.query(`
      SELECT w.type, w.name, COUNT(DISTINCT w.assayer_id)::int AS "assayerCount"
      FROM workforce_attributes w
      JOIN assayers a ON a.id = w.assayer_id
      WHERE w.is_active = true AND a.exit_date IS NULL AND a.termination_date IS NULL
      GROUP BY 1, 2
      ORDER BY 1, 3 DESC
    `);

    const [coverage] = await this.dataSource.query(`
      SELECT
        (SELECT COUNT(DISTINCT assayer_id)::int FROM workforce_attributes WHERE type='SKILL' AND is_active=true)         AS "withSkill",
        (SELECT COUNT(DISTINCT assayer_id)::int FROM workforce_attributes WHERE type='LANGUAGE' AND is_active=true)      AS "withLanguage",
        (SELECT COUNT(DISTINCT assayer_id)::int FROM workforce_attributes WHERE type='CERTIFICATION' AND is_active=true) AS "withCertification",
        (SELECT COUNT(*)::int FROM assayers WHERE exit_date IS NULL AND termination_date IS NULL)                        AS roster
    `);

    const group = (t: string) => byType.filter((r: any) => r.type === t).slice(0, 20);

    return {
      coverage,
      skills: group('SKILL'),
      languages: group('LANGUAGE'),
      certifications: group('CERTIFICATION'),
      // An assayer with no recorded capability cannot be matched on competency.
      unprofiled: HrWorkforceService.num(coverage.roster) - HrWorkforceService.num(coverage.withSkill),
    };
  }

  // ── Where the people are vs where the work is ────────────────────────────

  /**
   * Supply and demand per state. This is HR's hiring brief: branches carry the
   * work, assayers carry the capacity, and the gap between them says where to
   * recruit. State spellings differ between the branch and assayer imports, so
   * both sides are canonicalised before being compared.
   */
  private async deployment() {
    const supplyRaw = await this.dataSource.query(`
      SELECT state, COUNT(*)::int AS assayers,
             COUNT(*) FILTER (WHERE lifecycle_status = 'ACTIVE')::int AS active
      FROM assayers
      WHERE exit_date IS NULL AND termination_date IS NULL
      GROUP BY 1
    `);
    const demandRaw = await this.dataSource.query(`
      SELECT state, COUNT(*)::int AS branches
      FROM branches WHERE is_active = true GROUP BY 1
    `);

    const map = new Map<string, { state: string; assayers: number; active: number; branches: number }>();
    const touch = (raw: string | null) => {
      const key = canonicalState(raw);
      if (!map.has(key)) map.set(key, { state: key, assayers: 0, active: 0, branches: 0 });
      return map.get(key)!;
    };
    for (const r of supplyRaw) {
      const e = touch(r.state);
      e.assayers += HrWorkforceService.num(r.assayers);
      e.active += HrWorkforceService.num(r.active);
    }
    for (const r of demandRaw) touch(r.state).branches += HrWorkforceService.num(r.branches);

    const territories = [...map.values()]
      .map((t) => {
        const ratio = t.active ? t.branches / t.active : t.branches ? Infinity : 0;
        let posture: 'NO_COVERAGE' | 'STRETCHED' | 'BALANCED' | 'SURPLUS' | 'NO_WORK';
        if (t.branches === 0) posture = t.active ? 'NO_WORK' : 'BALANCED';
        else if (t.active === 0) posture = 'NO_COVERAGE';
        else if (ratio > 12) posture = 'STRETCHED';
        else if (ratio < 3) posture = 'SURPLUS';
        else posture = 'BALANCED';
        return {
          ...t,
          branchesPerAssayer: Number.isFinite(ratio) ? Math.round(ratio * 10) / 10 : null,
          posture,
        };
      })
      .sort((a, b) => b.branches - a.branches || b.assayers - a.assayers);

    return {
      territories,
      hiringNeeded: territories.filter((t) => t.posture === 'NO_COVERAGE' || t.posture === 'STRETCHED'),
      idleTerritories: territories.filter((t) => t.posture === 'NO_WORK'),
    };
  }

  // ── Utilisation and wellbeing ────────────────────────────────────────────

  private async utilisation() {
    const idle = await this.dataSource.query(
      `
      SELECT a.id, a.assayer_code AS "assayerCode", a.display_name AS "displayName",
             a.state, a.district, a.last_assignment_date AS "lastAssignmentDate",
             a.total_assignments AS "totalAssignments",
             CASE WHEN a.last_assignment_date IS NULL THEN NULL
                  ELSE EXTRACT(DAY FROM NOW() - a.last_assignment_date)::int END AS "daysIdle"
      FROM assayers a
      WHERE a.lifecycle_status = 'ACTIVE'
        AND a.exit_date IS NULL AND a.termination_date IS NULL
        AND (a.last_assignment_date IS NULL OR a.last_assignment_date < NOW() - ($1 || ' days')::interval)
      ORDER BY a.last_assignment_date ASC NULLS FIRST
      LIMIT 50
    `,
      [IDLE_AFTER_DAYS],
    );

    const [performance] = await this.dataSource.query(`
      SELECT
        ROUND(AVG(NULLIF(average_rating, 0))::numeric, 2)                       AS "avgRating",
        COUNT(*) FILTER (WHERE average_rating > 0)::int                         AS rated,
        COUNT(*) FILTER (WHERE average_rating > 0 AND average_rating < 3)::int   AS "belowPar",
        SUM(total_assignments)::int                                             AS "totalAssignments",
        SUM(completed_assignments)::int                                         AS "completedAssignments",
        SUM(cancelled_assignments)::int                                         AS "cancelledAssignments",
        SUM(on_time_completions)::int                                           AS "onTimeCompletions"
      FROM assayers
      WHERE exit_date IS NULL AND termination_date IS NULL
    `);

    const completed = HrWorkforceService.num(performance.completedAssignments);

    // Live per-assayer utilisation: work in flight vs weekly capacity. This is the "who is
    // over-worked / who is idle" read, distinct from the "how old is the last job" idle query
    // above — one is capacity pressure, the other is engagement.
    //
    // This deliberately includes PENDING offers, because a manager looking at someone's plate
    // needs to see work that has been offered but not yet answered. Planning's capacity gate
    // counts only COMMITTED_ASSIGNMENT_STATUSES, so this figure can legitimately read higher
    // than the number planning enforces — the two answer different questions. See
    // modules/assignment/assignment-workload.ts. (This comment previously claimed the numbers
    // agreed with planning; they never did.)
    const utilizationRows = await this.dataSource.query(`
      SELECT a.id, a.assayer_code AS "assayerCode", a.display_name AS "displayName",
             a.state, a.district, a.max_weekly_workload AS "maxWeeklyWorkload",
             a.last_assignment_date AS "lastAssignmentDate",
             (SELECT COUNT(*) FROM assignments asg
               WHERE asg.assayer_id = a.id AND asg.is_active = true
                 AND asg.status IN (${sqlStatusList(IN_FLIGHT_ASSIGNMENT_STATUSES)})
             ) AS "currentAllocation"
      FROM assayers a
      WHERE a.lifecycle_status = 'ACTIVE' AND a.exit_date IS NULL AND a.termination_date IS NULL
      ORDER BY a.display_name ASC
    `);
    const DEFAULT_WEEKLY = 15;
    const utilization = (utilizationRows ?? []).map((r: any) => {
      const weeklyCapacity = r.maxWeeklyWorkload || DEFAULT_WEEKLY;
      const allocation = HrWorkforceService.num(r.currentAllocation);
      const pct = weeklyCapacity > 0 ? Math.round((allocation / weeklyCapacity) * 100) : 0;
      let posture: 'IDLE' | 'UNDER_UTILIZED' | 'BALANCED' | 'OVER_UTILIZED';
      if (allocation === 0) posture = 'IDLE';
      else if (allocation >= weeklyCapacity) posture = 'OVER_UTILIZED';
      else if (pct >= 60) posture = 'BALANCED';
      else posture = 'UNDER_UTILIZED';
      return {
        id: r.id,
        assayerCode: r.assayerCode,
        displayName: r.displayName,
        state: r.state,
        district: r.district,
        weeklyCapacity,
        currentAllocation: allocation,
        remainingCapacity: Math.max(0, weeklyCapacity - allocation),
        utilizationPercentage: pct,
        posture,
      };
    });
    const count = (p: string) => utilization.filter((u: any) => u.posture === p).length;
    const utilizationCounts = {
      idle: count('IDLE'),
      underUtilized: count('UNDER_UTILIZED'),
      balanced: count('BALANCED'),
      overUtilized: count('OVER_UTILIZED'),
      total: utilization.length,
    };

    return {
      idleAfterDays: IDLE_AFTER_DAYS,
      idle,
      idleCount: idle.length,
      // "Never assigned" is a different problem from "went quiet": one is an
      // onboarding failure, the other is a deployment or retention issue.
      neverAssigned: idle.filter((r: any) => r.lastAssignmentDate === null).length,
      utilization,
      utilizationCounts,
      performance: {
        ...performance,
        onTimeRate: completed
          ? Math.round((HrWorkforceService.num(performance.onTimeCompletions) / completed) * 100)
          : null,
      },
    };
  }

  // ── Attrition ────────────────────────────────────────────────────────────

  private async attrition() {
    const [totals] = await this.dataSource.query(`
      SELECT
        COUNT(*) FILTER (WHERE exit_date IS NOT NULL OR termination_date IS NOT NULL)::int AS "totalExits",
        COUNT(*) FILTER (WHERE COALESCE(exit_date, termination_date) > CURRENT_DATE - INTERVAL '90 days')::int  AS "exits90d",
        COUNT(*) FILTER (WHERE COALESCE(exit_date, termination_date) > CURRENT_DATE - INTERVAL '365 days')::int AS "exits12m",
        COUNT(*) FILTER (WHERE termination_date IS NOT NULL)::int AS terminations,
        COUNT(*) FILTER (WHERE joining_date > CURRENT_DATE - INTERVAL '90 days')::int AS "joins90d"
      FROM assayers
    `);

    const recent = await this.dataSource.query(`
      SELECT id, assayer_code AS "assayerCode", display_name AS "displayName", state,
             COALESCE(exit_date, termination_date) AS "exitDate",
             CASE WHEN termination_date IS NOT NULL THEN 'TERMINATED' ELSE 'RESIGNED' END AS mode,
             joining_date AS "joiningDate"
      FROM assayers
      WHERE exit_date IS NOT NULL OR termination_date IS NOT NULL
      ORDER BY COALESCE(exit_date, termination_date) DESC
      LIMIT 20
    `);

    const headcount = await this.dataSource.query(`
      SELECT COUNT(*)::int AS active FROM assayers
      WHERE exit_date IS NULL AND termination_date IS NULL
    `);

    const active = HrWorkforceService.num(headcount[0]?.active);
    return {
      ...totals,
      recent,
      // Annualised attrition against current headcount — the standard read.
      attritionRate12m: active
        ? Math.round((HrWorkforceService.num(totals.exits12m) / (active + HrWorkforceService.num(totals.exits12m))) * 1000) / 10
        : 0,
    };
  }

  // ── Traceability ─────────────────────────────────────────────────────────

  /** Who changed what, and when. Every HR action on a person lands here. */
  private async recentActivity() {
    return this.dataSource.query(`
      SELECT act.id, act.event_type AS "eventType", act.previous_state AS "previousState",
             act.new_state AS "newState",
             -- performed_by_name is written null at event time, so resolve the actor
             -- here: a staff user, or an assayer acting on their own record.
             COALESCE(
               act.performed_by_name,
               NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
               u.username,
               actor.display_name
             ) AS "performedBy",
             act.remarks, act.occurred_at AS "occurredAt",
             a.id AS "assayerId", a.assayer_code AS "assayerCode", a.display_name AS "displayName"
      FROM assayer_activities act
      JOIN assayers a ON a.id = act.assayer_id
      LEFT JOIN users u ON act.performed_by::text ~ '^[0-9a-fA-F-]{36}$' AND u.id = act.performed_by::uuid
      LEFT JOIN assayers actor ON act.performed_by::text ~ '^[0-9a-fA-F-]{36}$' AND actor.id = act.performed_by::uuid
      ORDER BY act.occurred_at DESC
      LIMIT 40
    `);
  }

  // ── What to do about it ──────────────────────────────────────────────────

  /**
   * Turns the panels above into a ranked worklist. Without this the dashboard
   * reports nine facts and leaves the prioritising to the reader, which is the
   * complaint the existing page attracted.
   */
  private deriveActions(parts: any): any[] {
    const actions: any[] = [];

    const criticalGaps = (parts.compliance?.fields ?? []).filter((f: any) => f.critical && f.missing > 0);
    for (const gap of criticalGaps) {
      actions.push({
        severity: gap.pct === 0 ? 'critical' : 'high',
        area: 'Record',
        title: `${gap.missing} of ${parts.compliance.roster} missing ${gap.label}`,
        detail: `Blocks ${gap.blocks.toLowerCase()}.`,
        link: '/hr?tab=records',
      });
    }

    if (parts.pipeline?.stalled?.length) {
      actions.push({
        severity: 'high',
        area: 'Onboarding',
        title: `${parts.pipeline.stalled.length} candidate(s) stalled over ${STALLED_AFTER_DAYS} days`,
        detail: 'Onboarding has not advanced; they cannot be assigned work until active.',
        link: '/hr?tab=onboarding',
      });
    }

    const expired = (parts.expiries?.certifications?.expired ?? 0) + (parts.expiries?.documents?.expired ?? 0);
    if (expired > 0) {
      actions.push({
        severity: 'critical',
        area: 'Compliance',
        title: `${expired} credential(s) already expired`,
        detail: 'Assayers holding expired credentials should not be deployed.',
        link: '/hr?tab=compliance',
      });
    }
    const soon = (parts.expiries?.certifications?.within30 ?? 0) + (parts.expiries?.documents?.within30 ?? 0);
    if (soon > 0) {
      actions.push({
        severity: 'medium',
        area: 'Compliance',
        title: `${soon} credential(s) expire within 30 days`,
        detail: 'Start renewals now to avoid losing deployable capacity.',
        link: '/hr?tab=compliance',
      });
    }

    for (const t of parts.deployment?.hiringNeeded ?? []) {
      actions.push({
        severity: t.posture === 'NO_COVERAGE' ? 'critical' : 'medium',
        area: 'Staffing',
        title:
          t.posture === 'NO_COVERAGE'
            ? `${t.state}: ${t.branches} branches, no active assayer`
            : `${t.state}: ${t.branchesPerAssayer} branches per assayer`,
        detail: t.posture === 'NO_COVERAGE' ? 'Work here cannot be staffed at all.' : 'Team is stretched; consider hiring.',
        link: '/hr?tab=deployment',
      });
    }

    if (parts.utilisation?.neverAssigned > 0) {
      actions.push({
        severity: 'medium',
        area: 'Utilisation',
        title: `${parts.utilisation.neverAssigned} active assayer(s) have never been assigned`,
        detail: 'Onboarded but never deployed — a retention risk and a wasted hire.',
        link: '/hr?tab=utilisation',
      });
    }

    const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    return actions.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 12);
  }
}
