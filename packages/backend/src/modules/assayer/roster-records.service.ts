import { Injectable, NotFoundException, BadRequestException, ConflictException, Optional } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, In, IsNull, SelectQueryBuilder, DataSource } from 'typeorm';
import type { GlobalScope } from '../../infrastructure/scope/global-scope';
import { assertTenantOwns, tenantFilterId, tenantWhere } from '../../infrastructure/tenancy/ambient-tenant-context';
import {
  EmpanelmentStatus, BackgroundCheckVerdict, RiskGrade, CibilBand, OnboardingDocument, ONBOARDING_DOCUMENT_COLUMNS, ONBOARDING_DOCUMENT_LABELS, DocumentVerification, isIdentityDocument, maskTail, looksMasked, isValidPan, isValidAadhaar, isPlaceholderAadhaar,
  DocumentRejectionReason, DOCUMENT_PRINTED_FIELDS, PRINTED_FIELD_LABELS,
  DOCUMENTS_PRINTING_A_NAME, IDENTITY_NAME_PRECEDENCE, IDENTITY_GATE_DOCUMENTS,
  DOCUMENT_REJECTION_GUIDANCE,
  compareNames, type NameMatchGrade,
  /**
   * The deployability vocabulary, imported rather than restated. Every one of these is the exact
   * predicate a dispatch or payment gate already calls — see `deploymentVerdict`, which composes
   * them and writes no rule of its own.
   */
  AssayerLifecycleStatus, assayerLifecycleLabel, operationalStatusFor, onboardingNextStep,
  hasLeftWorkforce, stillWorkable, cannotBePaid, payoutBlockingGaps,
  missingAssayerRecordFields, isPlaceholderPin, standingAllowsPlanning,
} from '@fapoms/shared';
import { AssayerEntity } from './assayer.entity';
import { AssayerReferenceEntity } from './assayer-reference.entity';
import { AssayerClientEmpanelmentEntity } from './assayer-client-empanelment.entity';
import { AssayerBackgroundCheckEntity } from './assayer-background-check.entity';
import { AssayerDocumentEntity } from './assayer-document.entity';
import { AssayerDocumentVersionEntity } from './assayer-document-version.entity';
import { AssayerImportIssueEntity } from './assayer-import-issue.entity';
import { ASSAYER_ERROR_CODES, EventCategory } from '@fapoms/shared';
import { withCode } from '../../infrastructure/http/api-error';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { AuditService } from '../../core/audit/audit.service';
import {
  assertEmpanelmentVersion, lockEmpanelmentRow, translateConcurrentEmpanelmentCreate,
} from './empanelment-version';

/**
 * The workforce records the roster spreadsheet was holding sideways.
 *
 * Four of these were columns before they were tables — two reference pairs, a column per client,
 * four columns holding one background check, and fifteen yes/no columns for paperwork. The fifth
 * holds what the import could not read. What they have in common is that each is a *repeating*
 * fact about one person, and the reason to give them a service of their own rather than folding
 * them into `AssayerService` is that they are read together and almost always by the same
 * question: may we send this person out, and to whom.
 *
 * Two rules the writes hold.
 *
 * **A standing is per client, and there is one of it.** The unique constraint says so; this
 * upserts rather than inserting, because two rows would be two answers to "may we send them" with
 * nothing to say which counts.
 *
 * **A background check is history, not a field.** Each check is a new row and the current verdict
 * is the latest one. These are the grounds on which somebody is admitted to a bank vault, and
 * "cleared in 2022, civil case in 2026" is a sentence the column version could not say.
 */
/**
 * Identity documents whose number is already a column on the person.
 *
 * A PAN number is a fact about somebody, not about the card: payroll reads `pan_number`,
 * `ASSAYER_RECORD_FIELDS` counts it as a critical gap, and the mobile app shows it. The card is
 * the document that evidences it, which is what the document record tracks — whether a copy
 * arrived, whether anybody checked it against the original.
 *
 * So the number is stored once, on the person, and surfaced in both places. Writing it through
 * the document record writes the column; reading the document record reads the column back.
 * Storing it twice would mean the record and the document could disagree about somebody's PAN,
 * with nothing to say which was right.
 *
 * Documents with no column of their own — passport, driving licence, voter ID — keep their
 * number on the document record, where it is the only copy.
 */
/**
 * The outcome of detaching one scan, and the only authority on whether the object may be erased.
 *
 * `detachFile` used to return the bare key, which the controller read as "delete this". The key
 * alone cannot answer the question: the same object is referenced from two tables, and only one
 * of them was ever consulted. So the answer travels with it now.
 */
export interface DetachedFile {
  /** The storage key the removed reference pointed at. */
  key: string;
  /**
   * May the caller destroy the stored object? False while any version row still reads VERIFIED
   * against it — that row is somebody's signature, and it must stay checkable.
   */
  mayDestroy: boolean;
  /** The version rows keeping the object alive, for the audit trail and for the caller's message. */
  retainedBy: Array<{ versionId: string; version: number }>;
  /** Whether the parent row's own verification was withdrawn because its evidence was removed. */
  withdrewVerification: boolean;
}

/** Where the identity gate stands for one person: what is verified, absent, or refused. */
export interface IdentityStanding {
  verified: OnboardingDocument[];
  missing: OnboardingDocument[];
  rejected: OnboardingDocument[];
  ok: boolean;
}

const NUMBER_LIVES_ON_THE_PERSON: Partial<Record<OnboardingDocument, 'panNumber' | 'aadhaarNumber'>> = {
  [OnboardingDocument.PAN_CARD]: 'panNumber',
  [OnboardingDocument.AADHAAR_FRONT]: 'aadhaarNumber',
  [OnboardingDocument.AADHAAR_BACK]: 'aadhaarNumber',
};

@Injectable()
export class RosterRecordsService {
  constructor(
    @InjectRepository(AssayerEntity) private readonly assayers: Repository<AssayerEntity>,
    @InjectRepository(AssayerReferenceEntity) private readonly references: Repository<AssayerReferenceEntity>,
    @InjectRepository(AssayerClientEmpanelmentEntity) private readonly empanelments: Repository<AssayerClientEmpanelmentEntity>,
    @InjectRepository(AssayerBackgroundCheckEntity) private readonly checks: Repository<AssayerBackgroundCheckEntity>,
    @InjectRepository(AssayerDocumentEntity) private readonly onboarding: Repository<AssayerDocumentEntity>,
    @InjectRepository(AssayerImportIssueEntity) private readonly issues: Repository<AssayerImportIssueEntity>,
    /**
     * Needed for exactly one thing: `setEmpanelment` takes a row lock, and a `FOR UPDATE` outside
     * a transaction is released immediately and guards nothing. Every other write in this service
     * is a single statement whose own row lock is enough.
     */
    @InjectDataSource() private readonly dataSource: DataSource,
    @Optional() @InjectRepository(AssayerDocumentVersionEntity) private readonly docVersions?: Repository<AssayerDocumentVersionEntity>,
    // Optional so existing specs that build this service through Nest's DI without an audit
    // collaborator still resolve; DI always supplies the real one. The `?` alone only helps
    // TypeScript — `@Optional()` is what stops Nest throwing when no provider is registered.
    // Every call site guards with `?.`.
    @Optional() private readonly auditService?: AuditService,
    /**
     * Optional for the same reason the audit collaborator is: specs build this service directly,
     * and a document that cannot be announced must still be able to be rejected.
     */
    @Optional() private readonly notifications?: NotificationDispatchService,
    /**
     * Optional like the two above, and read for exactly one thing: whether the identity gate is
     * switched on. See `deploymentVerdict` for why the readiness card must not report identity
     * as a blocker while the gate that would actually refuse an activation is set to warn.
     */
    @Optional() private readonly platformSettings?: PlatformSettingsService,
  ) {}

  /**
   * Assert that an assayer id belongs to the caller's organisation.
   *
   * Every table in this service — references, empanelments, background checks, onboarding
   * documents, document versions, import issues — hangs off `assayer_id` and carries no
   * `organization_id` of its own. `assayers` is the only table in the module that has one, so
   * tenancy for all of them is a question about the parent, asked here.
   *
   * Returns the owner id as well, so a caller that has already loaded the row for its own reasons
   * does not have to load it twice.
   */
  private async assertOwnedAssayer(assayerId: string, notFoundMessage = 'No such assayer.'): Promise<void> {
    if (!tenantFilterId()) return;
    const row = await this.assayers.findOne({
      where: { id: assayerId },
      select: { id: true, organizationId: true },
      withDeleted: true,
    });
    assertTenantOwns(row?.organizationId ?? undefined, notFoundMessage);
  }

  /**
   * The predicate form of {@link assertOwnedAssayer}, for the batch paths.
   *
   * `resolveIssues` reports one outcome per id and never fails as a whole, so a foreign id there
   * has to become a row in the results rather than an exception that abandons the other 499.
   */
  private async ownsAssayer(assayerId: string): Promise<boolean> {
    const organizationId = tenantFilterId();
    if (!organizationId) return true;
    const row = await this.assayers.findOne({
      where: { id: assayerId },
      select: { id: true, organizationId: true },
      withDeleted: true,
    });
    return (row?.organizationId ?? null) === organizationId;
  }

  /**
   * Everything the roster knows about one person beyond their own row, in one round trip.
   *
   * The six reads below are correlated on `assayerId` alone, so this first load is the whole
   * tenant boundary for the dossier: references with named referees and their phone numbers,
   * client empanelments, background-check verdicts and CIBIL bands, the identity-document
   * checklist and every stored version of every scan. `GET /assayers/:assayerId/dossier` served
   * all of it cross-tenant, and so did `GET /assayers/:assayerId/registration-checklist` on the
   * self-service controller, which reaches the same method and does not even inject the region
   * guard.
   */
  async dossier(assayerId: string) {
    const assayer = await this.assayers.findOne({ where: tenantWhere<AssayerEntity>({ id: assayerId }) });
    if (!assayer) throw new NotFoundException('No such assayer.');

    const [references, empanelments, checks, onboarding, openIssues, allVersions] = await Promise.all([
      this.references.find({ where: { assayerId, isActive: true }, order: { createdAt: 'ASC' } }),
      this.empanelments.find({ where: { assayerId, isActive: true }, relations: ['client'], order: { createdAt: 'ASC' } }),
      // Newest first: the current standing is the top row, and the rest is why.
      this.checks.find({ where: { assayerId, isActive: true }, order: { checkedOn: 'DESC', createdAt: 'DESC' } }),
      this.onboarding.find({ where: { assayerId, isActive: true } }),
      this.issues.find({ where: { assayerId, resolvedAt: IsNull() }, order: { createdAt: 'ASC' } }),
      this.docVersions
        ? this.docVersions.find({ where: { assayerId }, order: { version: 'DESC' } })
        : Promise.resolve([] as AssayerDocumentVersionEntity[]),
    ]);

    return {
      references,
      empanelments: empanelments.map((e) => ({
        ...e,
        client: e.client ? { id: e.client.id, name: e.client.name, clientCode: e.client.clientCode } : null,
      })),
      backgroundChecks: checks,
      currentCheck: checks[0] ?? null,
      onboarding: this.paperworkChecklist(onboarding, assayer, allVersions),
      openIssues,
      // Computed from the rows already in hand — see deploymentVerdict for why the answer has to
      // be made here rather than by whoever is drawing the badge.
      ...(await this.deploymentVerdict(assayer, empanelments, onboarding)),
    };
  }

  /**
   * MAY WE ACTUALLY SEND THIS PERSON OUT, AND CAN WE PAY THEM FOR IT?
   *
   * ## The screen this exists to stop lying
   *
   * `DeploymentReadinessCard` has always called itself "(Backend-Authoritative)" and branched on
   * `dossier.deployable` and `dossier.deploymentBlockers`. This endpoint returned neither, so both
   * read `undefined`, the card fell through to its own three-item blocker list (lifecycle, an
   * explicit `unavailableReason`, a missing coordinate) and demoted everything else it knew to a
   * *warning* — and warnings do not touch the verdict. The live consequence, reproduced in the
   * browser: somebody ACTIVE with a coordinate, no bank account, no IFSC, no PAN, no verified
   * identity document and ZERO client empanelments got a green **Deployable** badge, while the
   * planner refused the same person outright with "planning requires an Active or Recommended
   * empanelment standing". Two screens in one product, contradicting each other about one person.
   *
   * The fix is not a richer rulebook in the web app — that is how the four-copies-of-one-gate
   * mess documented all over this module started. The server answers, the card renders.
   *
   * ## Where each blocker comes from, and why it is one
   *
   * Every entry below is traceable to code that actually refuses something. Nothing here is a
   * house rule invented for the badge:
   *
   *  - **Deleted profile** — `DeployabilityFilter.evaluate` returns false on `!isActive` and says
   *    so before it will even consider the onboarding bypass; the candidate-pool query never
   *    selects the row either.
   *  - **Lifecycle** — the pool query and `DeployabilityFilter` both demand `status = ACTIVE`, and
   *    `status` is `operationalStatusFor(lifecycleStatus)` applied in an entity hook, so this is
   *    the lifecycle gate wearing its projection. The same predicate guards accepting an offer
   *    (`AssignmentService.executeAssignmentTransition`) and checking in on the day
   *    (`ASSAYER_NOT_ACTIVE`). ON_LEAVE projects to INACTIVE deliberately — see
   *    `operationalStatusFor`.
   *  - **Left, by date rather than by status** — `stillWorkable` is the rule the money side uses,
   *    and it is stricter than the dispatch gates on purpose: an exit date on a record whose
   *    lifecycle nobody moved is a live case on this roster, and `status` alone still reads ACTIVE
   *    for those people.
   *  - **No plannable empanelment** — `ClientEligibilityFilter` and the in-transaction gate in
   *    `AssignmentService.create` both demand `standingAllowsPlanning`, and
   *    `planning.eligibility.noEmpanelmentRow` ships as BLOCK, so a person with no qualifying
   *    standing with ANY client cannot be dispatched to any of them. That is the per-client gate
   *    projected onto one person, which is the only shape a per-person dossier can carry.
   *  - **Identity** — `IDENTITY_GATE_DOCUMENTS` via the same `identityStanding` the activation
   *    gate consults, and phrased in its words so the two screens ask for the same thing.
   *  - **Home pin** — `latitude` is a critical record field, and the planner's distance pre-filter
   *    drops anybody it cannot place *silently*: no exclusion reason is produced, they are simply
   *    not in the list. A placeholder centroid is worse than nothing, which is what
   *    `isPlaceholderPin` is for.
   *  - **Payout details** — `cannotBePaid`, verbatim. This one does NOT stop a dispatch and the
   *    sentence says so rather than pretending otherwise; it is here because the card's green
   *    state claims the profile "meets all baseline operational and compliance gates", and a
   *    person whose every payable will be held does not meet that claim.
   *
   * ## What is deliberately NOT a blocker
   *
   * The other critical record fields. `ASSAYER_RECORD_FIELDS` says the phone is critical and
   * "never a barrier to admission" in the same breath — the client rosters this system imports
   * arrive with no phone column at all. Joining date and emergency contact are the same kind of
   * gap: real, chased elsewhere, and refused by nothing. Folding them in here would turn the
   * badge red for most of a 1,155-person roster over paperwork no gate reads, which is precisely
   * how a control stops being believed.
   *
   * Weekly workload is not here either, because it is a fact about one week rather than about the
   * person, and it is already on the card as capacity.
   *
   * ## What this says about the live estate, measured rather than guessed
   *
   * Counted against the 1,155 live records the day this shipped:
   *
   *  - **The identity blocker fires for everybody.** Not one of the 11,160 document rows is
   *    verified, and not one has a file behind it, so `identityStanding.ok` is false for all 540
   *    ACTIVE appraisers. `onboarding.identityGate.mode` ships as `warn`, which means the planner
   *    will still dispatch every one of them — so this blocker and the dispatch surface DISAGREE,
   *    deliberately and in the safe direction. It stays unconditional because the green state of
   *    this card claims the profile "meets all baseline operational and compliance gates", and a
   *    person nobody has identified does not meet a compliance gate however permissive the rollout
   *    switch currently is. The sentence is careful never to claim a dispatch would be refused.
   *    What it is really reporting is that the identity queue has never been worked; when it is,
   *    this blocker disappears on its own and the gate can move to Enforce.
   *  - **The empanelment blocker fires for nobody.** All 1,155 records carry at least one ACTIVE
   *    standing. It is here for the case that is coming rather than the case that is: a new joiner
   *    whose vetting has not recorded a standing yet, which is exactly the person the planner
   *    refuses with "record an Active or Recommended standing on the vetting screen".
   *  - Payout details are missing for 55 of the 540, four have an unusable home pin, and nine
   *    carry an explicit unavailability.
   */
  private async deploymentVerdict(
    assayer: AssayerEntity,
    empanelments: AssayerClientEmpanelmentEntity[],
    documents: AssayerDocumentEntity[],
  ): Promise<{ deployable: boolean; deploymentBlockers: string[] }> {
    const blockers: string[] = [];

    /**
     * Sentences, not codes, and lowercase mid-sentence fragments that name the fix — the voice
     * `ONBOARDING_NEXT_STEP` and `STANDING_EXCLUSION_DETAIL` already speak in. A coordinator who
     * reads "no client empanelment on file" on the HR record and then meets the planner's own
     * refusal must recognise the two as the same sentence about the same problem.
     */
    const lifecycle = assayer.lifecycleStatus;

    if (assayer.isActive === false) {
      blockers.push(
        'profile has been deleted from the workforce — restore it on the HR roster before anything '
        + 'can be planned for them',
      );
    }

    if (operationalStatusFor(lifecycle) !== 'ACTIVE') {
      const step = onboardingNextStep(lifecycle);
      if (step) {
        // The planner's exact wording, through the shared map, so the coordinator it sends to
        // this screen finds the identical instruction waiting rather than a paraphrase.
        blockers.push(`onboarding not finished: ${step}`);
      } else if (hasLeftWorkforce(assayer)) {
        blockers.push(
          String(assayer.unavailableReason ?? '').toUpperCase() === 'DECEASED'
            ? 'recorded as deceased — the record is kept for audit history and nothing is ever '
              + 'dispatched or paid against it again'
            : `off the workforce (${assayerLifecycleLabel(lifecycle)}) — a rehire restarts onboarding `
              + 'from Invited on the HR roster; there is no path straight back to Active',
        );
      } else if (lifecycle === AssayerLifecycleStatus.SUSPENDED) {
        blockers.push(
          'suspended — no assignment is offered, accepted or checked in while the suspension '
          + 'stands; lift it on the HR roster',
        );
      } else if (lifecycle === AssayerLifecycleStatus.ON_LEAVE) {
        blockers.push(
          'on leave — leave is not a per-date fact here, it takes them out of the candidate pool '
          + 'entirely; move them back to Active on the HR roster when they return',
        );
      } else if (lifecycle === AssayerLifecycleStatus.INACTIVE) {
        blockers.push(
          'parked as inactive — move them back to Active on the HR roster to return them to the '
          + 'planning pool',
        );
      } else {
        // Unreachable while ONBOARDING_STAGES and the lifecycle enum agree, and kept anyway: a new
        // lifecycle value added without a sentence here must show up as an honest refusal naming
        // the state, not silently pass the gate because no branch matched it.
        blockers.push(
          `not assignable — the planner takes operational status ACTIVE and this record derives `
          + `${operationalStatusFor(lifecycle)} from lifecycle ${lifecycle}`,
        );
      }
    } else if (!stillWorkable(assayer)) {
      /**
       * The mirror-image record: an exit or termination date filed while nobody moved the
       * lifecycle. `status` still reads ACTIVE for these people, so every dispatch gate lets them
       * through — this is the one blocker here that no planning filter would raise on its own,
       * and it is the reason `stillWorkable` rather than the lifecycle alone decides who the
       * money side will chase.
       */
      const left = assayer.exitDate ?? assayer.terminationDate;
      blockers.push(
        `recorded as having left on ${new Date(left as Date).toISOString().slice(0, 10)} while the `
        + `lifecycle still reads ${assayerLifecycleLabel(lifecycle)} — close the record on the HR `
        + 'roster, or clear the leaving date if they never went',
      );
    }

    // Only when the departure sentences above have not already said it: DECEASED is filed as an
    // unavailability, and naming it twice reads as two separate problems.
    if (assayer.unavailableReason && !hasLeftWorkforce(assayer)) {
      blockers.push(
        `marked unavailable (${assayer.unavailableReason}) — clear the unavailability on the HR `
        + 'roster if they are working again',
      );
    }

    /**
     * The per-client gate, asked of every client at once.
     *
     * `standingAllowsPlanning` is narrower than the enum looks: DOCUMENTS_PENDING and INACTIVE are
     * not refusals and still do not qualify, which is exactly the reading a screen inventing its
     * own list gets wrong. Rows are already `is_active = true` here, matching the row the
     * assignment transaction locks with `FOR SHARE`.
     */
    const plannable = empanelments.filter((e) => standingAllowsPlanning(e.status));
    if (plannable.length === 0) {
      if (empanelments.length === 0) {
        blockers.push(
          'no client empanelment on file — record an Active or Recommended standing on the vetting '
          + 'screen; with no standing anywhere the planner has no client it may offer them to',
        );
      } else {
        const held = empanelments
          .slice(0, 3)
          .map((e) => `${e.status} with ${e.client?.clientCode ?? e.client?.name ?? 'a client'}`)
          .join(', ');
        blockers.push(
          `no client empanelment in a plannable standing — ${held} on file, and only Active or `
          + 'Recommended lets the planner offer work; fix it on the vetting screen',
        );
      }
    }

    /**
     * THE IDENTITY ARM ANSWERS TO THE SETTING THAT ACTUALLY REFUSES ACTIVATIONS.
     *
     * Not one of the 11,160 document rows on this deployment is verified, and not one has a file
     * behind it, so `identityStanding.ok` is false for every single ACTIVE appraiser. Reporting
     * that unconditionally would have painted all 540 of them "Blocked from Deployment" on the
     * day this shipped — while the planner went on dispatching them, because no dispatch path
     * consults identity at all. A card that says "blocked" about everybody says nothing about
     * anybody, and the first thing a desk does with a screen like that is stop reading it.
     *
     * `onboarding.identityGate.mode` is the setting that decides whether an unverified identity
     * genuinely stops an activation. It ships as `warn` on purpose — the estate had never
     * operated the check, and enforcing from the first boot would have refused every activation
     * in the company. So while it is `warn` or `off`, an unverified identity is a real gap and it
     * is shown on the card as compliance attention, but it is not a blocker, because nothing
     * blocks on it. Switch the gate to `enforce` and it becomes one here in the same moment it
     * becomes one in `doTransitionLifecycle` — the two now say the same thing, which is the whole
     * point of the card calling itself backend-authoritative.
     */
    const identityGateMode = await this.platformSettings?.get<string>('onboarding.identityGate.mode') ?? 'warn';
    const identity = this.identityStandingFrom(documents);
    if (!identity.ok && identityGateMode === 'enforce') {
      const say = (docs: OnboardingDocument[]) => docs.map((d) => ONBOARDING_DOCUMENT_LABELS[d]).join(' and ');
      const parts: string[] = [];
      if (identity.missing.length > 0) {
        parts.push(`${say(identity.missing)} ${identity.missing.length > 1 ? 'have' : 'has'} not been checked against the original`);
      }
      if (identity.rejected.length > 0) {
        parts.push(`${say(identity.rejected)} ${identity.rejected.length > 1 ? 'were' : 'was'} sent back and ${identity.rejected.length > 1 ? 'have' : 'has'} not been replaced`);
      }
      blockers.push(
        `identity not established — ${parts.join(', and ')}; open their Documents tab, check the `
        + 'scan against what is recorded and mark it verified',
      );
    }

    if (missingAssayerRecordFields(assayer as unknown as Record<string, unknown>).some((f) => f.key === 'latitude')) {
      blockers.push(
        isPlaceholderPin(assayer as unknown as Record<string, unknown>)
          ? 'home pin is a placeholder, not a home — it is a district or state centroid, so every '
            + 'distance the planner measures for them is measured from the wrong place; pin their '
            + 'home on the HR record'
          : 'no home location recorded — the planner\'s distance pre-filter drops anyone it cannot '
            + 'place, silently and with no exclusion reason, so they are never even considered; '
            + 'pin their home on the HR record',
      );
    }

    if (cannotBePaid(assayer as unknown as Record<string, unknown> & AssayerEntity)) {
      const gaps = payoutBlockingGaps(assayer as unknown as Record<string, unknown>).map((f) => f.label);
      blockers.push(
        `payout details incomplete (${gaps.join(', ')}) — the audit can be dispatched, but every `
        + 'payable it earns is held until HR records them on the record',
      );
    }

    return { deployable: blockers.length === 0, deploymentBlockers: blockers };
  }

  /**
   * The paperwork answer for one person, as the checklist it is.
   *
   * A missing row and a row saying "not received" mean the same thing to whoever is chasing it,
   * so every requirement appears whether or not the import found it. Listing only what exists
   * would show a person with nothing on file as having nothing outstanding.
   */
  private paperworkChecklist(
    rows: AssayerDocumentEntity[],
    assayer: AssayerEntity,
    versions: AssayerDocumentVersionEntity[] = [],
  ) {
    const byRequirement = new Map(rows.map((r) => [r.requirement, r]));
    const versionsByRequirement = new Map<string, AssayerDocumentVersionEntity[]>();
    for (const v of versions) {
      const list = versionsByRequirement.get(v.requirement) ?? [];
      list.push(v);
      versionsByRequirement.set(v.requirement, list);
    }

    return Object.keys(ONBOARDING_DOCUMENT_COLUMNS).map((key) => {
      const requirement = key as OnboardingDocument;
      const row = byRequirement.get(requirement);
      const rowVersions = versionsByRequirement.get(requirement) ?? [];
      const currentVerRecord = rowVersions.find((v) => v.id === row?.currentVersionId) ?? rowVersions[0] ?? null;

      return {
        requirement,
        label: ONBOARDING_DOCUMENT_LABELS[requirement],
        // Which half of the list this belongs to. The screen shows a number, an expiry and a
        // verification for identity documents and nothing of the sort for a code-of-conduct
        // letter, and this is what tells it apart.
        identity: isIdentityDocument(requirement),
        id: row?.id ?? null,
        currentVersionId: row?.currentVersionId ?? currentVerRecord?.id ?? null,
        docVersion: (row as any)?.version ?? 1,
        versions: rowVersions.map((v) => ({
          id: v.id,
          version: v.version,
          filePath: v.filePath,
          fileChecksum: v.fileChecksum ?? null,
          contentSha256: v.contentSha256 ?? null,
          storageObjectId: v.storageObjectId ?? null,
          fileSize: v.fileSize ? Number(v.fileSize) : null,
          mimeType: v.mimeType ?? null,
          uploadedAt: v.uploadedAt,
          uploadedBy: v.uploadedBy ?? null,
          verificationStatus: v.verificationStatus,
          verifiedAt: v.verifiedAt ?? null,
          verifiedBy: v.verifiedBy ?? null,
          rejectionReason: v.rejectionReason ?? null,
          supersededByVersionId: v.supersededByVersionId ?? null,
          supersededAt: v.supersededAt ?? null,
        })),
        softCopyReceived: row?.softCopyReceived ?? null,
        hardCopyReceived: row?.hardCopyReceived ?? null,
        hardCopyLocation: row?.hardCopyLocation ?? null,
        courierReference: row?.courierReference ?? null,
        receivedAt: row?.receivedAt ?? null,
        // Read back from the person where that is where it lives — see
        // NUMBER_LIVES_ON_THE_PERSON. One value, two places to see it, no way for them to differ.
        // Masked on the way out, wherever it lives. The dossier is the screen a clerk works the
        // paperwork from, and it needs the last four digits to tell one card from another —
        // never the whole number, which is what `GET /assayers/:id/sensitive/:field` is for and
        // records a reader for. A number that is absent stays null: "no PAN on file" is the
        // thing the checklist exists to show, and a row of stars would hide it.
        documentNumber: maskTail(
          NUMBER_LIVES_ON_THE_PERSON[requirement]
            ? (assayer[NUMBER_LIVES_ON_THE_PERSON[requirement]!] ?? null)
            : (row?.documentNumber ?? null),
        ) || null,
        expiryDate: row?.expiryDate ?? null,
        verificationStatus: row?.verificationStatus ?? null,
        verifiedAt: row?.verifiedAt ?? null,
        /**
         * What the card says, unmasked, unlike the number above.
         *
         * The number is masked because the screen only needs enough of it to tell one card from
         * another, and the whole value has its own audited route. A name is not that kind of
         * secret — it is the thing the reviewer is comparing, so showing four characters of it
         * would defeat the entire purpose of having written it down.
         */
        holderName: row?.holderName ?? null,
        holderDateOfBirth: row?.holderDateOfBirth ?? null,
        holderGender: row?.holderGender ?? null,
        holderGuardianName: row?.holderGuardianName ?? null,
        holderAddress: row?.holderAddress ?? null,
        /** Which fields this card prints, so the form asks for those and no others. */
        prints: DOCUMENT_PRINTED_FIELDS[requirement] ?? null,
        nameMatchGrade: row?.nameMatchGrade ?? null,
        nameMatchNote: row?.nameMatchNote ?? null,
        rejectionReason: row?.rejectionReason ?? null,
        filePaths: row?.filePaths ?? [],
        remarks: row?.remarks ?? null,
      };
    });
  }

  // ── References ────────────────────────────────────────────────────────

  async saveReference(
    assayerId: string,
    dto: Partial<AssayerReferenceEntity> & { fullName: string },
    actorId: string,
    id?: string,
  ) {
    // The route is `POST|PUT /assayers/:assayerId/reference[/:id]`, so `assayerId` comes off the
    // URL and, until this line, was written to without anyone asking whose it was.
    await this.assertOwnedAssayer(assayerId);
    const row = id
      ? await this.references.findOne({ where: { id, assayerId } })
      : this.references.create({ assayerId });
    if (!row) throw new NotFoundException('No such reference.');

    Object.assign(row, {
      fullName: dto.fullName?.trim(),
      phone: dto.phone ?? row.phone ?? null,
      relationship: dto.relationship ?? row.relationship ?? null,
      remarks: dto.remarks ?? row.remarks ?? null,
      updatedBy: actorId,
    });
    if (!row.fullName) throw new BadRequestException('A reference needs a name.');
    if (!id) row.createdBy = actorId;
    return this.references.save(row);
  }

  /** Marking a reference checked is who-and-when, not a free field, so it is its own action. */
  async markReferenceChecked(id: string, actorId: string, remarks?: string) {
    const row = await this.references.findOne({ where: { id } });
    if (!row) throw new NotFoundException('No such reference.');
    // `POST /assayers/reference/:id/checked` names the reference, never the person — no assayer id
    // reaches the controller, so no guard upstream could have looked at one. Same message as the
    // miss above, so "not yours" and "no such row" are the same answer.
    await this.assertOwnedAssayer(row.assayerId, 'No such reference.');
    row.checkedAt = new Date();
    row.checkedBy = actorId;
    if (remarks) row.remarks = remarks;
    row.updatedBy = actorId;
    return this.references.save(row);
  }

  async removeReference(id: string, actorId: string) {
    const row = await this.references.findOne({ where: { id } });
    if (!row) throw new NotFoundException('No such reference.');
    await this.assertOwnedAssayer(row.assayerId, 'No such reference.');
    row.isActive = false;
    row.updatedBy = actorId;
    await this.references.save(row);
  }

  // ── Client standing ───────────────────────────────────────────────────

  /**
   * Record where one assayer stands with one client.
   *
   * ## Why this is a locked transaction rather than a read and a save
   *
   * Three concurrent calls carrying three different standings all answered **200** and the row
   * kept one of them. The version went 1 → 4 across those three calls, so the collision was
   * recorded in the row and nobody looked; the two desks whose decision was discarded were told
   * it had saved. This standing gates assignment eligibility, so the discarded decision can be a
   * REJECTED overwritten by a concurrent RECOMMENDED — and the person becomes deployable to a
   * client who declined them, with an `EMPANELMENT_SET` audit row presenting it as deliberate.
   *
   * The lock is taken BEFORE anything is read, and every decision below — the version check, the
   * reversal guard, the previous status that reaches the audit row — is answered from what came
   * back under it. See `empanelment-version.ts`, and `client/pricing-version.ts` for the same
   * mechanism on the client billing row, which is where this one is taken from.
   *
   * The response is re-read from the database on the transaction's own connection, because the
   * invariant is that **the HTTP result corresponds to the persisted value**. An in-memory entity
   * handed back from `save` is the caller's own hope, not the row.
   */
  async setEmpanelment(
    assayerId: string,
    clientId: string,
    dto: { status: EmpanelmentStatus; statusReason?: string; documentsOutstanding?: string;
           clientReferenceCode?: string; decidedAt?: string; remarks?: string;
           expectedVersion?: number },
    actorId: string,
  ) {
    // Before the upsert, not after: this writes whether a bank will send someone work, and an
    // unscoped `assayerId` here empanels or blacklists another organisation's assayer against a
    // client — with an `EMPANELMENT_SET` audit row recording it as a legitimate decision.
    await this.assertOwnedAssayer(assayerId);

    const { saved, previousStatus } = await this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(AssayerClientEmpanelmentEntity);
      // Lock FIRST, read after. Anything else leaves a window in which the row below is already
      // stale and `save` writes straight over the winner — see `empanelment-version.ts`.
      const locked = await lockEmpanelmentRow(m, assayerId, clientId);

      /**
       * Undoing a client's rejection has to be said out loud.
       *
       * `EmpanelmentStatus` has no state machine and deliberately keeps none: the business decided
       * (2026-09-10) that a rejection stays reversible, because a client changing its mind is an
       * ordinary thing and making it terminal would push the correction into a database edit where
       * nobody would see it at all. What it must not be is silent. Every other standing change is a
       * routine update and stays one; moving *away* from REJECTED is the one transition that
       * overturns somebody else's decision, so it carries a reason into the `EMPANELMENT_SET` audit
       * row beside the actor and the previous value.
       *
       * Answered from `locked.status` — the committed value — rather than from an unlocked read.
       * A guard decided against a copy taken before a concurrent REJECTED committed would let the
       * reason-less reversal through over the top of it, which is the defect in miniature.
       *
       * The assignment layer is unaffected either way — `REJECTED` is a strictly non-overridable
       * standing there, so no work can reach the field through this route regardless.
       */
      const guardReversal = (from: EmpanelmentStatus) => {
        if (from === EmpanelmentStatus.REJECTED && dto.status !== EmpanelmentStatus.REJECTED
            && !dto.statusReason?.trim()) {
          throw new BadRequestException(
            `Say why this client's rejection is being reversed. Moving from REJECTED to ${dto.status} `
            + 'overturns a decision the client made, and the reason is recorded against whoever made it.',
          );
        }
      };

      if (!locked) {
        // The create half. There is no earlier decision to be stale about, so no version is
        // demanded — but two callers can still arrive here at once, and the unique constraint
        // lets one of them through. The loser used to get a 500.
        const fresh = repo.create({
          assayerId,
          clientId,
          status: dto.status,
          statusReason: dto.statusReason ?? null,
          documentsOutstanding: dto.documentsOutstanding ?? null,
          clientReferenceCode: dto.clientReferenceCode ?? null,
          decidedAt: dto.decidedAt ? new Date(dto.decidedAt) : new Date(),
          remarks: dto.remarks ?? null,
          isActive: true,
          createdBy: actorId,
          updatedBy: actorId,
        });
        const inserted = await repo.save(fresh).catch(translateConcurrentEmpanelmentCreate);
        return {
          saved: await repo.findOneOrFail({ where: { id: inserted.id } }),
          previousStatus: null as EmpanelmentStatus | null,
        };
      }

      // Version before reversal: a writer who did not see the current standing is stale first and
      // foremost, and telling it to justify a reversal it never knew about would be the wrong
      // sentence. It reloads, sees REJECTED, and is then asked for the reason.
      assertEmpanelmentVersion(locked, dto.expectedVersion);
      guardReversal(locked.status);

      const row = await repo.findOneOrFail({ where: { id: locked.id } });
      row.status = dto.status;
      row.statusReason = dto.statusReason ?? null;
      row.documentsOutstanding = dto.documentsOutstanding ?? null;
      row.clientReferenceCode = dto.clientReferenceCode ?? row.clientReferenceCode ?? null;
      row.decidedAt = dto.decidedAt ? new Date(dto.decidedAt) : new Date();
      row.remarks = dto.remarks ?? null;
      row.isActive = true;
      row.updatedBy = actorId;
      await repo.save(row);
      // The committed row, not the in-memory copy: the response has to be the persisted value.
      return {
        saved: await repo.findOneOrFail({ where: { id: locked.id } }),
        previousStatus: locked.status as EmpanelmentStatus | null,
      };
    });

    // Whether this bank will send someone work is a decision, and "who set this and when" has
    // to be answerable the same way a lifecycle move is — there was previously no trail at all.
    await this.auditService?.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'EMPANELMENT_SET',
      entityType: 'ASSAYER',
      entityId: assayerId,
      previousState: previousStatus ?? undefined,
      newState: saved.status,
      userId: actorId,
      remarks: `Client empanelment set to ${saved.status}${dto.statusReason ? `: ${dto.statusReason}` : ''}`,
      // `version` rides along so the trail says which committed revision this decision became.
      // A run of EMPANELMENT_SET rows with no version cannot be told apart from a lost update
      // after the fact, which is how this went unnoticed for as long as it did.
      metadata: {
        clientId,
        previousValue: { status: previousStatus },
        newValue: { status: saved.status, statusReason: saved.statusReason, version: saved.version },
      },
    });
    return saved;
  }

  async removeEmpanelment(id: string, actorId: string) {
    const row = await this.empanelments.findOne({ where: { id } });
    if (!row) throw new NotFoundException('No such standing.');
    // Keyed by the standing, not the person — see `markReferenceChecked`.
    await this.assertOwnedAssayer(row.assayerId, 'No such standing.');
    const previousStatus = row.status;
    row.isActive = false;
    row.updatedBy = actorId;
    await this.empanelments.save(row);
    await this.auditService?.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'EMPANELMENT_WITHDRAWN',
      entityType: 'ASSAYER',
      entityId: row.assayerId,
      previousState: previousStatus,
      userId: actorId,
      remarks: `Client empanelment withdrawn (was ${previousStatus})`,
      metadata: { clientId: row.clientId, previousValue: { status: previousStatus, isActive: true }, newValue: { isActive: false } },
    });
  }

  // ── Background and credit checks ──────────────────────────────────────

  async recordBackgroundCheck(
    assayerId: string,
    dto: { verdict: BackgroundCheckVerdict; riskGrade?: RiskGrade; cibilScore?: number;
           cibilBand?: CibilBand; checkedOn?: string; checkedByName?: string; findings?: string },
    actorId: string,
  ) {
    await this.assertOwnedAssayer(assayerId);
    // Always a new row. Overwriting the last check would lose the fact that the picture changed,
    // which is the only reason to look at a second one.
    const row = this.checks.create({
      assayerId,
      verdict: dto.verdict,
      riskGrade: dto.riskGrade ?? null,
      cibilScore: dto.cibilScore ?? null,
      cibilBand: dto.cibilBand ?? null,
      checkedOn: dto.checkedOn ? new Date(dto.checkedOn) : new Date(),
      checkedByName: dto.checkedByName ?? null,
      findings: dto.findings ?? null,
      createdBy: actorId,
      updatedBy: actorId,
    });
    const saved = await this.checks.save(row);
    // A background/credit check is the grounds for admitting someone to a bank vault, and it had
    // no trail at all — only the row itself, with no record of who recorded it.
    await this.auditService?.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'BACKGROUND_CHECK_RECORDED',
      entityType: 'ASSAYER',
      entityId: assayerId,
      newState: saved.verdict,
      userId: actorId,
      remarks: `Background check recorded: ${saved.verdict}${saved.riskGrade ? ` (${saved.riskGrade})` : ''}`,
      metadata: { newValue: { verdict: saved.verdict, riskGrade: saved.riskGrade, cibilBand: saved.cibilBand, cibilScore: saved.cibilScore } },
    });
    return saved;
  }

  // ── Onboarding paperwork ──────────────────────────────────────────────

  /**
   * Is this a requirement the checklist knows?
   *
   * Membership, NOT truthiness. `ONBOARDING_DOCUMENT_COLUMNS` maps each requirement to the
   * spreadsheet column it was read from, and three of them — driving licence, voter ID, passport —
   * map to `''` because the roster file has no column for them; they came from the identity
   * register. `setDocument` tested the mapped VALUE, so those three read as unknown and every
   * `PUT` against them was refused. A clerk could upload a passport scan through `attachFile`,
   * which accepted it, and then record nothing whatsoever about the document they had just filed.
   *
   * `attachFile` had the opposite fault: no check at all, so any string at all created a document
   * row. That is how a typo or a renamed enum value grows a parallel set of rows that no
   * checklist counts and no queue ever shows. Both go through this now.
   */
  private assertKnownRequirement(requirement: OnboardingDocument): void {
    if (!Object.prototype.hasOwnProperty.call(ONBOARDING_DOCUMENT_COLUMNS, requirement)) {
      throw withCode(
        new BadRequestException(`"${requirement}" is not a paperwork requirement this system knows.`),
        ASSAYER_ERROR_CODES.DOCUMENT_REQUIREMENT_UNKNOWN,
      );
    }
  }

  async setDocument(
    assayerId: string,
    requirement: OnboardingDocument,
    dto: { softCopyReceived?: boolean | null; hardCopyReceived?: boolean | null;
           hardCopyLocation?: string; courierReference?: string; receivedAt?: string; remarks?: string;
           documentNumber?: string; expiryDate?: string | null },
    actorId: string,
  ) {
    let withdrewVerification = false;
    this.assertKnownRequirement(requirement);
    // For three requirements this writes THROUGH to `assayers.pan_number` / `aadhaar_number` (see
    // NUMBER_LIVES_ON_THE_PERSON below), so an unscoped `assayerId` off the URL here does not just
    // add a paperwork row — it rewrites another organisation's identity numbers on the person.
    await this.assertOwnedAssayer(assayerId);
    const existing = await this.onboarding.findOne({ where: { assayerId, requirement } });
    const row = existing ?? this.onboarding.create({ assayerId, requirement, createdBy: actorId });

    if (dto.softCopyReceived !== undefined) row.softCopyReceived = dto.softCopyReceived;
    if (dto.hardCopyReceived !== undefined) row.hardCopyReceived = dto.hardCopyReceived;
    if (dto.hardCopyLocation !== undefined) row.hardCopyLocation = dto.hardCopyLocation || null;
    if (dto.courierReference !== undefined) row.courierReference = dto.courierReference || null;
    if (dto.receivedAt !== undefined) row.receivedAt = dto.receivedAt ? new Date(dto.receivedAt) : null;
    if (dto.remarks !== undefined) row.remarks = dto.remarks || null;

    // A number and an expiry belong to an identity document and to nothing else. Accepting them
    // on a joining form would put a field on screen that can never be filled in correctly.
    // The document screen reads its number from `dossier()`, which now masks it, so the same
    // round trip the profile form has is open here — and this one writes THROUGH to
    // `assayers.pan_number` for the three requirements in NUMBER_LIVES_ON_THE_PERSON. Saving the
    // asterisks would replace the person's real PAN from the paperwork screen, one step further
    // from anywhere anybody would think to look for it. Same rule and same way out as
    // `assertNoMaskedPii` in AssayerService.
    if (typeof dto.documentNumber === 'string' && looksMasked(dto.documentNumber)) {
      throw withCode(
        new BadRequestException(
          'The document number you sent is the masked version shown on screen, not the real number, '
          + 'and saving it would overwrite the real one. Reveal the field first, then edit it.',
        ),
        ASSAYER_ERROR_CODES.MASKED_VALUE_REJECTED,
      );
    }

    if (dto.documentNumber !== undefined || dto.expiryDate !== undefined) {
      if (!isIdentityDocument(requirement)) {
        throw new BadRequestException(
          `${ONBOARDING_DOCUMENT_LABELS[requirement]} is not an identity document, so it carries `
          + 'no number or expiry date.',
        );
      }
      const column = NUMBER_LIVES_ON_THE_PERSON[requirement];
      if (dto.documentNumber !== undefined) {
        /**
         * The same format rule the create and update DTOs apply, enforced here because only this
         * layer knows which document is being recorded.
         *
         * `@IsPanFormat()` and `@IsAadhaarNumber()` sit on the assayer DTOs, but which of them
         * applies depends on the `:requirement` route parameter, which class-validator cannot
         * see — so this route reached `assayers.pan_number` and `assayers.aadhaar_number` with no
         * format check at all while its two siblings refused a malformed value. The point of
         * `@fapoms/shared/identity-validation` is that every path to these columns asks the same
         * question; this was the path that did not.
         *
         * Verhoeff matters here rather than being pedantry: a mistyped Aadhaar that passes
         * `\d{12}` is indistinguishable from a real one later, and this number is what a human is
         * meant to check the scan against.
         */
        const shaped = (dto.documentNumber ?? '').trim().toUpperCase();
        if (shaped) {
          if (column === 'panNumber' && !isValidPan(shaped)) {
            throw withCode(
              new BadRequestException(
                'That is not a valid PAN. It should be ten characters, like ABCDE1234F.',
              ),
              ASSAYER_ERROR_CODES.DOCUMENT_NUMBER_INVALID,
            );
          }
          if (column === 'aadhaarNumber' && !isValidAadhaar(shaped)) {
            throw withCode(
              new BadRequestException(
                isPlaceholderAadhaar(shaped)
                  ? 'That Aadhaar number is a placeholder, not a real one. Leave it blank rather '
                    + 'than recording a stand-in.'
                  : 'That is not a valid Aadhaar number. It should be twelve digits, and the check '
                    + 'digit did not match — please re-read it from the document.',
              ),
              ASSAYER_ERROR_CODES.DOCUMENT_NUMBER_INVALID,
            );
          }
        }
        if (column) {
          const person = await this.assayers.findOne({ where: { id: assayerId } });
          if (person) {
            person[column] = dto.documentNumber || null;
            person.updatedBy = actorId;
            await this.assayers.save(person);
          }
        } else {
          row.documentNumber = dto.documentNumber || null;
        }
      }
      if (dto.expiryDate !== undefined) row.expiryDate = dto.expiryDate ? new Date(dto.expiryDate) : null;
      // Changing what the document says undoes any verification of it: somebody checked the old
      // number against the original, and that is no longer the number on the record.
      withdrewVerification = this.undoVerification(row, 'the document details changed');
    }

    row.isActive = true;
    row.updatedBy = actorId;
    const saved = await this.onboarding.save(row);
    // Only when something was actually withdrawn: the name of record follows the verifications, so
    // an ordinary clerical edit has no bearing on it and should not pay for a re-derivation.
    if (withdrewVerification) await this.deriveLegalName(assayerId, actorId);
    return saved;
  }

  /**
   * Attach a scan to a document, and say the copy arrived.
   *
   * The record could say a soft copy had been received and hold nothing to show for it, which is
   * the difference between a filing system and a note about one. An audit asks to see the
   * document, not to be told somebody once saw it.
   *
   * Recording the file also sets `softCopyReceived`, because a scan on the record *is* the soft
   * copy: leaving a clerk to tick a box next to a file they just uploaded is asking them to
   * state something the system can see for itself.
   */
  async attachFile(
    assayerId: string,
    requirement: OnboardingDocument,
    key: string,
    actorId: string,
    metadata?: {
      checksum?: string;
      contentSha256?: string;
      storageObjectId?: string;
      fileSize?: number;
      mimeType?: string;
    },
  ) {
    this.assertKnownRequirement(requirement);
    // `attachFile` writes a scan against a person and, for PHOTOGRAPH, writes through to
    // `assayers.photograph` further down — a mutation of the parent row keyed on nothing but the
    // `assayerId` off the URL.
    await this.assertOwnedAssayer(assayerId);
    const existing = await this.onboarding.findOne({ where: { assayerId, requirement } });
    let row = existing ?? this.onboarding.create({ assayerId, requirement, createdBy: actorId, filePaths: [] });
    if (!row.id) {
      row = await this.onboarding.save(row);
    }

    // Determine next version number for this document
    let nextVersion = 1;
    if (this.docVersions && row.id) {
      const latest = await this.docVersions.findOne({
        where: { documentId: row.id },
        order: { version: 'DESC' },
      });
      if (latest) {
        nextVersion = latest.version + 1;
      }
    }

    let newVersionRecord: AssayerDocumentVersionEntity | null = null;
    if (this.docVersions && row.id) {
      const sha256 = metadata?.contentSha256 ?? metadata?.checksum ?? null;
      newVersionRecord = this.docVersions.create({
        documentId: row.id,
        assayerId,
        requirement,
        version: nextVersion,
        filePath: key,
        fileChecksum: sha256,
        contentSha256: sha256,
        storageObjectId: metadata?.storageObjectId ?? key,
        fileSize: metadata?.fileSize ?? null,
        mimeType: metadata?.mimeType ?? null,
        uploadedBy: actorId,
        verificationStatus: DocumentVerification.PENDING,
        verifiedAt: null,
        verifiedBy: null,
        rejectionReason: null,
        supersededByVersionId: null,
        supersededAt: null,
      });
      newVersionRecord = await this.docVersions.save(newVersionRecord);

      // If there was a previous version, link supersession relationship
      if (row.currentVersionId) {
        await this.docVersions.update(
          { id: row.currentVersionId },
          {
            supersededByVersionId: newVersionRecord.id,
            supersededAt: new Date(),
          },
        );
      }
      row.currentVersionId = newVersionRecord.id;
    }

    /**
     * A photograph is replaced; a document accumulates.
     *
     * Every other requirement keeps its history — an earlier Aadhaar scan is evidence of what was
     * checked and when, and a re-upload is a second page or a better picture of the same card. A
     * face is not evidence of anything except what somebody looked like, and appending would grow
     * the array without bound every time a person retakes their photo while
     * `assayers.photograph` silently followed the last one anyway.
     */
    row.filePaths = requirement === OnboardingDocument.PHOTOGRAPH
      ? [key]
      : [...(row.filePaths ?? []), key];
    if (row.softCopyReceived !== true) row.softCopyReceived = true;

    /**
     * A new scan on a verified document undoes the verification on the active row.
     *
     * The previous version (v1) retains its historical verification record in
     * `assayer_document_versions`, while the current state becomes v2 pending review.
     * v2 does NOT implicitly inherit v1 approval.
     */
    const withdrawn = this.undoVerification(row, 'a new scan was uploaded');
    // A rejection is answered by the new scan, so it stops being the current state of this row.
    if (row.verificationStatus === DocumentVerification.REJECTED) {
      row.verificationStatus = DocumentVerification.PENDING;
      row.rejectionReason = null;
    }
    row.isActive = true;
    row.updatedBy = actorId;
    const saved = await this.onboarding.save(row);

    /**
     * A photograph is also a fact about the person, not only a document in their file.
     *
     * `assayers.photograph` is what a header or a list can show without loading the whole
     * dossier, so the most recent one is copied there — the same arrangement as a PAN number,
     * which lives on the person while the card that evidences it lives here. Copied rather than
     * duplicated: this is the only writer, and the document record stays the history.
     */
    if (requirement === OnboardingDocument.PHOTOGRAPH) {
      await this.assayers.update({ id: assayerId }, { photograph: key, updatedBy: actorId });
    }

    if (withdrawn) await this.deriveLegalName(assayerId, actorId);

    /**
     * Recording that a scan arrived left no trail at all, unlike verifying it.
     *
     * Only for the documents that establish who somebody is — writing an audit row for each of the
     * twelve clerical requirements would add eleven thousand entries of "the NDA arrived" and teach
     * every reader to scroll past the trail.
     */
    if (isIdentityDocument(requirement) || requirement === OnboardingDocument.PHOTOGRAPH) {
      await this.auditService?.recordEventSafe({
        category: EventCategory.OPERATIONAL,
        eventType: 'IDENTITY_DOCUMENT_FILE_ATTACHED',
        entityType: 'ASSAYER',
        entityId: assayerId,
        userId: actorId,
        remarks: `A scan of ${ONBOARDING_DOCUMENT_LABELS[requirement]} (v${nextVersion}) was uploaded.`,
        // The key, never the image, and never the number the image shows.
        metadata: {
          requirement,
          version: nextVersion,
          versionId: newVersionRecord?.id ?? null,
          fileCount: row.filePaths.length,
          withdrewVerification: withdrawn,
        },
      });
    }
    return saved;
  }

  /** The stored key at one position, or null — the caller decides what a miss means. */
  async fileKey(documentId: string, index: number): Promise<{ key: string; requirement: string } | null> {
    const row = await this.onboarding.findOne({ where: { id: documentId } });
    /**
     * `GET /assayers/document/:id/file/:index` is keyed on the document row, takes no
     * `@GlobalScopeFilter`, calls no guard and carries no `@AuditRead` — and what it returns is a
     * storage key the controller immediately streams: the Aadhaar or PAN scan itself. So this is
     * the ownership check for the identity-document download path, and there is nowhere else it
     * could go.
     *
     * Returns null rather than throwing when the row is not the caller's, because the controller
     * already turns a null into the 404 it returns for a document that does not exist — the same
     * answer for both, which is the point.
     */
    if (!row) return null;
    if (tenantFilterId()) {
      const owner = await this.assayers.findOne({
        where: { id: row.assayerId },
        select: { id: true, organizationId: true },
        withDeleted: true,
      });
      if ((owner?.organizationId ?? null) !== tenantFilterId()) return null;
    }
    const key = row?.filePaths?.[index];
    return key ? { key, requirement: row!.requirement } : null;
  }

  /**
   * The object one VERSION cites, whether or not it is still attached to the record.
   *
   * Retaining evidence that nobody can fetch is not retaining evidence. Once a scan is detached
   * from `file_paths`, `fileKey` above can no longer reach it — the index it was at is gone — so
   * the object kept alive by a VERIFIED version row would be unreachable through the API, and the
   * verification would be as unauditable as if the object had actually been deleted. This is the
   * way back to it: address the evidence by the attestation that depends on it.
   *
   * Same ownership check and the same null-for-everything as `fileKey`, for the same reason — a
   * foreign document id and a nonexistent one must be indistinguishable from outside.
   */
  async versionFileKey(
    documentId: string,
    versionId: string,
  ): Promise<{ key: string; requirement: string; version: number } | null> {
    if (!this.docVersions) return null;
    const row = await this.onboarding.findOne({ where: { id: documentId } });
    if (!row) return null;
    if (tenantFilterId()) {
      const owner = await this.assayers.findOne({
        where: { id: row.assayerId },
        select: { id: true, organizationId: true },
        withDeleted: true,
      });
      if ((owner?.organizationId ?? null) !== tenantFilterId()) return null;
    }
    const version = await this.docVersions.findOne({ where: { id: versionId, documentId } });
    if (!version?.filePath) return null;
    // The object really was destroyed — before this rule existed, or because nothing attested to
    // it. Saying so is honest; streaming a 500 out of the storage engine is not.
    if (version.evidenceReleasedAt) return null;
    return { key: version.filePath, requirement: row.requirement, version: version.version };
  }

  /**
   * Detach a scan — and say whether the stored object behind it may be destroyed.
   *
   * The reference always goes: somebody removing a bad scan is an editorial act on the CURRENT
   * record and must keep working. It does *not* clear `softCopyReceived`, because the document
   * may genuinely have arrived, and quietly retracting that is a second decision nobody made.
   *
   * What changed is the second half. The stored object is destroyed by the caller, which owns the
   * storage engine, and the caller used to destroy it unconditionally — because `file_paths` was
   * treated as the object's only reference. It is not. Every upload also writes an
   * `assayer_document_versions` row carrying its own `file_path`, and a version reading VERIFIED
   * is a person's signature saying they held that scan beside the original. Detaching the
   * reference and destroying the object left that signature pointing at nothing: certification
   * reproduced exactly that, a VERIFIED v1 citing a PAN scan no longer in the bucket.
   *
   * So the rule, and this method is its one home: **an object is destroyed only when nothing
   * still attests to it.** Detach or retire freely; the evidence under a verification stays.
   *
   * Refusing the detach outright was the other candidate and is worse. It conflates the record's
   * current state with its history — the two things this data model deliberately keeps in
   * separate tables — and would make an illegible scan permanently unremovable from a live
   * record. It also fixes only half the problem: see `undoVerification` below, which closes the
   * other half.
   */
  async detachFile(documentId: string, index: number, actorId: string): Promise<DetachedFile | null> {
    const row = await this.onboarding.findOne({ where: { id: documentId } });
    if (!row) throw new NotFoundException('No such document.');
    // Keyed by the document, like `fileKey` — and this one goes on to delete the stored object and
    // rewrite `assayers.photograph`, so it is a cross-tenant destroy, not just a read.
    await this.assertOwnedAssayer(row.assayerId, 'No such document.');
    const key = row.filePaths?.[index];
    if (!key) return null;

    /**
     * Every version row that points at this same object.
     *
     * Matched on `filePath` OR `storageObjectId`, because both columns hold a key and
     * `attachFile` writes the second from `metadata.storageObjectId` — which a future storage
     * engine could legitimately make differ from the path. Missing a reference here is how the
     * object gets destroyed anyway, so the match is deliberately generous.
     */
    const versions = this.docVersions
      ? await this.docVersions.find({ where: { documentId: row.id } })
      : [];
    const citing = versions.filter((v) => v.filePath === key || v.storageObjectId === key);
    const retainedBy = citing.filter((v) => v.verificationStatus === DocumentVerification.VERIFIED);
    const mayDestroy = retainedBy.length === 0;

    /**
     * Did the parent row's own verification rest on the scan being removed?
     *
     * `verifyDocument` refuses to mark a document VERIFIED while `file_paths` is empty — "there
     * is nothing to have checked against the original". Detaching used to walk straight past that
     * rule: remove the only scan from a VERIFIED PAN row and it stayed VERIFIED with
     * `file_paths = []`, a state the verification path itself will not create. Same fix as
     * everywhere else the grounds for a verification move — the one `undoVerification` — rather
     * than a second opinion written here.
     *
     * The version row is NOT touched: it is the history, and `attachFile` already says in as many
     * words that a superseded version keeps its historical verification. Withdrawing that would
     * erase the attestation this whole method exists to protect.
     */
    const remaining = row.filePaths.filter((_, i) => i !== index);
    const currentVersion = versions.find((v) => v.id === row.currentVersionId) ?? null;
    const wasTheEvidence = currentVersion
      ? (currentVersion.filePath === key || currentVersion.storageObjectId === key)
      : remaining.length === 0;
    const withdrew = (wasTheEvidence || remaining.length === 0)
      ? this.undoVerification(row, 'the scan it was checked against was removed')
      : false;

    row.filePaths = remaining;
    row.updatedBy = actorId;
    await this.onboarding.save(row);

    /**
     * Record the release BEFORE the object is destroyed, never after.
     *
     * A crash between the two then leaves an unreferenced object in the bucket, which costs
     * storage and nothing else. The other order leaves a row citing an object that is gone, which
     * is the defect. The database refuses this write on a VERIFIED row (see the
     * VerifiedDocumentEvidenceRetention migration), so the rule above holds even against a caller
     * that has not read it.
     */
    if (mayDestroy && this.docVersions && citing.length > 0) {
      await this.docVersions.update(
        { id: In(citing.map((v) => v.id)) },
        { evidenceReleasedAt: new Date() },
      );
    }

    // The header must not go on pointing at a file that is gone. Falls back to whatever else is
    // still attached rather than blanking a record that still has a photograph in it.
    if (row.requirement === OnboardingDocument.PHOTOGRAPH) {
      await this.assayers.update(
        { id: row.assayerId },
        { photograph: row.filePaths[row.filePaths.length - 1] ?? null, updatedBy: actorId },
      );
    }
    // The name of record follows the verifications, so withdrawing one has to re-derive it.
    if (withdrew) await this.deriveLegalName(row.assayerId, actorId);
    /**
     * Removing a scan is audited, because attaching one is.
     *
     * `attachFile` writes `IDENTITY_DOCUMENT_FILE_ATTACHED`; this method wrote nothing at all,
     * while doing strictly more damage — it rewrites `file_paths`, can rewrite
     * `assayers.photograph`, and the caller then deletes the object from storage. Certification
     * detached a scan that a VERIFIED version row still pointed at: the row went on asserting
     * somebody had checked that PAN card against its original, the object was gone, and the
     * eleven audit events on that assayer said nothing about it.
     *
     * The trail now also says which of the two things happened — destroyed, or kept because a
     * verification still cites it — because a bucket holding objects nothing references is only
     * explicable if the reason is written down somewhere.
     *
     * `recordEventSafe`, not `recordEvent`: the rows above are already saved and not inside a
     * transaction with this call, so a failing audit write must not turn a completed detach into
     * a 500 that tells the caller nothing happened.
     */
    await this.auditService?.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'IDENTITY_DOCUMENT_FILE_DETACHED',
      entityType: 'ASSAYER',
      entityId: row.assayerId,
      userId: actorId,
      remarks: mayDestroy
        ? `Removed a ${row.requirement} scan. Nothing attests to it, so the stored object is deleted.`
        : `Removed a ${row.requirement} scan from the record. The stored object is KEPT: `
          + `${retainedBy.length} verified version row(s) still cite it as the evidence that was `
          + 'checked against the original.',
      metadata: {
        requirement: row.requirement,
        documentId: row.id,
        removedObjectKey: key,
        remainingFileCount: row.filePaths.length,
        currentVersionId: row.currentVersionId ?? null,
        objectDestroyed: mayDestroy,
        retainedByVersionIds: retainedBy.map((v) => v.id),
        withdrewVerification: withdrew,
      },
    });

    return {
      key,
      mayDestroy,
      retainedBy: retainedBy.map((v) => ({ versionId: v.id, version: v.version })),
      withdrewVerification: withdrew,
    };
  }

  /**
   * Record that somebody checked an identity document against the original.
   *
   * Only identity documents are verified. The rest of the list is paperwork that either arrived
   * or did not, and a code-of-conduct letter reading "Pending verification" for ever is an alarm
   * nobody can clear — which is why the register this replaced had every row start there.
   */
  /**
   * What a reviewer is attesting to, beyond the verdict itself.
   *
   * Optional as a whole so every existing caller still compiles, and checked field by field
   * against what the card in question actually prints.
   */
  /**
   * Undo a verification whose evidence no longer stands, wherever that happens.
   *
   * One place, because the ways a verification stops being true are not obvious and were not all
   * covered: the number changing was, but a new scan landing on a verified row was not, and neither
   * was the *other* side of the comparison moving — somebody could verify a document against one
   * name and then rename the record, leaving an attestation that no longer says anything.
   *
   * Deliberately not triggered by the clock. A passport passing its expiry must not flip a stored
   * column: that would be a write nobody made, and expiry is already derived where it is read.
   */
  private undoVerification(row: AssayerDocumentEntity, because: string): boolean {
    if (row.verificationStatus !== DocumentVerification.VERIFIED) return false;
    row.verificationStatus = DocumentVerification.PENDING;
    row.verifiedAt = null;
    row.verifiedBy = null;
    row.nameMatchGrade = null;
    row.nameMatchNote = null;
    row.remarks = [row.remarks, `Verification withdrawn — ${because}.`].filter(Boolean).join(' ');
    return true;
  }

  /**
   * The person's name changed, so every verification that was checked against it is stale.
   *
   * Called from `AssayerService.update`. Without it the guard on the name comparison is defeated by
   * doing the two steps in order: verify a genuine document under the name it matches, then edit
   * the record to any other name. The attestation would survive, still saying VERIFIED, having
   * compared a name that is no longer there.
   */
  async revalidateAfterNameChange(assayerId: string, actorId: string): Promise<number> {
    const rows = await this.onboarding.find({
      where: { assayerId, isActive: true, verificationStatus: DocumentVerification.VERIFIED },
    });
    const affected = rows.filter((row) =>
      DOCUMENTS_PRINTING_A_NAME.includes(row.requirement as OnboardingDocument));
    for (const row of affected) {
      this.undoVerification(row, 'the name on the record was changed');
      row.updatedBy = actorId;
      await this.onboarding.save(row);
      await this.auditService?.recordEventSafe({
        category: EventCategory.OPERATIONAL,
        eventType: 'IDENTITY_DOCUMENT_VERIFICATION_INVALIDATED',
        entityType: 'ASSAYER',
        entityId: assayerId,
        userId: actorId,
        remarks: `${ONBOARDING_DOCUMENT_LABELS[row.requirement]} needs checking again — the name on `
          + 'the record was changed after it was verified.',
        metadata: { requirement: row.requirement, cause: 'NAME_CHANGED' },
      });
    }
    if (affected.length > 0) await this.deriveLegalName(assayerId, actorId);
    return affected.length;
  }

  /**
   * Invalidate document verification for a specific field change (PAN, Aadhaar, Bank Details).
   * Ensures surgical field-specific re-verification without resetting unrelated evidence.
   */
  async invalidateDocumentForFieldChange(
    assayerId: string,
    requirement: OnboardingDocument,
    reason: string,
    actorId: string,
  ): Promise<boolean> {
    const row = await this.onboarding.findOne({
      where: { assayerId, requirement, isActive: true },
    });
    if (!row || row.verificationStatus !== DocumentVerification.VERIFIED) return false;

    this.undoVerification(row, reason);
    row.updatedBy = actorId;
    await this.onboarding.save(row);

    // If versioning entity is active, mark version pending as well
    if (this.docVersions && row.currentVersionId) {
      await this.docVersions.update(
        { id: row.currentVersionId },
        { verificationStatus: DocumentVerification.PENDING, verifiedAt: null, verifiedBy: null },
      );
    }

    await this.auditService?.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'DOCUMENT_VERIFICATION_INVALIDATED',
      entityType: 'ASSAYER',
      entityId: assayerId,
      userId: actorId,
      remarks: `${ONBOARDING_DOCUMENT_LABELS[requirement]} verification invalidated: ${reason}. Re-verification required.`,
      metadata: { requirement, reason },
    });

    if (requirement === OnboardingDocument.BANK_PASSBOOK) {
      await this.assayers.update({ id: assayerId }, { identityVerifiedAt: null });
    }

    return true;
  }

  /**
   * Has this person's identity actually been established, and if not, what is missing?
   *
   * One home for the question, because it is asked from three places that must not be able to
   * disagree: the activation gate, the workforce review queue, and the roster's own filter. It is
   * deliberately expressed in documents rather than in a flag on the person — a flag would have to
   * be maintained, and the thing it would be maintained from is right here.
   *
   * "Verified" means a scan exists AND somebody attested to it. Neither half is enough on its own:
   * the roster import wrote 11,160 rows saying a document arrived with no file behind any of them,
   * so a count of rows would report this estate as fully documented.
   */
  async identityStanding(assayerId: string): Promise<IdentityStanding> {
    return this.identityStandingFrom(await this.onboarding.find({ where: { assayerId, isActive: true } }));
  }

  /**
   * The same judgement, on rows the caller already has.
   *
   * Split out for `dossier`, which has just loaded exactly these rows for the paperwork checklist
   * and would otherwise re-read them to ask one more question about them. Splitting the read from
   * the rule is the point: `deploymentVerdict` must answer the identity question the way the
   * activation gate answers it, and the only way to be sure of that is for there to be one
   * implementation with two entry points rather than two implementations that agree today.
   */
  private identityStandingFrom(rows: AssayerDocumentEntity[]): IdentityStanding {
    const byRequirement = new Map(rows.map((r) => [r.requirement as OnboardingDocument, r]));

    const verified: OnboardingDocument[] = [];
    const missing: OnboardingDocument[] = [];
    const rejected: OnboardingDocument[] = [];

    for (const requirement of IDENTITY_GATE_DOCUMENTS) {
      const row = byRequirement.get(requirement);
      const hasEvidence = (row?.filePaths ?? []).length > 0;
      if (row?.verificationStatus === DocumentVerification.VERIFIED && hasEvidence) {
        verified.push(requirement);
      } else if (row?.verificationStatus === DocumentVerification.REJECTED) {
        rejected.push(requirement);
      } else {
        missing.push(requirement);
      }
    }

    return { verified, missing, rejected, ok: missing.length === 0 && rejected.length === 0 };
  }

  /**
   * The name of record, taken from whichever identity document established it.
   *
   * One writer, so `assayers.legal_name` can always be traced back to a card somebody checked. It
   * re-derives rather than accumulating: when a verification is undone the name has to fall back
   * to the next document that still holds one, and when none does it has to disappear — a legal
   * name outliving the evidence for it is exactly the sort of confident, unfounded fact this whole
   * exercise exists to remove.
   *
   * `displayName` is untouched. That is what the organisation calls this person; this is what a
   * bank's branch would find on their Aadhaar, and the two are allowed to differ until somebody
   * reconciles them deliberately.
   */
  private async deriveLegalName(assayerId: string, actorId: string): Promise<void> {
    const rows = await this.onboarding.find({ where: { assayerId, isActive: true } });
    const verified = new Map(
      rows
        .filter((r) => r.verificationStatus === DocumentVerification.VERIFIED && r.holderName)
        .map((r) => [r.requirement as OnboardingDocument, r]),
    );

    const source = IDENTITY_NAME_PRECEDENCE.find((requirement) => verified.has(requirement));
    const row = source ? verified.get(source)! : null;

    await this.assayers.update({ id: assayerId }, {
      legalName: row?.holderName ?? null,
      legalNameSource: source ?? null,
      // Null again when the last verification is undone: "identity was established" must not
      // survive the evidence being withdrawn.
      identityVerifiedAt: row ? (row.verifiedAt ?? new Date()) : null,
      updatedBy: actorId,
    } as any);
  }

  async verifyDocument(
    id: string,
    verdict: DocumentVerification,
    actorId: string,
    remarks?: string,
    attested?: {
      holderName?: string | null;
      holderDateOfBirth?: string | null;
      holderGender?: string | null;
      holderGuardianName?: string | null;
      holderAddress?: string | null;
      rejectionReason?: DocumentRejectionReason | null;
      /** The reviewer has seen that the name does not agree, and says why they accepted it. */
      nameMismatchNote?: string | null;
      /** Explicit version to bind verification to */
      targetVersionId?: string | null;
      /** Optimistic concurrency version check */
      expectedDocVersion?: number;
      /** Exact content SHA-256 hash reviewer attested against */
      expectedContentHash?: string | null;
    },
  ) {
    const row = await this.onboarding.findOne({ where: { id } });
    if (!row) throw new NotFoundException('No such document.');
    // Ahead of every other check, so a foreign document id cannot be probed through the more
    // specific refusals below — the staleness 409, the "not an identity document" 400 and the
    // superseded-version 409 each describe the row, and describing a row is disclosing it.
    await this.assertOwnedAssayer(row.assayerId, 'No such document.');

    // Row-level optimistic concurrency check
    if (attested?.expectedDocVersion !== undefined && (row as any).version !== attested.expectedDocVersion) {
      throw new ConflictException(
        `DOCUMENT_VERSION_STALE: Expected document version ${attested.expectedDocVersion} but found ${(row as any).version}. The document was modified concurrently.`,
      );
    }

    if (!isIdentityDocument(row.requirement)) {
      throw new BadRequestException(
        `${ONBOARDING_DOCUMENT_LABELS[row.requirement]} is not an identity document. `
        + 'Record whether it arrived instead.',
      );
    }

    // Bind verification to specific document version
    const targetVersionId = attested?.targetVersionId ?? row.currentVersionId;
    let targetVersionRecord: AssayerDocumentVersionEntity | null = null;
    if (this.docVersions && targetVersionId) {
      targetVersionRecord = await this.docVersions.findOne({ where: { id: targetVersionId } });
      if (!targetVersionRecord) {
        throw new NotFoundException(`Document version ${targetVersionId} not found.`);
      }

      if (targetVersionRecord.supersededByVersionId || (row.currentVersionId && row.currentVersionId !== targetVersionId)) {
        throw new ConflictException(
          `CANNOT_VERIFY_SUPERSEDED_VERSION: Document version v${targetVersionRecord.version} has been superseded by a newer upload. Only the current version can be verified.`,
        );
      }

      /**
       * The scan this version cites has been destroyed, so there is nothing left to check.
       *
       * The same rule as the `file_paths` check further down — a verification that compares
       * nothing attests to nothing — asked of the version rather than of the parent, because the
       * two can disagree: a document with two scans still has a non-empty `file_paths` after the
       * one this version cites was released. The database refuses this write as well (the CHECK
       * in VerifiedDocumentEvidenceRetention), so without this the reviewer would get a 500 from
       * a constraint violation instead of a sentence telling them to upload the card again.
       */
      if (verdict === DocumentVerification.VERIFIED && targetVersionRecord.evidenceReleasedAt) {
        throw new BadRequestException(
          `The scan filed as v${targetVersionRecord.version} of this `
          + `${ONBOARDING_DOCUMENT_LABELS[row.requirement]} has been deleted, so there is nothing `
          + 'to have checked against the original. Upload the document again and verify the new scan.',
        );
      }

      // Invariant: Verification must bind to exact document version AND content hash
      const versionHash = targetVersionRecord.contentSha256 ?? targetVersionRecord.fileChecksum;
      if (attested?.expectedContentHash && versionHash && versionHash !== attested.expectedContentHash) {
        throw new ConflictException(
          `CONTENT_HASH_MISMATCH: Document content hash has changed (${versionHash} vs expected ${attested.expectedContentHash}). Verification cannot silently apply to a different content hash.`,
        );
      }

      if (
        targetVersionRecord.verificationStatus !== DocumentVerification.PENDING &&
        targetVersionRecord.verificationStatus !== verdict
      ) {
        throw new ConflictException(
          `DOCUMENT_ALREADY_REVIEWED: This document version has already been marked ${targetVersionRecord.verificationStatus} by another reviewer.`,
        );
      }
    }
    /**
     * The number is read from wherever it actually lives, which for the three that matter most is
     * NOT this row.
     *
     * `setDocument` stores a PAN or Aadhaar on the PERSON (`NUMBER_LIVES_ON_THE_PERSON`) so one
     * value cannot disagree with itself, and the dossier already reads it back that way. This
     * check did not: it tested `row.documentNumber`, which stays NULL for exactly PAN_CARD,
     * AADHAAR_FRONT and AADHAAR_BACK — so the three identity documents every bank actually asks
     * for could never be marked verified. Entering the number, uploading the scan and pressing
     * verify returned "there is no document number on this record" every time, with the number
     * plainly visible on the same screen. That blocks the DOCUMENT_VERIFICATION stage, and with
     * it activation, for every appraiser.
     */
    const numberOnPerson = NUMBER_LIVES_ON_THE_PERSON[row.requirement];
    let effectiveNumber: string | null = row.documentNumber ?? null;
    if (numberOnPerson) {
      const person = await this.assayers.findOne({ where: { id: row.assayerId } });
      effectiveNumber = (person?.[numberOnPerson] as string | null) ?? null;
    }
    /**
     * A number is needed to ATTEST, not to refuse.
     *
     * This read `verdict !== PENDING`, which caught REJECTED too — and made the commonest rejection
     * of all impossible to record. You reject an illegible scan precisely *because* you could not
     * read the number off it; demanding the number first is asking the reviewer for the thing they
     * are telling you they could not get.
     */
    if (verdict === DocumentVerification.VERIFIED && !effectiveNumber) {
      throw new BadRequestException(
        'There is no document number on this record, so there is nothing to have checked against '
        + 'the original.',
      );
    }

    /**
     * And there has to be a document to have checked.
     *
     * The roster import wrote 11,160 rows that say a document was received and hold no file —
     * `DataIntegrityService` reports them as "ticked as received, but no scan was kept". Without
     * this line every one of them could be marked verified in a single click, and the record would
     * then assert that somebody checked a scan that does not exist. That is a worse lie than the
     * tick, because a verification carries a name and a timestamp.
     */
    if (verdict === DocumentVerification.VERIFIED && (row.filePaths ?? []).length === 0) {
      throw new BadRequestException(
        `There is no scan of this ${ONBOARDING_DOCUMENT_LABELS[row.requirement]} on file, so there `
        + 'is nothing to have checked against the original. Upload the document first.',
      );
    }
    /**
     * A rejection has to say why, because the sentence has somewhere to go.
     *
     * It reaches the appraiser's phone in their own language and tells them whether to photograph
     * the same card again or find a different one. "Sent back" on its own is a dead end for the
     * person who has to act on it, and the database CHECK refuses it too.
     */
    if (verdict === DocumentVerification.REJECTED && !attested?.rejectionReason) {
      throw new BadRequestException(
        'Say why the document was sent back. The reason is shown to the appraiser, and it is what '
        + 'tells them whether to photograph the same card again or send a different one.',
      );
    }

    let nameMatch: NameMatchGrade | null = null;

    if (verdict === DocumentVerification.VERIFIED) {
      /**
       * The reviewer types what the card says, and only what the card actually carries.
       *
       * Asking for a field the document does not print — an address on the Aadhaar *front*, which
       * is the photo side — teaches people that the form asks for things that are not there, and a
       * form that does that gets ignored wholesale.
       */
      const prints = DOCUMENT_PRINTED_FIELDS[row.requirement as OnboardingDocument];
      if (prints) {
        const supplied: Record<string, unknown> = {
          name: attested?.holderName ?? row.holderName,
          dateOfBirth: attested?.holderDateOfBirth ?? row.holderDateOfBirth,
          gender: attested?.holderGender ?? row.holderGender,
          guardianName: attested?.holderGuardianName ?? row.holderGuardianName,
          address: attested?.holderAddress ?? row.holderAddress,
        };
        const missing = (Object.keys(prints) as Array<keyof typeof prints>)
          .filter((field) => prints[field] && !String(supplied[field] ?? '').trim())
          .map((field) => PRINTED_FIELD_LABELS[field]);
        if (missing.length > 0) {
          throw new BadRequestException(
            `Before this ${ONBOARDING_DOCUMENT_LABELS[row.requirement]} can be marked verified, `
            + `record what it says: ${missing.join(', ')}. That is what the record is checked `
            + 'against — a verification that compares nothing attests to nothing.',
          );
        }
      }

      if (attested?.holderName !== undefined) row.holderName = attested.holderName || null;
      if (attested?.holderDateOfBirth !== undefined) {
        row.holderDateOfBirth = attested.holderDateOfBirth ? new Date(attested.holderDateOfBirth) : null;
      }
      if (attested?.holderGender !== undefined) row.holderGender = attested.holderGender || null;
      if (attested?.holderGuardianName !== undefined) row.holderGuardianName = attested.holderGuardianName || null;
      if (attested?.holderAddress !== undefined) row.holderAddress = attested.holderAddress || null;

      /**
       * Does the name on the card agree with the name on the record?
       *
       * A MISMATCH is refused rather than warned about, but it is not a wall: the reviewer may go
       * ahead by saying why, and that sentence is stored beside the grade as evidence that a human
       * saw the disagreement. The roster's names are the unreliable side of this comparison — they
       * were hand-typed over years and split on the last space — so refusing outright would stop a
       * legitimate estate rather than catching a fraudulent one.
       */
      if (DOCUMENTS_PRINTING_A_NAME.includes(row.requirement as OnboardingDocument)) {
        const person = await this.assayers.findOne({ where: { id: row.assayerId } });
        nameMatch = compareNames(person?.displayName, row.holderName).grade;
        const note = String(attested?.nameMismatchNote ?? '').trim();
        if (nameMatch === 'MISMATCH' && note.length < 10) {
          throw new BadRequestException(
            `The name on this document ("${row.holderName}") does not match the name on the record `
            + `("${person?.displayName ?? '—'}"). If it is the same person, say why in a sentence `
            + 'and it will be recorded with the verification. If it is not, send the document back.',
          );
        }
        row.nameMatchGrade = nameMatch;
        row.nameMatchNote = note || null;
      }
    }

    if (this.docVersions && targetVersionRecord) {
      targetVersionRecord.verificationStatus = verdict;
      targetVersionRecord.verifiedAt = verdict === DocumentVerification.PENDING ? null : new Date();
      targetVersionRecord.verifiedBy = verdict === DocumentVerification.PENDING ? null : actorId;
      targetVersionRecord.rejectionReason = verdict === DocumentVerification.REJECTED
        ? (attested?.rejectionReason ?? null)
        : null;
      await this.docVersions.save(targetVersionRecord);
    }

    const previousStatus = row.verificationStatus;
    row.verificationStatus = verdict;
    row.verifiedAt = verdict === DocumentVerification.PENDING ? null : new Date();
    row.verifiedBy = verdict === DocumentVerification.PENDING ? null : actorId;
    // Carried only on a rejection: a reason left behind on a later verification would describe a
    // decision that has been reversed.
    row.rejectionReason = verdict === DocumentVerification.REJECTED
      ? (attested?.rejectionReason ?? null)
      : null;
    if (remarks !== undefined) row.remarks = remarks || null;
    row.updatedBy = actorId;
    const saved = await this.onboarding.save(row);

    // The name of record follows the documents, so it has to be re-derived whenever one of them
    // changes verdict — in either direction.
    await this.deriveLegalName(row.assayerId, actorId);

    /**
     * Tell the person whose document it is.
     *
     * A rejection that only the office can see is a queue of one: the appraiser carries on
     * believing their paperwork is in, and the desk waits for a replacement nobody has asked for.
     * The body is the guidance sentence — what to DO — rather than the reviewer's label, which
     * states a finding: "photograph it again in better light" instead of "too blurred".
     *
     * Nothing on a VERIFIED verdict. Telling somebody their PAN was accepted is noise, and a
     * channel that carries noise stops being read before it carries something that matters.
     */
    if (verdict === DocumentVerification.REJECTED) {
      const reason = attested?.rejectionReason;
      this.notifications?.emitSafe({
        type: 'ASSAYER_IDENTITY_DOCUMENT_REJECTED',
        entityType: 'ASSAYER',
        entityId: saved.assayerId,
        actorUserId: actorId,
        assayerId: saved.assayerId,
        // Keyed on the verdict's moment, so a second rejection of a replacement is its own message
        // rather than being swallowed as a duplicate of the first.
        dedupeKey: `IDENTITY_REJECTED:${saved.id}:${saved.verifiedAt?.toISOString() ?? ''}`,
        payload: {
          documentName: ONBOARDING_DOCUMENT_LABELS[saved.requirement],
          guidance: reason
            ? DOCUMENT_REJECTION_GUIDANCE[reason]
            : 'The office could not accept this. Please take a clear photo of the whole document and send it again.',
        },
      });
    }
    // Verify/reject/reset (PENDING is a reset) on an identity document had no trail — the only
    // evidence was the row's current state, with no record of who checked it or when it changed.
    await this.auditService?.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'IDENTITY_DOCUMENT_VERIFICATION_CHANGED',
      entityType: 'ASSAYER',
      entityId: saved.assayerId,
      previousState: previousStatus ?? undefined,
      newState: verdict,
      userId: actorId,
      remarks: `${ONBOARDING_DOCUMENT_LABELS[saved.requirement]} verification set to ${verdict}`,
      metadata: {
        requirement: saved.requirement,
        previousValue: { verificationStatus: previousStatus },
        newValue: { verificationStatus: verdict },
      },
    });
    return saved;
  }

  // ── The import review queue ───────────────────────────────────────────

  /**
   * The review queue — what the import could not read and what the data-integrity scan found —
   * newest first.
   *
   * Newest first and a 500 default, where this used to be oldest-first with a default of 200:
   * that combination silently hid 83 of the 283 open findings from the panel (`openCount` said
   * 283; the body could only ever show the oldest 200), and every row the standing scanner adds
   * sorts LAST under `ASC` — the freshest defect would have been the least visible. The 500
   * ceiling stands so one request cannot balloon; the panel says "showing X of Y" when it is hit.
   *
   * Open by default: a resolved issue is a decision somebody already made, and showing it
   * alongside the outstanding ones is how a review queue stops being read.
   *
   * Region-scoped like the roster it is drawn from: `AssayerController.findAll` honours
   * `scope.regions`, and this queue did not, so a region-scoped desk saw import issues for every
   * territory, not their own. Scoped by the ISSUE'S OWN assayer — the `issue.assayer` join this
   * already carries for the row's display columns — rather than by anything on the issue itself,
   * since an issue has no region of its own. An issue with no assayer attached (`assayerId` is
   * nullable: the commonest case is an unmatched source code, which is exactly the row most worth
   * surfacing — see the entity's own comment) has no region to test either way, so it is ORed
   * into every scope rather than silently dropped out of all of them the moment any scope narrows.
   */
  async listIssues(options: {
    includeResolved?: boolean;
    limit?: number;
    scope?: Partial<GlobalScope>;
  } = {}) {
    const limit = Math.min(options.limit ?? 500, 500);
    const regions = options.scope?.regions;

    const organizationId = tenantFilterId();

    const applyScope = (qb: SelectQueryBuilder<AssayerImportIssueEntity>) => {
      /**
       * The tenant predicate rides the same `leftJoin('issue.assayer', 'assayer')` the region one
       * does, because `assayer_import_issues` has no organisation of its own.
       *
       * `OR issue.assayerId IS NULL` is kept for the organisation exactly as it is kept for the
       * region, and for the same reason: an import issue can be filed against a spreadsheet row
       * that never became an assayer (a duplicate code, an unparseable date), and those rows have
       * no parent to inherit a tenant from. Dropping them would hide the review queue's whole
       * point — the rows that failed — from everyone. They contain the offending cell value and
       * the sheet position, not another organisation's person, because there is no person.
       */
      if (organizationId) {
        qb.andWhere('(assayer.organization_id = :__tenantId OR issue.assayerId IS NULL)', { __tenantId: organizationId });
      }
      if (regions?.length) {
        qb.andWhere('(assayer.region IN (:...regions) OR issue.assayerId IS NULL)', { regions });
      }
      return qb;
    };

    const rowsQb = this.issues.createQueryBuilder('issue')
      .leftJoin('issue.assayer', 'assayer')
      .addSelect(['assayer.id', 'assayer.assayerCode', 'assayer.firstName', 'assayer.lastName', 'assayer.region'])
      .orderBy('issue.createdAt', 'DESC')
      .take(limit);
    if (!options.includeResolved) rowsQb.where('issue.resolvedAt IS NULL');
    // Appended after the conditional `.where()` above, never before: TypeORM's `.where()` resets
    // whatever conditions already exist on the builder, so an `.andWhere()` call ahead of it would
    // be silently discarded rather than combined.
    applyScope(rowsQb);

    // A genuinely separate query, not `rows.length`: the count means "how many are open" whether
    // or not this call is also showing resolved ones, and it carries no `.take()` ceiling of its
    // own — the row list can be capped at 500 while the count still reports the true total.
    const countQb = this.issues.createQueryBuilder('issue')
      .leftJoin('issue.assayer', 'assayer')
      .where('issue.resolvedAt IS NULL');
    applyScope(countQb);

    const [rows, openCount] = await Promise.all([rowsQb.getMany(), countQb.getCount()]);
    return { rows, openCount };
  }

  /**
   * Files a district-vs-pincode disagreement as a review-queue row, for a record the API just
   * wrote — not a spreadsheet import. `AssayerService.create`/`update` used to 400 on this
   * mismatch outright, which directly contradicted the registration wizard's own promise that
   * such a record "will be saved as entered". The record is now saved exactly as the clerk typed
   * it; this is the queue entry that says so, in the same table and under the same operating
   * rule every other row here already follows — nothing guessed or changed automatically, every
   * one waits for a person to decide.
   *
   * `source_sheet`/`source_row`/`source_column` exist for a spreadsheet cell — see the entity's
   * own comment — and there is no sheet or row behind a live API write, so `sourceSheet` carries
   * a constant that names the KIND of issue instead of a real sheet, `sourceRow` is `0` (never a
   * value `roster-import.service.ts` produces — its rows start at 2), and `sourceColumn` names
   * the field in question. `resolveIssue`/`listIssues` read this row exactly like an importer one;
   * neither cares where a row came from.
   */
  async recordDistrictPincodeMismatch(
    assayerId: string,
    info: { enteredDistrict: string; authorityDistrict: string; authorityState: string; pincode: string },
    actorId: string,
  ): Promise<AssayerImportIssueEntity> {
    const row = this.issues.create({
      assayerId,
      sourceAssayerCode: null,
      sourceSheet: 'DISTRICT_PINCODE_MISMATCH',
      sourceRow: 0,
      sourceColumn: 'District',
      rawValue: info.enteredDistrict,
      reason: `Pincode ${info.pincode} is in ${info.authorityDistrict} district (${info.authorityState}), but ` +
        `the record says "${info.enteredDistrict}". Saved as entered — confirm which is right.`,
      createdBy: actorId,
      updatedBy: actorId,
    });
    return this.issues.save(row);
  }

  async resolveIssue(id: string, resolution: string, actorId: string) {
    const row = await this.issues.findOne({ where: { id } });
    if (!row) throw new NotFoundException('No such import issue.');
    // Keyed by the issue, and the route takes no scope at all. A row with no `assayerId` is a
    // spreadsheet cell that never became a person and belongs to no organisation — the same rows
    // `listIssues` deliberately shows everyone — so only the ones that DO name an assayer are
    // gated on that assayer's owner.
    if (row.assayerId) await this.assertOwnedAssayer(row.assayerId, 'No such import issue.');
    const stated = (resolution ?? '').trim();
    if (!stated) {
      // The queue exists because nothing was guessed. Closing an entry with no account of what
      // was decided puts the guess back, just without a record of it.
      throw new BadRequestException('Say what was decided about this cell before closing it.');
    }
    row.resolvedAt = new Date();
    row.resolvedBy = actorId;
    row.resolution = stated;
    row.updatedBy = actorId;
    return this.issues.save(row);
  }

  /**
   * Close a group of issues under one account of what was decided.
   *
   * One import problem produces one issue per affected row — a mis-spelled state column across a
   * 68-person branch is 68 entries and ONE decision. Closing them through the per-row route meant
   * 68 requests, and a failure partway through left the group half closed with nothing in the
   * queue to say where it stopped.
   *
   * Every id gets an outcome and the request never fails as a whole. An id that is unknown or
   * already resolved is reported against itself and the remaining rows still close: somebody else
   * having touched one row of a group is not a reason to abandon the other sixty-seven, and it is
   * the commonest way two people working the same queue collide.
   *
   * Sequential rather than `Promise.all`: these are writes to one table and the batch is bounded
   * at 500 by the request DTO, so there is nothing to win by making the database do them at once
   * beyond a lock contention this does not need.
   */
  async resolveIssues(ids: string[], resolution: string, actorId: string) {
    const stated = (resolution ?? '').trim();
    if (!stated) {
      throw new BadRequestException('Say what was decided about these cells before closing them.');
    }

    // Duplicates in the payload would otherwise produce two outcomes for one id, the second of
    // them a spurious "already resolved" caused by the first.
    const unique = [...new Set(ids ?? [])];
    const results: Array<{ id: string; resolved: boolean; reason?: string }> = [];

    for (const id of unique) {
      const row = await this.issues.findOne({ where: { id } });
      if (!row) {
        results.push({ id, resolved: false, reason: 'No such import issue.' });
        continue;
      }
      // Reported as the same "No such import issue." a genuinely unknown id gets, and reported per
      // row rather than thrown: this route is explicitly built so one bad id never abandons the
      // other sixty-seven, and a foreign id is just another bad id.
      if (row.assayerId && !(await this.ownsAssayer(row.assayerId))) {
        results.push({ id, resolved: false, reason: 'No such import issue.' });
        continue;
      }
      if (row.resolvedAt) {
        results.push({ id, resolved: false, reason: 'Already closed by somebody else.' });
        continue;
      }
      row.resolvedAt = new Date();
      row.resolvedBy = actorId;
      row.resolution = stated;
      row.updatedBy = actorId;
      await this.issues.save(row);
      results.push({ id, resolved: true });
    }

    return {
      results,
      resolved: results.filter((r) => r.resolved).length,
      failed: results.filter((r) => !r.resolved).length,
      // What the queue should show next, read after the writes — so a panel that refreshes from
      // this response cannot briefly display a count the batch has already changed.
      // Counted through the same scoped builder `listIssues` uses, not `issues.count()`: a bare
      // count over the table reported every organisation's open issues, so the panel that
      // refreshes from this response would have shown a total it could not account for from the
      // rows above it.
      openCount: (await this.listIssues({ limit: 1 })).openCount,
    };
  }
}
