import { Injectable, Optional } from '@nestjs/common';
import {
  AssayerLifecycleStatus, BackgroundCheckVerdict, CHECK_TYPES, CheckType, IDENTITY_DOCUMENTS,
  DEFAULT_RECHECK_POLICY, RECHECK_FIRST_ROUND_SETTING, RECHECK_GRACE_DAYS_SETTING, RECHECK_INTERVAL_SETTING,
  RECHECK_REMIND_DAYS_SETTING, businessDateKey, businessTodayDateKey, complianceWorkBlockers,
  isRecheckedLifecycle, recheckStanding, type ComplianceHold, type RecheckPolicy, type RecheckStanding,
} from '@fapoms/shared';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { tenantFilterId } from '../../infrastructure/tenancy/ambient-tenant-context';

/** One person's compliance position: every check type, the hold, and what stops new work. */
export interface ComplianceStanding {
  assayerId: string;
  /** Only people who are re-checked (working, or on leave) have standings; joiners do not. */
  rechecked: boolean;
  standings: RecheckStanding[];
  hold: ComplianceHold | null;
  /** Why they may not be given new work on compliance grounds — empty when nothing holds them. */
  blockers: string[];
}

const IS_DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * WHERE EACH PERSON STANDS ON THEIR RE-CHECKS — the one server answer (see `periodic-checks.ts`).
 *
 * Batched on purpose: a planning run asks it about every candidate at once, and a reminder sweep
 * about the whole working roster. Three queries answer any number of people — the latest completed
 * check of each type, the earliest identity-document expiry, and the person's stage and hold.
 */
@Injectable()
export class ComplianceStandingService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    @Optional() private readonly settings?: PlatformSettingsService,
  ) {}

  /** The re-check policy as configured — falling back to the shipped defaults for anything unset. */
  async policy(): Promise<RecheckPolicy> {
    const read = async <T>(key: string, fallback: T): Promise<T> => {
      if (!this.settings) return fallback;
      const v = await this.settings.get<T>(key).catch(() => null);
      return (v ?? fallback) as T;
    };
    const intervalMonths = { ...DEFAULT_RECHECK_POLICY.intervalMonths };
    for (const t of CHECK_TYPES) {
      const n = Number(await read(RECHECK_INTERVAL_SETTING[t], intervalMonths[t]));
      if (Number.isFinite(n) && n >= 1) intervalMonths[t] = Math.floor(n);
    }
    const graceDays = Number(await read(RECHECK_GRACE_DAYS_SETTING, DEFAULT_RECHECK_POLICY.graceDays));
    const remindDaysBefore = Number(await read(RECHECK_REMIND_DAYS_SETTING, DEFAULT_RECHECK_POLICY.remindDaysBefore));
    const firstRound = String(await read(RECHECK_FIRST_ROUND_SETTING, DEFAULT_RECHECK_POLICY.firstRoundDueOn)).trim();
    return {
      intervalMonths,
      graceDays: Number.isFinite(graceDays) && graceDays >= 0 ? graceDays : DEFAULT_RECHECK_POLICY.graceDays,
      remindDaysBefore: Number.isFinite(remindDaysBefore) && remindDaysBefore >= 0 ? remindDaysBefore : DEFAULT_RECHECK_POLICY.remindDaysBefore,
      // A mistyped date must not make everybody due today — it falls back to the shipped one.
      firstRoundDueOn: IS_DATE_KEY.test(firstRound) ? firstRound : DEFAULT_RECHECK_POLICY.firstRoundDueOn,
    };
  }

  /** Standings for many people at once. People not found are simply absent from the map. */
  async standingsFor(assayerIds: string[], today: string = businessTodayDateKey()): Promise<Map<string, ComplianceStanding>> {
    const ids = [...new Set(assayerIds.filter(Boolean))];
    const out = new Map<string, ComplianceStanding>();
    if (ids.length === 0) return out;
    const policy = await this.policy();

    const { people, latest, expiries } = await this.unitOfWork.run(async (m) => ({
      people: await m.query(
        `SELECT id, lifecycle_status, compliance_hold FROM assayers WHERE id = ANY($1::uuid[])`, [ids],
      ) as Array<{ id: string; lifecycle_status: string; compliance_hold: ComplianceHold | null }>,
      latest: await m.query(
        `SELECT DISTINCT ON (assayer_id, check_type) assayer_id, check_type, checked_on, verdict
           FROM assayer_background_checks
          WHERE is_active AND verdict <> 'NOT_CHECKED' AND assayer_id = ANY($1::uuid[])
          ORDER BY assayer_id, check_type, checked_on DESC NULLS LAST, created_at DESC`, [ids],
      ) as Array<{ assayer_id: string; check_type: CheckType; checked_on: string | Date | null; verdict: BackgroundCheckVerdict }>,
      expiries: await m.query(
        `SELECT assayer_id, MIN(expiry_date) AS earliest
           FROM assayer_documents
          WHERE is_active AND expiry_date IS NOT NULL AND requirement = ANY($2::text[]) AND assayer_id = ANY($1::uuid[])
          GROUP BY assayer_id`, [ids, [...IDENTITY_DOCUMENTS]],
      ) as Array<{ assayer_id: string; earliest: string | Date }>,
    }));

    const dateKey = (v: string | Date | null | undefined): string | null => {
      if (!v) return null;
      return typeof v === 'string' && IS_DATE_KEY.test(v.slice(0, 10)) ? v.slice(0, 10) : businessDateKey(v as Date) || null;
    };
    const latestBy = new Map<string, { checkedOn: string | null; verdict: BackgroundCheckVerdict }>();
    for (const r of latest) latestBy.set(`${r.assayer_id}:${r.check_type}`, { checkedOn: dateKey(r.checked_on), verdict: r.verdict });
    const expiryBy = new Map(expiries.map((e) => [e.assayer_id, dateKey(e.earliest)]));

    for (const p of people) {
      const rechecked = isRecheckedLifecycle(p.lifecycle_status);
      const standings = rechecked
        ? CHECK_TYPES.map((type) => {
          const last = latestBy.get(`${p.id}:${type}`);
          return recheckStanding({
            type, lastCheckedOn: last?.checkedOn ?? null, lastVerdict: last?.verdict ?? null, policy, today,
            earliestIdentityExpiry: type === CheckType.IDENTITY ? expiryBy.get(p.id) ?? null : null,
          });
        })
        : [];
      const hold = p.compliance_hold ?? null;
      out.set(p.id, {
        assayerId: p.id,
        rechecked,
        standings,
        hold,
        // A hold outlives the working stage only in data; once suspended, the lifecycle refuses work.
        blockers: rechecked || hold ? complianceWorkBlockers(standings, hold) : [],
      });
    }
    return out;
  }

  async standingFor(assayerId: string, today?: string): Promise<ComplianceStanding | null> {
    return (await this.standingsFor([assayerId], today)).get(assayerId) ?? null;
  }

  /** Why this one person may not be given new work on compliance grounds — empty when free. */
  async workBlockers(assayerId: string): Promise<string[]> {
    return (await this.standingFor(assayerId))?.blockers ?? [];
  }

  /**
   * Everybody working whose re-checks need attention — due soon, due, overdue, or held — in the
   * caller's organisation. The HR list and the reminder sweep both read this.
   */
  async attentionList(today: string = businessTodayDateKey(), organizationId: string | null = tenantFilterId()): Promise<Array<ComplianceStanding & {
    displayName: string; assayerCode: string | null; organizationId: string | null;
  }>> {
    const working: Array<{ id: string; display_name: string; assayer_code: string | null; organization_id: string | null }> =
      await this.unitOfWork.run((m) => m.query(
        `SELECT id, display_name, assayer_code, organization_id FROM assayers
          WHERE is_active AND (lifecycle_status::text = ANY($1::text[]) OR compliance_hold IS NOT NULL)
            AND ($2::uuid IS NULL OR organization_id = $2::uuid)
          ORDER BY display_name`,
        [[AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.ON_LEAVE], organizationId],
      ));
    const out: Array<ComplianceStanding & { displayName: string; assayerCode: string | null; organizationId: string | null }> = [];
    for (let i = 0; i < working.length; i += 500) {
      const chunk = working.slice(i, i + 500);
      const map = await this.standingsFor(chunk.map((w) => w.id), today);
      for (const w of chunk) {
        const s = map.get(w.id);
        if (!s) continue;
        if (!s.hold && s.standings.every((x) => x.status === 'OK')) continue;
        out.push({ ...s, displayName: w.display_name, assayerCode: w.assayer_code, organizationId: w.organization_id });
      }
    }
    return out;
  }
}
