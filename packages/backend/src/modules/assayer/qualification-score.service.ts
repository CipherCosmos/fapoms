import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, IsNull, Not, MoreThanOrEqual } from 'typeorm';
import {
  AssayerQualificationView,
  DimensionScoreView,
  PartnerQualificationView,
  ScoreOverrideView,
  OverridableScoreKey,
  QUALIFICATION_DIMENSIONS,
  QualificationDimensionKey,
  EmpanelmentStatus,
  empanelmentCapsFrom,
  DEFAULT_STANDING_CAP_NEGATIVE,
  DEFAULT_STANDING_CAP_DORMANT,
  DEFAULT_STANDING_CAP_DOCUMENTS_PENDING,
  IDENTITY_DOCUMENTS,
  ONBOARDING_DOCUMENT_LABELS,
  maskTail,
} from '@fapoms/shared';
import { AssayerEntity, AssayerWithWorkforceAttributes } from './assayer.entity';
import { AssayerScoreOverrideEntity } from './assayer-score-override.entity';
import { AssayerRemarkEntity } from './assayer-remark.entity';
import { AssayerReferenceEntity } from './assayer-reference.entity';
import { AssayerBackgroundCheckEntity } from './assayer-background-check.entity';
import { AssayerDocumentEntity } from './assayer-document.entity';
import { AssayerClientEmpanelmentEntity } from './assayer-client-empanelment.entity';
import { ClientEntity } from '../client/client.entity';
import { AssayerService } from './assayer.service';
import { RosterRecordsService } from './roster-records.service';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import {
  identityVerificationScore,
  payabilityScore,
  backgroundCheckScore,
  referencesScore,
  credentialsScore,
  trackRecordScore,
  partnerRequirementsScore,
  overallScore,
  applyStandingCap,
  ScoredDimension,
  AttributeInput,
} from './qualification-score.contract';
import {
  summariseRemarks,
  REMARK_SCORING_WINDOW_DAYS,
  RemarkSummary,
} from '../assayer-remarks/assayer-remark.contract';

/**
 * Computes the qualification scores — always on read, never cached.
 *
 * The inputs live in five tables that HR edits all day (documents, checks, references,
 * empanelments, attributes); a cached score would need an invalidation hook on every one of
 * those write paths, which is the exact drift failure `assayers.status` already demonstrated.
 * One profile read costs a handful of indexed single-assayer queries; the pooled partner
 * listing batches the same reads across the roster so it costs seven grouped queries, not
 * seven per person.
 *
 * The only stored state is the override table — the one thing the data cannot produce.
 */
@Injectable()
export class QualificationScoreService {
  constructor(
    @InjectRepository(AssayerEntity) private readonly assayers: Repository<AssayerEntity>,
    @InjectRepository(AssayerScoreOverrideEntity) private readonly overrides: Repository<AssayerScoreOverrideEntity>,
    @InjectRepository(AssayerRemarkEntity) private readonly remarks: Repository<AssayerRemarkEntity>,
    @InjectRepository(AssayerReferenceEntity) private readonly references: Repository<AssayerReferenceEntity>,
    @InjectRepository(AssayerBackgroundCheckEntity) private readonly checks: Repository<AssayerBackgroundCheckEntity>,
    @InjectRepository(AssayerDocumentEntity) private readonly documents: Repository<AssayerDocumentEntity>,
    @InjectRepository(AssayerClientEmpanelmentEntity) private readonly empanelments: Repository<AssayerClientEmpanelmentEntity>,
    @InjectRepository(ClientEntity) private readonly clients: Repository<ClientEntity>,
    private readonly assayerService: AssayerService,
    private readonly rosterRecords: RosterRecordsService,
    private readonly settings: PlatformSettingsService,
  ) {}

  // ── Weights & settings ────────────────────────────────────────────────────

  /** The relative weights in force: saved setting → default from the shared vocabulary. */
  async weights(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    await Promise.all(
      QUALIFICATION_DIMENSIONS.map(async (d) => {
        out[d.key] = await this.settings.getNumber(d.weightSetting, d.defaultWeight).catch(() => d.defaultWeight);
      }),
    );
    return out;
  }

  /**
   * The operator-tunable policy behind the formulas — nothing here is hardcoded. All of it is
   * editable at /admin/settings under "Assayer qualification" and applies on the next read
   * (compute-on-read means a settings change is never stale anywhere).
   */
  private async policy(): Promise<{
    validityMonths: number;
    referencesTarget: number;
    caps: ReturnType<typeof empanelmentCapsFrom>;
  }> {
    const [validityMonths, referencesTarget, capNegative, capDormant, capDocs] = await Promise.all([
      this.settings.getNumber('qualification.backgroundCheckValidityMonths', 24).catch(() => 24),
      this.settings.getNumber('qualification.referencesTarget', 2).catch(() => 2),
      this.settings.getNumber('qualification.cap.negativeStanding', DEFAULT_STANDING_CAP_NEGATIVE).catch(() => DEFAULT_STANDING_CAP_NEGATIVE),
      this.settings.getNumber('qualification.cap.dormantStanding', DEFAULT_STANDING_CAP_DORMANT).catch(() => DEFAULT_STANDING_CAP_DORMANT),
      this.settings.getNumber('qualification.cap.documentsPending', DEFAULT_STANDING_CAP_DOCUMENTS_PENDING).catch(() => DEFAULT_STANDING_CAP_DOCUMENTS_PENDING),
    ]);
    return { validityMonths, referencesTarget, caps: empanelmentCapsFrom(capNegative, capDormant, capDocs) };
  }

  // ── Profile qualification ─────────────────────────────────────────────────

  async qualification(assayerId: string): Promise<AssayerQualificationView & { printSummary: Record<string, unknown> }> {
    const assayer = await this.assayers.findOne({ where: { id: assayerId } });
    if (!assayer) throw new NotFoundException('No such assayer.');

    const [dims, weights, overrideRows] = await Promise.all([
      this.profileDimensions(assayer),
      this.weights(),
      this.overrides.find({ where: { assayerId, isActive: true, clientId: IsNull() } }),
    ]);
    const overrideByDim = await this.overrideViews(overrideRows);

    const dimensions: DimensionScoreView[] = dims.map((d) => {
      const def = QUALIFICATION_DIMENSIONS.find((q) => q.key === d.key)!;
      const override = overrideByDim.get(d.key) ?? null;
      return {
        key: d.key,
        label: def.label,
        computed: d.score,
        override,
        effective: override ? override.value : d.score,
        basis: d.basis,
      };
    });

    // The computed overall reads the computed dimensions; the effective overall reads the
    // EFFECTIVE ones — a human's correction to one dimension must move the total, or the
    // override would be cosmetic. An override on 'overall' itself then outranks both.
    const computedOverall = overallScore(dimensions.map((d) => ({ key: d.key, score: d.computed })), weights);
    const effectiveFromDims = overallScore(dimensions.map((d) => ({ key: d.key, score: d.effective })), weights);
    const overallOverride = overrideByDim.get('overall') ?? null;

    return {
      assayerId,
      dimensions,
      overall: {
        computed: computedOverall,
        override: overallOverride,
        effective: overallOverride ? overallOverride.value : effectiveFromDims,
      },
      weights,
      computedAt: new Date().toISOString(),
      printSummary: this.printSummary(assayer),
    };
  }

  /**
   * The identity block for the printable profile — pre-masked HERE, on the server, so the
   * page that leaves the building never holds a full PAN or Aadhaar to begin with.
   */
  private printSummary(a: AssayerEntity): Record<string, unknown> {
    return {
      displayName: a.displayName,
      assayerCode: a.assayerCode,
      phone: a.phone,
      email: a.email,
      city: a.city,
      district: a.district,
      state: a.state,
      lifecycleStatus: a.lifecycleStatus,
      joiningDate: a.joiningDate,
      experienceYears: a.experienceYears,
      panMasked: maskTail(a.panNumber),
      aadhaarMasked: maskTail(a.aadhaarNumber),
    };
  }

  // ── Partner qualification ─────────────────────────────────────────────────

  async partnerQualifications(assayerId: string): Promise<PartnerQualificationView[]> {
    const assayer = await this.assayers.findOne({ where: { id: assayerId } });
    if (!assayer) throw new NotFoundException('No such assayer.');

    const [dims, weights, policy, allClients, empanelmentRows, overrideRows] = await Promise.all([
      this.profileDimensions(assayer),
      this.weights(),
      this.policy(),
      this.clients.find({ where: { isActive: true }, order: { name: 'ASC' } }),
      this.empanelments.find({ where: { assayerId, isActive: true } }),
      this.overrides.find({ where: { assayerId, isActive: true, clientId: Not(IsNull()) } }),
    ]);
    const empanelmentByClient = new Map(empanelmentRows.map((e) => [e.clientId, e]));
    const overridesByClient = new Map<string, AssayerScoreOverrideEntity[]>();
    for (const o of overrideRows) (overridesByClient.get(o.clientId!) ?? overridesByClient.set(o.clientId!, []).get(o.clientId!)!).push(o);

    const held = this.heldCredentials(assayer as AssayerWithWorkforceAttributes);
    const views: PartnerQualificationView[] = [];
    for (const client of allClients) {
      views.push(await this.partnerView(assayer, client, dims, weights, policy.caps, empanelmentByClient.get(client.id) ?? null, overridesByClient.get(client.id) ?? []));
    }
    return views;
  }

  private async partnerView(
    assayer: AssayerEntity,
    client: ClientEntity,
    profileDims: ScoredDimension[],
    weights: Record<string, number>,
    caps: ReturnType<typeof empanelmentCapsFrom>,
    empanelment: AssayerClientEmpanelmentEntity | null,
    clientOverrides: AssayerScoreOverrideEntity[],
  ): Promise<PartnerQualificationView> {
    const prefs = (client.planningPreferences ?? {}) as Record<string, unknown>;
    const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    const required = {
      skills: asList(prefs.requiredSkills),
      certifications: asList(prefs.requiredCertifications),
    };
    const held = this.heldCredentials(assayer as AssayerWithWorkforceAttributes);
    const partnerDim = partnerRequirementsScore(required, held);

    const overrideViews = await this.overrideViews(clientOverrides);
    const allDims: ScoredDimension[] = [...profileDims, partnerDim];
    const dimensions: DimensionScoreView[] = allDims.map((d) => {
      const def = QUALIFICATION_DIMENSIONS.find((q) => q.key === d.key)!;
      const override = overrideViews.get(d.key) ?? null;
      return { key: d.key, label: def.label, computed: d.score, override, effective: override ? override.value : d.score, basis: d.basis };
    });

    const computed = overallScore(dimensions.map((d) => ({ key: d.key, score: d.computed })), weights);
    const effectiveBase = overallScore(dimensions.map((d) => ({ key: d.key, score: d.effective })), weights);

    const standing = (empanelment?.status as EmpanelmentStatus | undefined) ?? null;
    const barred = Array.isArray(client.restrictedAssayers) && client.restrictedAssayers.includes(assayer.id);
    const { effective: capped, cap } = applyStandingCap(effectiveBase, standing, caps);
    const overallOverride = overrideViews.get('overall') ?? null;

    // Precedence: barred is absolute (the client said never); then a human override on this
    // partner's overall; then the standing cap on the computed number.
    const effective = barred ? 0 : overallOverride ? overallOverride.value : capped;

    return {
      client: { id: client.id, name: client.name, clientCode: (client as any).clientCode ?? null },
      dimensions,
      computed,
      effective,
      override: overallOverride,
      standing,
      standingReason: empanelment?.statusReason ?? null,
      standingCap: barred ? null : cap,
      barred,
      gaps: this.gapsFor(dimensions, empanelment),
    };
  }

  /** "What to fix to raise this score" — the basis lines that name an absence or a fault. */
  private gapsFor(dimensions: DimensionScoreView[], empanelment: AssayerClientEmpanelmentEntity | null): string[] {
    const gaps: string[] = [];
    for (const d of dimensions) {
      for (const line of d.basis) {
        if (/missing|awaiting|stale|lapsed|rejected|no .* on file|no .* yet|no work history/i.test(line)) gaps.push(line);
      }
    }
    if (empanelment?.documentsOutstanding) gaps.push(`Documents outstanding for this partner: ${empanelment.documentsOutstanding}`);
    return gaps;
  }

  private heldCredentials(a: AssayerWithWorkforceAttributes): { skills: string[]; certifications: string[] } {
    return {
      skills: Array.isArray(a.skills) ? a.skills : [],
      certifications: Array.isArray(a.certifications) ? a.certifications.map((c) => c.name) : [],
    };
  }

  // ── The six profile dimensions, from live data ────────────────────────────

  private async profileDimensions(assayer: AssayerEntity): Promise<ScoredDimension[]> {
    const now = new Date();
    const [dossierDocs, refs, latestCheck, policy, remarkSummary, history] = await Promise.all([
      this.documents.find({ where: { assayerId: assayer.id, isActive: true } }),
      this.references.find({ where: { assayerId: assayer.id, isActive: true } }),
      this.checks.findOne({ where: { assayerId: assayer.id, isActive: true }, order: { checkedOn: 'DESC', createdAt: 'DESC' } }),
      this.policy(),
      this.remarkSummaryFor(assayer.id, now),
      this.workHistoryFor(assayer.id),
    ]);
    await this.assayerService.hydrateWorkforceAttributes(assayer);
    const hydrated = assayer as AssayerWithWorkforceAttributes;

    const identityInputs = dossierDocs
      .filter((d) => IDENTITY_DOCUMENTS.includes(d.requirement as any))
      .map((d) => ({
        identity: true,
        id: d.id,
        label: (ONBOARDING_DOCUMENT_LABELS as Record<string, string>)[d.requirement] ?? d.requirement,
        verificationStatus: (d.verificationStatus as any) ?? null,
        expiryDate: d.expiryDate ?? null,
      }));

    const attributeInputs: AttributeInput[] = [
      ...(hydrated.skills ?? []).map((s) => ({ type: 'SKILL', name: s, expiryDate: null })),
      ...(hydrated.certifications ?? []).map((c) => ({ type: 'CERTIFICATION', name: c.name, expiryDate: c.expiryDate ?? null })),
    ];

    return [
      identityVerificationScore(identityInputs, now),
      payabilityScore(assayer as unknown as Record<string, unknown>),
      backgroundCheckScore(latestCheck ?? null, policy.validityMonths, now),
      referencesScore(refs, policy.referencesTarget),
      credentialsScore(attributeInputs, now),
      trackRecordScore({
        totalAssignments: history.total,
        completedAssignments: history.completed,
        onTimeCompletions: history.onTime,
        acceptanceRate: history.total > 0 ? Math.round((100 * history.accepted) / history.total) : null,
        remarkSummary,
      }),
    ];
  }

  private async remarkSummaryFor(assayerId: string, now: Date): Promise<RemarkSummary> {
    const since = new Date(now.getTime() - REMARK_SCORING_WINDOW_DAYS * 86_400_000);
    const rows = await this.remarks.find({
      where: { assayerId, isActive: true, rating: Not(IsNull()), createdAt: MoreThanOrEqual(since) },
      order: { createdAt: 'DESC' },
    });
    return summariseRemarks(
      rows.map((r) => ({
        rating: r.rating, category: r.category, content: r.content,
        authorRole: (r as any).authorRole ?? null, authorName: (r as any).authorName ?? null, createdAt: r.createdAt,
      })) as any,
      now,
    );
  }

  /**
   * Live work-history counts, in one query — deliberately NOT the cached entity counters,
   * which refresh lazily and can lag an assignment transition. "Completed" mirrors
   * updateAssayerStats exactly (assignment COMPLETED, or its branch settled past the audit),
   * so this dimension and the roster's own numbers can never disagree.
   */
  private async workHistoryFor(assayerId: string): Promise<{ total: number; accepted: number; completed: number; onTime: number }> {
    const [row] = await this.assayers.manager.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE a.status IN ('ACCEPTED','COMPLETED'))::int AS accepted,
              COUNT(*) FILTER (WHERE a.status = 'COMPLETED' OR pb.status IN ('AUDIT_COMPLETED','VALIDATION_COMPLETED','CLOSED'))::int AS completed,
              COUNT(*) FILTER (WHERE (a.status = 'COMPLETED' OR pb.status IN ('AUDIT_COMPLETED','VALIDATION_COMPLETED','CLOSED'))
                                 AND (a.completion_date IS NULL OR a.scheduled_date IS NULL OR a.completion_date <= a.scheduled_date))::int AS on_time
         FROM assignments a
         LEFT JOIN project_branches pb ON pb.id = a.project_branch_id
        WHERE a.assayer_id = $1 AND a.is_active = true`,
      [assayerId],
    ).catch(() => [{ total: 0, accepted: 0, completed: 0, on_time: 0 }]);
    return {
      total: Number(row?.total) || 0,
      accepted: Number(row?.accepted) || 0,
      completed: Number(row?.completed) || 0,
      onTime: Number(row?.on_time) || 0,
    };
  }

  // ── Overrides ─────────────────────────────────────────────────────────────

  private async overrideViews(rows: AssayerScoreOverrideEntity[]): Promise<Map<string, ScoreOverrideView>> {
    const byDim = new Map<string, ScoreOverrideView>();
    const setterIds = [...new Set(rows.map((r) => r.setBy).filter(Boolean))] as string[];
    const names = new Map<string, string>();
    if (setterIds.length) {
      const users = await this.assayers.manager
        .query(`SELECT id, COALESCE(display_name, username) AS name FROM users WHERE id = ANY($1)`, [setterIds])
        .catch(() => []);
      for (const u of users) names.set(u.id, u.name);
    }
    for (const r of rows) {
      byDim.set(r.dimension, {
        id: r.id,
        value: r.value,
        reason: r.reason,
        setBy: r.setBy,
        setByName: r.setBy ? names.get(r.setBy) ?? null : null,
        setAt: r.setAt instanceof Date ? r.setAt.toISOString() : String(r.setAt),
      });
    }
    return byDim;
  }

  async setOverride(
    assayerId: string,
    dto: { dimension: string; clientId?: string | null; value: number; reason: string },
    actorId: string,
  ): Promise<AssayerScoreOverrideEntity> {
    const validKeys = new Set<string>([...QUALIFICATION_DIMENSIONS.map((d) => d.key), 'overall']);
    if (!validKeys.has(dto.dimension)) {
      throw new BadRequestException(`'${dto.dimension}' is not a scoreable dimension.`);
    }
    const value = Math.round(Number(dto.value));
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new BadRequestException('An override is a number from 0 to 100.');
    }
    const reason = (dto.reason ?? '').trim();
    if (!reason) {
      throw new BadRequestException('Say why the computed score is being overridden — the reason travels with the number.');
    }
    const assayer = await this.assayers.findOne({ where: { id: assayerId } });
    if (!assayer) throw new NotFoundException('No such assayer.');
    const clientId = dto.clientId || null;
    if (clientId) {
      const client = await this.clients.findOne({ where: { id: clientId } });
      if (!client) throw new NotFoundException('No such client.');
    }

    // One live override per slot: supersede, never stack. The old row survives as history.
    const existing = await this.overrides.find({
      where: { assayerId, dimension: dto.dimension as OverridableScoreKey, clientId: clientId ?? IsNull(), isActive: true },
    });
    for (const row of existing) {
      row.isActive = false;
      row.updatedBy = actorId;
      await this.overrides.save(row);
    }

    const saved = await this.overrides.save(
      this.overrides.create({
        assayerId,
        clientId,
        dimension: dto.dimension as OverridableScoreKey,
        value,
        reason,
        setBy: actorId,
        setAt: new Date(),
        createdBy: actorId,
        updatedBy: actorId,
      }),
    );

    await this.assayerService.recordActivity(
      assayerId,
      'SCORE_OVERRIDE_SET',
      existing.length ? String(existing[0].value) : null,
      String(value),
      actorId,
      `${dto.dimension}${clientId ? ` (client ${clientId})` : ''} set to ${value}: ${reason}`,
    );
    return saved;
  }

  async clearOverride(overrideId: string, actorId: string): Promise<void> {
    const row = await this.overrides.findOne({ where: { id: overrideId, isActive: true } });
    if (!row) throw new NotFoundException('No such live override.');
    row.isActive = false;
    row.updatedBy = actorId;
    await this.overrides.save(row);
    await this.assayerService.recordActivity(
      row.assayerId,
      'SCORE_OVERRIDE_CLEARED',
      String(row.value),
      null,
      actorId,
      `${row.dimension}${row.clientId ? ` (client ${row.clientId})` : ''} override cleared — computed score back in force`,
    );
  }

  // ── The reverse listing: who is qualified for this partner ────────────────

  /**
   * Every plannable assayer scored for one client, batched: seven grouped queries for the
   * whole roster, not seven per person. Ranked best-first; `minScore` trims the tail.
   */
  async qualifiedAssayersForClient(clientId: string, minScore = 0): Promise<Array<{
    assayer: { id: string; displayName: string; assayerCode: string; city: string | null; state: string | null };
    computed: number | null;
    effective: number | null;
    standing: EmpanelmentStatus | null;
    barred: boolean;
    gaps: string[];
  }>> {
    const client = await this.clients.findOne({ where: { id: clientId } });
    if (!client) throw new NotFoundException('No such client.');

    const pool = await this.assayers.find({ where: { isActive: true, status: 'ACTIVE' as any } });
    if (pool.length === 0) return [];
    const ids = pool.map((a) => a.id);
    const now = new Date();

    const [allRefs, allChecks, allDocs, allEmp, allOverrides, weights, policy, remarkRows, historyRows] = await Promise.all([
      this.references.find({ where: { assayerId: In(ids), isActive: true } }),
      this.checks.find({ where: { assayerId: In(ids), isActive: true }, order: { checkedOn: 'DESC', createdAt: 'DESC' } }),
      this.documents.find({ where: { assayerId: In(ids), isActive: true, requirement: In(IDENTITY_DOCUMENTS as any) } }),
      this.empanelments.find({ where: { clientId, isActive: true } }),
      this.overrides.find({ where: { assayerId: In(ids), isActive: true } }),
      this.weights(),
      this.policy(),
      this.remarks.find({
        where: { assayerId: In(ids), isActive: true, rating: Not(IsNull()), createdAt: MoreThanOrEqual(new Date(now.getTime() - REMARK_SCORING_WINDOW_DAYS * 86_400_000)) },
        order: { createdAt: 'DESC' },
      }),
      this.assayers.manager.query(
        `SELECT a.assayer_id, COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE a.status IN ('ACCEPTED','COMPLETED'))::int AS accepted,
                COUNT(*) FILTER (WHERE a.status = 'COMPLETED' OR pb.status IN ('AUDIT_COMPLETED','VALIDATION_COMPLETED','CLOSED'))::int AS completed,
                COUNT(*) FILTER (WHERE (a.status = 'COMPLETED' OR pb.status IN ('AUDIT_COMPLETED','VALIDATION_COMPLETED','CLOSED'))
                                   AND (a.completion_date IS NULL OR a.scheduled_date IS NULL OR a.completion_date <= a.scheduled_date))::int AS on_time
           FROM assignments a
           LEFT JOIN project_branches pb ON pb.id = a.project_branch_id
          WHERE a.assayer_id = ANY($1) AND a.is_active = true GROUP BY a.assayer_id`,
        [ids],
      ).catch(() => []),
    ]);
    await this.assayerService.hydrateAllWorkforceAttributes(pool);

    const groupBy = <T extends { assayerId: string }>(rows: T[]) => {
      const m = new Map<string, T[]>();
      for (const r of rows) (m.get(r.assayerId) ?? m.set(r.assayerId, []).get(r.assayerId)!).push(r);
      return m;
    };
    const refsBy = groupBy(allRefs);
    const checksBy = groupBy(allChecks);
    const docsBy = groupBy(allDocs);
    const empBy = new Map(allEmp.map((e) => [e.assayerId, e]));
    const historyBy = new Map(historyRows.map((r: any) => [r.assayer_id, r]));
    const remarksBy = groupBy(remarkRows);
    const restricted = new Set(Array.isArray(client.restrictedAssayers) ? client.restrictedAssayers : []);

    const prefs = (client.planningPreferences ?? {}) as Record<string, unknown>;
    const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    const required = { skills: asList(prefs.requiredSkills), certifications: asList(prefs.requiredCertifications) };

    const results = pool.map((assayer) => {
      const hydrated = assayer as AssayerWithWorkforceAttributes;
      const identityInputs = (docsBy.get(assayer.id) ?? []).map((d) => ({
        identity: true, id: d.id,
        label: (ONBOARDING_DOCUMENT_LABELS as Record<string, string>)[d.requirement] ?? d.requirement,
        verificationStatus: (d.verificationStatus as any) ?? null, expiryDate: d.expiryDate ?? null,
      }));
      const attributeInputs: AttributeInput[] = [
        ...(hydrated.skills ?? []).map((s) => ({ type: 'SKILL', name: s, expiryDate: null })),
        ...(hydrated.certifications ?? []).map((c) => ({ type: 'CERTIFICATION', name: c.name, expiryDate: c.expiryDate ?? null })),
      ];
      const hist = historyBy.get(assayer.id) as any;
      const summary = summariseRemarks(
        (remarksBy.get(assayer.id) ?? []).map((r) => ({
          rating: r.rating, category: r.category, content: r.content,
          authorRole: (r as any).authorRole ?? null, authorName: (r as any).authorName ?? null, createdAt: r.createdAt,
        })) as any,
        now,
      );

      const dims: ScoredDimension[] = [
        identityVerificationScore(identityInputs, now),
        payabilityScore(assayer as unknown as Record<string, unknown>),
        backgroundCheckScore((checksBy.get(assayer.id) ?? [])[0] ?? null, policy.validityMonths, now),
        referencesScore(refsBy.get(assayer.id) ?? [], policy.referencesTarget),
        credentialsScore(attributeInputs, now),
        trackRecordScore({
          totalAssignments: hist ? Number(hist.total) || 0 : 0,
          completedAssignments: hist ? Number(hist.completed) || 0 : 0,
          onTimeCompletions: hist ? Number(hist.on_time) || 0 : 0,
          acceptanceRate: hist && Number(hist.total) > 0 ? Math.round((100 * Number(hist.accepted)) / Number(hist.total)) : null,
          remarkSummary: summary,
        }),
        partnerRequirementsScore(required, this.heldCredentials(hydrated)),
      ];

      const liveOverrides = (allOverrides ?? []).filter(
        (o) => o.assayerId === assayer.id && (o.clientId === clientId || o.clientId === null),
      );
      // Client-specific override outranks the profile-level one for the same dimension.
      const overrideFor = (key: string) =>
        liveOverrides.find((o) => o.dimension === key && o.clientId === clientId)
        ?? liveOverrides.find((o) => o.dimension === key && o.clientId === null)
        ?? null;

      const effectiveDims = dims.map((d) => ({ key: d.key, score: overrideFor(d.key)?.value ?? d.score }));
      const computed = overallScore(dims.map((d) => ({ key: d.key, score: d.score })), weights);
      const effectiveBase = overallScore(effectiveDims, weights);
      const standing = (empBy.get(assayer.id)?.status as EmpanelmentStatus | undefined) ?? null;
      const barred = restricted.has(assayer.id);
      const { effective: capped } = applyStandingCap(effectiveBase, standing, policy.caps);
      const overallOv = overrideFor('overall');
      const effective = barred ? 0 : overallOv ? overallOv.value : capped;

      const gaps: string[] = [];
      for (const d of dims) for (const b of d.basis) {
        if (/missing|awaiting|stale|lapsed|rejected|no .* on file|no .* yet|no work history/i.test(b)) gaps.push(b);
      }

      return {
        assayer: { id: assayer.id, displayName: assayer.displayName, assayerCode: assayer.assayerCode, city: assayer.city ?? null, state: assayer.state ?? null },
        computed, effective, standing, barred, gaps,
      };
    });

    return results
      .filter((r) => (r.effective ?? -1) >= minScore || minScore <= 0)
      .sort((a, b) => (b.effective ?? -1) - (a.effective ?? -1) || a.assayer.displayName.localeCompare(b.assayer.displayName));
  }
}
