import { Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException, Optional } from '@nestjs/common';
import {
  AssayerLifecycleStatus, EventCategory, OnboardingApprovalEventKind as Kind, OnboardingApprovalStatus as Status,
  approvalPreparers, approvalTextProblem, type OnboardingApprovalEvent,
} from '@fapoms/shared';
import { AssayerOnboardingApprovalEntity } from './assayer-onboarding-approval.entity';
import { AssayerEntity } from './assayer.entity';
import { AssayerService } from './assayer.service';
import { AuditService } from '../../core/audit/audit.service';
import { tenantWhere } from '../../infrastructure/tenancy/ambient-tenant-context';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';

export interface ApprovalActor { id: string; name?: string | null }

/** A round as the screens read it — names resolved, and whether the reader may decide it. */
export interface ApprovalRoundView {
  id: string;
  round: number;
  status: Status;
  events: OnboardingApprovalEvent[];
  submittedBy: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  /** Who prepared it — the people who may not decide it. */
  preparers: string[];
}

const OPEN = [Status.PENDING, Status.INFO_REQUESTED];

/**
 * THE APPROVAL BEFORE TRAINING — the decisions on a round (see `onboarding-approval.ts`).
 *
 * The round itself is opened by the lifecycle (`openApprovalRound`) whenever somebody enters
 * FINAL_APPROVAL. This service is everything after: the approver asks for more, HR answers, and the
 * approver approves (→ TRAINING) or rejects with a reason (→ INACTIVE, APPROVAL_REJECTED). Who may
 * call which is the controller's permission; that the decider is not a preparer is checked here,
 * because it depends on the round.
 */
@Injectable()
export class OnboardingApprovalService {
  constructor(
    private readonly assayerService: AssayerService,
    private readonly auditService: AuditService,
    private readonly unitOfWork: UnitOfWork,
    /** Optional so the decision never waits on — or fails for — the bell. */
    @Optional() private readonly notifications?: NotificationDispatchService,
  ) {}

  /** Every round for one person, newest first, names resolved. */
  async history(assayerId: string): Promise<ApprovalRoundView[]> {
    await this.assayerService.findOne(assayerId);
    const rows = await this.unitOfWork.run((m) => m.getRepository(AssayerOnboardingApprovalEntity)
      .find({ where: { assayerId }, order: { round: 'DESC' } }));
    return this.withNames(rows);
  }

  /** The approver's queue: everybody with an open round, oldest first. */
  async queue(): Promise<Array<ApprovalRoundView & { assayerId: string; displayName: string; assayerCode: string | null }>> {
    const rows = await this.unitOfWork.run((m) => m.getRepository(AssayerOnboardingApprovalEntity)
      .find({ where: OPEN.map((status) => ({ status })), order: { createdAt: 'ASC' } }));
    if (rows.length === 0) return [];
    // Tenant-scoped: an approver sees only their own organisation's joiners.
    const people = await this.unitOfWork.run((m) => m.getRepository(AssayerEntity).find({
      where: [...new Set(rows.map((r) => r.assayerId))].flatMap((id) => {
        const w = tenantWhere<AssayerEntity>({ id, isActive: true });
        return Array.isArray(w) ? w : [w];
      }),
      select: { id: true, displayName: true, assayerCode: true, lifecycleStatus: true },
    }));
    const byId = new Map(people.map((p) => [p.id, p]));
    const named = await this.withNames(rows.filter((r) => byId.has(r.assayerId)));
    return named.map((v) => {
      const row = rows.find((r) => r.id === v.id)!;
      const person = byId.get(row.assayerId)!;
      return { ...v, assayerId: row.assayerId, displayName: person.displayName, assayerCode: person.assayerCode ?? null };
    });
  }

  /** The approver asks HR for more. The round stays with HR until they answer. */
  async requestInfo(assayerId: string, text: string, actor: ApprovalActor): Promise<ApprovalRoundView> {
    this.assertText(Kind.INFO_REQUESTED, text);
    const view = await this.onOpenRound(assayerId, async (round) => {
      if (round.status !== Status.PENDING) {
        throw new ConflictException('More has already been asked — wait for HR to answer before asking again.');
      }
      this.assertNotPreparer(round, actor);
      round.status = Status.INFO_REQUESTED;
      this.append(round, Kind.INFO_REQUESTED, actor, text);
      return { eventType: 'ASSAYER_APPROVAL_INFO_REQUESTED', remarks: `More asked of HR before approval: ${text.trim()}` };
    });
    const asked = view.events.filter((e) => e.kind === Kind.INFO_REQUESTED).length;
    await this.tellPreparers(view, assayerId, actor, 'ASSAYER_APPROVAL_INFO_REQUESTED', `${asked}`, (name) => ({
      askedBy: actor.name?.trim() || 'The approver', question: text.trim().slice(0, 300), assayerName: name,
    }));
    return view;
  }

  /** HR answers the approver, and the round goes back to them. */
  async answer(assayerId: string, text: string, actor: ApprovalActor): Promise<ApprovalRoundView> {
    this.assertText(Kind.ANSWERED, text);
    const view = await this.onOpenRound(assayerId, async (round) => {
      if (round.status !== Status.INFO_REQUESTED) {
        throw new ConflictException('Nothing has been asked on this approval — there is nothing to answer.');
      }
      round.status = Status.PENDING;
      this.append(round, Kind.ANSWERED, actor, text);
      return { eventType: 'ASSAYER_APPROVAL_ANSWERED', remarks: `HR answered the approver: ${text.trim()}` };
    });
    // It is back with the approvers: tell them, as when it was first sent up.
    const person = await this.assayerService.findOne(assayerId);
    const answeredEvents = view.events.filter((e) => e.kind === Kind.ANSWERED).length;
    this.notifications?.emitSafe({
      type: 'ASSAYER_APPROVAL_ANSWERED',
      entityType: 'ASSAYER',
      entityId: assayerId,
      actorUserId: actor.id,
      assayerId,
      dedupeKey: `ASSAYER_APPROVAL_ANSWERED:${view.id}:${answeredEvents}`,
      payload: {
        assayerName: person.displayName,
        assayerId,
        answeredBy: actor.name?.trim() || 'HR',
        answer: text.trim().slice(0, 300),
      },
    });
    return view;
  }

  /** Approve: on to training, in the same transaction as the round's decision. */
  async approve(assayerId: string, note: string | null | undefined, actor: ApprovalActor): Promise<ApprovalRoundView> {
    this.assertText(Kind.APPROVED, note);
    return this.decide(assayerId, 'APPROVED', note ?? '', actor);
  }

  /** Reject, with the reason: parked inactive as APPROVAL_REJECTED, and re-openable. */
  async reject(assayerId: string, reason: string, actor: ApprovalActor): Promise<ApprovalRoundView> {
    this.assertText(Kind.REJECTED, reason);
    return this.decide(assayerId, 'REJECTED', reason, actor);
  }

  // ── internals ─────────────────────────────────────────────────────────

  private async decide(assayerId: string, decision: 'APPROVED' | 'REJECTED', text: string, actor: ApprovalActor) {
    const person = await this.assayerService.findOne(assayerId);
    if (person.lifecycleStatus !== AssayerLifecycleStatus.FINAL_APPROVAL) {
      throw new ConflictException(`${person.displayName} is not awaiting approval.`);
    }
    const round = await this.openRound(assayerId);
    this.assertNotPreparer(round, actor);

    const kind = decision === 'APPROVED' ? Kind.APPROVED : Kind.REJECTED;
    let decided: AssayerOnboardingApprovalEntity | null = null;
    await this.assayerService.decideFinalApproval(
      assayerId, decision, actor.id,
      decision === 'APPROVED' ? `Approved to join${text.trim() ? `: ${text.trim()}` : ''}` : `Not approved: ${text.trim()}`,
      async (manager) => {
        if (!manager) throw new ConflictException('The decision could not be recorded: no transaction.');
        const repo = manager.getRepository(AssayerOnboardingApprovalEntity);
        // Re-read under the transaction: a decision already taken is not taken twice.
        const fresh = await repo.findOne({ where: { id: round.id } });
        if (!fresh || !OPEN.includes(fresh.status)) throw new ConflictException('This approval has already been decided.');
        fresh.status = decision === 'APPROVED' ? Status.APPROVED : Status.REJECTED;
        fresh.decidedBy = actor.id;
        fresh.decidedAt = new Date();
        this.append(fresh, kind, actor, text);
        decided = await repo.save(fresh);
      },
    );
    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: decision === 'APPROVED' ? 'ASSAYER_APPROVAL_APPROVED' : 'ASSAYER_APPROVAL_REJECTED',
      entityType: 'ASSAYER',
      entityId: assayerId,
      userId: actor.id,
      previousState: AssayerLifecycleStatus.FINAL_APPROVAL,
      newState: decision === 'APPROVED' ? AssayerLifecycleStatus.TRAINING : AssayerLifecycleStatus.INACTIVE,
      remarks: decision === 'APPROVED'
        ? `Approved to join (round ${round.round})${text.trim() ? `: ${text.trim()}` : ''}.`
        : `Not approved (round ${round.round}): ${text.trim()}`,
      metadata: { approvalId: round.id, round: round.round },
    });
    const view = (await this.withNames([decided!]))[0];
    await this.tellPreparers(
      view, assayerId, actor,
      decision === 'APPROVED' ? 'ASSAYER_APPROVAL_APPROVED' : 'ASSAYER_APPROVAL_REJECTED', 'decided',
      (name) => ({
        assayerName: name,
        decidedBy: actor.name?.trim() || 'The approver',
        reason: text.trim().slice(0, 300),
        noteLine: decision === 'APPROVED' && text.trim() ? ` Their note: "${text.trim().slice(0, 300)}".` : '',
      }),
      person.displayName,
    );
    return view;
  }

  /**
   * Tell the HR people who prepared this round what the approver did — each of them, by name
   * (RECORD_OWNER), not the whole desk. Never lets a notification failure touch the decision.
   */
  private async tellPreparers(
    view: ApprovalRoundView,
    assayerId: string,
    actor: ApprovalActor,
    type: string,
    step: string,
    payload: (assayerName: string) => Record<string, unknown>,
    knownName?: string,
  ): Promise<void> {
    if (!this.notifications) return;
    const name = knownName ?? (await this.assayerService.findOne(assayerId).catch(() => null))?.displayName ?? 'This candidate';
    for (const userId of view.preparers) {
      if (userId === actor.id) continue;
      this.notifications.emitSafe({
        type,
        entityType: 'ASSAYER',
        entityId: assayerId,
        actorUserId: actor.id,
        ownerUserId: userId,
        assayerId,
        dedupeKey: `${type}:${view.id}:${step}:${userId}`,
        payload: { ...payload(name), assayerId },
      });
    }
  }

  /** Change an open round inside a transaction that holds it, then write the trail. */
  private async onOpenRound(
    assayerId: string,
    change: (round: AssayerOnboardingApprovalEntity) => Promise<{ eventType: string; remarks: string }>,
  ): Promise<ApprovalRoundView> {
    await this.assayerService.findOne(assayerId);
    const { saved, trail } = await this.unitOfWork.run(async (manager) => {
      const repo = manager.getRepository(AssayerOnboardingApprovalEntity);
      const round = await repo.findOne({
        where: [{ assayerId, status: Status.PENDING }, { assayerId, status: Status.INFO_REQUESTED }],
        lock: { mode: 'pessimistic_write' },
      });
      if (!round) throw new NotFoundException('There is no open approval for this person.');
      const t = await change(round);
      return { saved: await repo.save(round), trail: t };
    });
    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: trail.eventType,
      entityType: 'ASSAYER',
      entityId: assayerId,
      userId: saved.events.at(-1)?.byId,
      remarks: trail.remarks,
      metadata: { approvalId: saved.id, round: saved.round },
    });
    return (await this.withNames([saved]))[0];
  }

  private async openRound(assayerId: string): Promise<AssayerOnboardingApprovalEntity> {
    const round = await this.unitOfWork.run((m) => m.getRepository(AssayerOnboardingApprovalEntity).findOne({
      where: [{ assayerId, status: Status.PENDING }, { assayerId, status: Status.INFO_REQUESTED }],
    }));
    if (!round) throw new NotFoundException('There is no open approval for this person.');
    return round;
  }

  private assertNotPreparer(round: AssayerOnboardingApprovalEntity, actor: ApprovalActor): void {
    if (approvalPreparers(round.events ?? []).includes(actor.id)) {
      throw new ForbiddenException(
        'You sent this person up for approval or answered on it, so somebody else has to decide it.',
      );
    }
  }

  private assertText(kind: Kind, text: string | null | undefined): void {
    const problem = approvalTextProblem(kind, text);
    if (problem) throw new BadRequestException(problem);
  }

  private append(round: AssayerOnboardingApprovalEntity, kind: Kind, actor: ApprovalActor, text: string | null | undefined): void {
    round.events = [...(round.events ?? []), {
      kind, byId: actor.id, byName: actor.name?.trim() || null, at: new Date().toISOString(), text: text?.trim() || null,
    }];
    round.updatedBy = actor.id;
  }

  /** Fill in names the lifecycle could not know when it opened the round (it has only the user id). */
  private async withNames(rows: AssayerOnboardingApprovalEntity[]): Promise<ApprovalRoundView[]> {
    const missing = [...new Set(rows.flatMap((r) => (r.events ?? []).filter((e) => !e.byName).map((e) => e.byId)))];
    const names = new Map<string, string>();
    if (missing.length > 0) {
      const found: Array<{ id: string; display_name: string }> = await this.unitOfWork.run((m) => m.query(
        'SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])', [missing],
      )).catch(() => []);
      for (const u of found) names.set(u.id, u.display_name);
    }
    return rows.map((r) => ({
      id: r.id,
      round: r.round,
      status: r.status,
      events: (r.events ?? []).map((e) => ({ ...e, byName: e.byName ?? names.get(e.byId) ?? null })),
      submittedBy: r.submittedBy,
      decidedBy: r.decidedBy,
      decidedAt: r.decidedAt,
      preparers: approvalPreparers(r.events ?? []),
    }));
  }
}
