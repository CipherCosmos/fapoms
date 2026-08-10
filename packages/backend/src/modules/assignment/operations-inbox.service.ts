import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { AssignmentEntity } from './assignment.entity';
import { AssignmentStatus, ProjectBranchStatus, businessTodayDateKey } from '@fapoms/shared';
import { FEE_FLAG_MULTIPLIER } from '../pricing/fee-policy.service';

/**
 * The Operations Inbox: every assignment that needs a HUMAN decision right now, as one queue.
 *
 * The three stage pages mirror the assignment lifecycle, which is right for planning-time work —
 * but real desk work is exception-shaped: an offer that must be made by PHONE (not every assayer
 * uses a smartphone), an in-app counter to answer, a decline needing a replacement, accepted work
 * with no date, a scheduled audit past its date with no check-in. Each of those previously meant
 * a tour across Planning → Scheduling → Execution. This service surfaces them as cards; the
 * system proposes, the desk disposes. Nothing here acts automatically.
 */

export type ContactChannel = 'APP' | 'PHONE';

/** How long an APP-channel offer may sit unanswered before the desk is told to pick up the phone. */
const APP_SILENCE_HOURS = 6;
/** Replacement lane looks this far back for declines — older ones are stale planning, not a queue. */
const REPLACEMENT_WINDOW_DAYS = 14;
/** After this many unanswered call attempts the card suggests the next candidate (never automatic). */
export const SUGGEST_NEXT_AFTER_ATTEMPTS = 3;

export interface InboxAssignment {
  id: string;
  assignmentNumber: string;
  projectBranchId: string | null;
  branchName: string | null;
  branchCity: string | null;
  branchId: string | null;
  projectName: string | null;
  assayerId: string;
  assayerName: string | null;
  assayerPhone: string | null;
  channel: ContactChannel;
  proposedFee: number | null;
  agreedFee: number | null;
  /** The client's reference base fee, for the sanity guard below. */
  clientBaseFee: number | null;
  /** True when the proposed fee exceeds FEE_FLAG_MULTIPLIER × the client reference — a
      mis-entered contract rate should be a visible warning, never silent money. */
  feeFlagged: boolean;
  negotiationCount: number;
  scheduledDate: string | null;
  ageHours: number;
  callAttempts: number;
  lastCallOutcome: string | null;
  rejectReason?: string | null;
}

export interface OperationsInbox {
  /** PHONE-channel offers + APP offers that have gone quiet: the desk should dial. */
  callTasks: InboxAssignment[];
  /** In-app counter-offers awaiting the desk's answer. */
  negotiations: InboxAssignment[];
  /** Declined / auto-declined branches that still need someone. */
  replacements: InboxAssignment[];
  /** Accepted but not on the calendar yet. */
  unscheduled: InboxAssignment[];
  /** Past their scheduled date with no check-in. */
  overdue: InboxAssignment[];
  /** APP offers still inside their quiet window — informational only. */
  waitingOnApp: number;
}

@Injectable()
export class OperationsInboxService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Resolve each assayer's effective channel. Explicit APP/PHONE override wins; AUTO derives from
   * whether the assayer has an active device token (they use the app) — no token, no smartphone
   * channel. One grouped query for the whole set.
   */
  async resolveChannels(assayerIds: string[]): Promise<Map<string, ContactChannel>> {
    const out = new Map<string, ContactChannel>();
    if (assayerIds.length === 0) return out;

    const assayers: Array<{ id: string; preferred_contact_channel: string | null }> = await this.dataSource.query(
      `SELECT id, preferred_contact_channel FROM assayers WHERE id = ANY($1)`,
      [assayerIds],
    );
    const tokenRows: Array<{ user_id: string }> = await this.dataSource.query(
      `SELECT DISTINCT user_id FROM device_tokens WHERE user_id = ANY($1) AND is_active = true`,
      [assayerIds],
    );
    const hasToken = new Set(tokenRows.map((r) => r.user_id));

    for (const a of assayers) {
      const pref = (a.preferred_contact_channel ?? 'AUTO').toUpperCase();
      if (pref === 'APP' || pref === 'PHONE') out.set(a.id, pref as ContactChannel);
      else out.set(a.id, hasToken.has(a.id) ? 'APP' : 'PHONE');
    }
    return out;
  }

  async getInbox(): Promise<OperationsInbox> {
    const assignmentRepo = this.dataSource.getRepository(AssignmentEntity);
    const now = Date.now();
    const todayKey = businessTodayDateKey();

    // One load covers three lanes: open offers (PENDING) split into call tasks / negotiations /
    // waiting-on-app, plus ACCEPTED work for the unscheduled and overdue lanes.
    const [pending, accepted] = await Promise.all([
      assignmentRepo.find({
        where: { status: AssignmentStatus.PENDING, isActive: true },
        relations: ['assayer', 'projectBranch', 'projectBranch.branch', 'project'],
        order: { createdAt: 'ASC' },
        take: 200,
      }),
      assignmentRepo.find({
        where: { status: AssignmentStatus.ACCEPTED, isActive: true },
        relations: ['assayer', 'projectBranch', 'projectBranch.branch', 'project'],
        order: { scheduledDate: 'ASC' },
        take: 200,
      }),
    ]);

    // Recent declines whose branch is back in candidate search and has no newer open assignment —
    // i.e. the decline is still the branch's live state and a replacement is genuinely owed.
    const rejected = await assignmentRepo
      .createQueryBuilder('a')
      .leftJoinAndSelect('a.assayer', 'assayer')
      .leftJoinAndSelect('a.projectBranch', 'pb')
      .leftJoinAndSelect('pb.branch', 'branch')
      .leftJoinAndSelect('a.project', 'project')
      .where('a.status = :st AND a.isActive = true', { st: AssignmentStatus.REJECTED })
      .andWhere('pb.status = :pbst', { pbst: ProjectBranchStatus.CANDIDATE_SEARCH })
      .andWhere(`a.updatedAt > NOW() - INTERVAL '${REPLACEMENT_WINDOW_DAYS} days'`)
      .andWhere(
        `NOT EXISTS (SELECT 1 FROM assignments a2 WHERE a2.project_branch_id = a.project_branch_id
           AND a2.is_active = true AND a2.status IN ('PENDING','ACCEPTED','CHECKED_IN','IN_PROGRESS')
           AND a2.created_at > a.updated_at)`,
      )
      .orderBy('a.updatedAt', 'DESC')
      .take(100)
      .getMany();

    const all = [...pending, ...accepted, ...rejected];
    const assayerIds = [...new Set(all.map((a) => a.assayerId))];
    const channels = await this.resolveChannels(assayerIds);

    // Client reference base fees, latest configuration per client — feeds the deviation guard.
    const clientIds = [...new Set(all.map((a) => (a as any).project?.clientId).filter(Boolean))] as string[];
    const rateRows: Array<{ client_id: string; default_base_fee: string | null }> = clientIds.length
      ? await this.dataSource.query(
          `SELECT DISTINCT ON (client_id) client_id, default_base_fee
             FROM client_configurations WHERE client_id = ANY($1)
            ORDER BY client_id, effective_from DESC`,
          [clientIds],
        )
      : [];
    const clientBaseFees = new Map(rateRows.map((r) => [r.client_id, r.default_base_fee != null ? Number(r.default_base_fee) : null]));

    // Call attempts per assignment, via its assessment (call_logs are assessment-keyed), counted
    // only since the offer was made — a call about last month's audit is not a chase on this one.
    const assessmentIds = [...new Set(all.map((a) => a.assessmentId).filter(Boolean))] as string[];
    const callRows: Array<{ assessment_id: string; assessor_id: string; attempts: string; last_outcome: string }> =
      assessmentIds.length
        ? await this.dataSource.query(
            `SELECT assessment_id, assessor_id, COUNT(*) AS attempts,
                    (ARRAY_AGG(outcome ORDER BY timestamp DESC))[1] AS last_outcome
               FROM call_logs
              WHERE assessment_id = ANY($1) AND is_active = true
              GROUP BY assessment_id, assessor_id`,
            [assessmentIds],
          )
        : [];
    const callsByKey = new Map(callRows.map((r) => [`${r.assessment_id}:${r.assessor_id}`, r]));

    const toItem = (a: AssignmentEntity): InboxAssignment => {
      const call = a.assessmentId ? callsByKey.get(`${a.assessmentId}:${a.assayerId}`) : undefined;
      return {
        id: a.id,
        assignmentNumber: a.assignmentNumber,
        projectBranchId: a.projectBranchId,
        branchName: a.projectBranch?.branch?.name ?? null,
        branchCity: a.projectBranch?.branch?.city ?? null,
        branchId: a.projectBranch?.branch?.id ?? null,
        projectName: (a as any).project?.name ?? null,
        assayerId: a.assayerId,
        assayerName: a.assayer?.displayName ?? null,
        assayerPhone: a.assayer?.phone ?? null,
        channel: channels.get(a.assayerId) ?? 'PHONE',
        proposedFee: a.proposedFee != null ? Number(a.proposedFee) : null,
        agreedFee: a.agreedFee != null ? Number(a.agreedFee) : null,
        clientBaseFee: clientBaseFees.get((a as any).project?.clientId) ?? null,
        feeFlagged: (() => {
          const ref = clientBaseFees.get((a as any).project?.clientId);
          const fee = a.proposedFee != null ? Number(a.proposedFee) : null;
          return ref != null && ref > 0 && fee != null && fee > ref * FEE_FLAG_MULTIPLIER;
        })(),
        negotiationCount: a.negotiationCount ?? 0,
        scheduledDate: a.scheduledDate ? String(a.scheduledDate).slice(0, 10) : null,
        ageHours: Math.round((now - new Date(a.createdAt).getTime()) / 3_600_000),
        callAttempts: call ? Number(call.attempts) : 0,
        lastCallOutcome: call?.last_outcome ?? null,
        rejectReason: a.rejectReason,
      };
    };

    const callTasks: InboxAssignment[] = [];
    const negotiations: InboxAssignment[] = [];
    let waitingOnApp = 0;

    for (const a of pending) {
      const item = toItem(a);
      if (item.negotiationCount > 0) {
        // A counter is in play. In-app counters await the desk's answer; phone-channel counters
        // are still a call to finish.
        negotiations.push(item);
      } else if (item.channel === 'PHONE') {
        callTasks.push(item);
      } else if (item.ageHours >= APP_SILENCE_HOURS) {
        // App offer gone quiet — falls back to the phone lane rather than waiting forever.
        callTasks.push(item);
      } else {
        waitingOnApp += 1;
      }
    }

    const scheduleRows: Array<{ assignment_id: string }> = accepted.length
      ? await this.dataSource.query(
          `SELECT assignment_id FROM schedules WHERE assignment_id = ANY($1) AND is_active = true`,
          [accepted.map((a) => a.id)],
        )
      : [];
    const scheduled = new Set(scheduleRows.map((r) => r.assignment_id));

    const unscheduled: InboxAssignment[] = [];
    const overdue: InboxAssignment[] = [];
    for (const a of accepted) {
      const item = toItem(a);
      const isOverdue = item.scheduledDate != null && item.scheduledDate < todayKey;
      if (isOverdue) overdue.push(item);
      else if (!scheduled.has(a.id)) unscheduled.push(item);
    }

    return {
      callTasks,
      negotiations,
      replacements: rejected.map(toItem),
      unscheduled,
      overdue,
      waitingOnApp,
    };
  }
}
