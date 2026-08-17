import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { EventCategory } from '@fapoms/shared';

import { AssayerRemarkEntity } from '../assayer/assayer-remark.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { AssayerActivityEntity } from '../assayer/assayer-activity.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AssayerService } from '../assayer/assayer.service';
import { AuditService } from '../../core/audit/audit.service';
import {
  AssayerRemarkCategory,
  REMARK_MODERATE_ROLES,
  REMARK_RATING_MAX,
  REMARK_RATING_MIN,
  REMARK_SCORING_WINDOW_DAYS,
  REMARK_TEXT_MAX,
  RemarkForScoring,
  RemarkSummary,
  snapshotAuthorRole,
  summariseRemarks,
} from './assayer-remark.contract';

/** Who is acting. Built by the controller from `req.user`; never trusted from the body. */
export interface RemarkActor {
  userId: string;
  displayName: string;
  /** Role names as strings — the guard has already matched them against SystemRole. */
  roleNames: string[];
  ipAddress?: string;
}

export interface CreateRemarkInput {
  assayerId: string;
  rating: number;
  category: AssayerRemarkCategory;
  text: string;
  assignmentId?: string | null;
}

/**
 * Staff remarks about assayers: written by the desks that deal with them, read by every staff
 * role, and folded into recommendations as one bounded, recency-weighted dimension.
 *
 * ## The rules this service holds
 *
 *  - Every remark is attributed: author id, author display name and the role they held when
 *    they wrote it are stored on the row, and the audit trail records the same event. There is
 *    no anonymous remark and no way to make one.
 *  - Ratings are integers in [-2, +2]. Validated here, and again by a CHECK constraint, because
 *    the scorer's "bounded by construction" promise rests on that range.
 *  - A remark may cite the assignment it is about, but only if that assignment belongs to the
 *    same assayer — a remark about job X pinned to the wrong person is worse than no link.
 *  - Removal is a soft delete by the author or by a moderator role, audited either way. Nothing
 *    is ever hard-deleted from here; the trail is the point.
 *  - Remarks are staff-internal. `visibility` is always INTERNAL from this path; the mobile app
 *    has no route to read them.
 */
@Injectable()
export class AssayerRemarksService {
  constructor(
    @InjectRepository(AssayerRemarkEntity)
    private readonly remarkRepository: Repository<AssayerRemarkEntity>,
    @InjectRepository(AssayerEntity)
    private readonly assayerRepository: Repository<AssayerEntity>,
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
    @InjectRepository(AssayerActivityEntity)
    private readonly activityRepository: Repository<AssayerActivityEntity>,
    private readonly auditService: AuditService,
    /**
     * Only for `recomputeAverageRating`: the profile's cached 1–5 figure is derived from these
     * rows and would otherwise lag until the next assignment transition refreshed it.
     */
    private readonly assayerService: AssayerService,
  ) {}

  /**
   * Everything live about one assayer, newest first, plus the summary the engine would compute
   * for them right now — so what the drawer shows and what the ranking used are the same number.
   */
  async listForAssayer(
    assayerId: string,
    limit = 100,
  ): Promise<{ remarks: AssayerRemarkEntity[]; summary: RemarkSummary }> {
    const remarks = await this.remarkRepository.find({
      where: { assayerId, isActive: true },
      order: { createdAt: 'DESC' },
      take: Math.max(1, Math.min(500, limit)),
    });
    return { remarks, summary: summariseRemarks(remarks) };
  }

  async create(input: CreateRemarkInput, actor: RemarkActor): Promise<AssayerRemarkEntity> {
    const text = (input.text ?? '').trim();
    if (!text) throw new BadRequestException('A remark needs some text.');
    if (text.length > REMARK_TEXT_MAX) {
      throw new BadRequestException(`A remark is at most ${REMARK_TEXT_MAX} characters.`);
    }
    const rating = Number(input.rating);
    if (!Number.isInteger(rating) || rating < REMARK_RATING_MIN || rating > REMARK_RATING_MAX) {
      throw new BadRequestException(`Rating must be a whole number from ${REMARK_RATING_MIN} to +${REMARK_RATING_MAX}.`);
    }
    if (!Object.values(AssayerRemarkCategory).includes(input.category)) {
      throw new BadRequestException(`Unknown remark category "${input.category}".`);
    }

    const assayer = await this.assayerRepository.findOne({
      where: { id: input.assayerId, isActive: true },
      select: ['id', 'displayName'] as any,
    });
    if (!assayer) throw new NotFoundException(`Assayer ${input.assayerId} not found.`);

    let assignmentId: string | null = null;
    if (input.assignmentId) {
      const assignment = await this.assignmentRepository.findOne({
        where: { id: input.assignmentId, isActive: true },
        select: ['id', 'assayerId', 'assignmentNumber'] as any,
      });
      if (!assignment) throw new NotFoundException(`Assignment ${input.assignmentId} not found.`);
      if (assignment.assayerId !== input.assayerId) {
        throw new BadRequestException('That assignment belongs to a different assayer.');
      }
      assignmentId = assignment.id;
    }

    const authorRole = snapshotAuthorRole(actor.roleNames);
    const saved = await this.remarkRepository.save(
      this.remarkRepository.create({
        assayerId: input.assayerId,
        authorId: actor.userId,
        authorName: actor.displayName,
        authorRole,
        content: text,
        category: input.category,
        // Staff-internal by construction — see the class comment.
        visibility: 'INTERNAL',
        attachmentPaths: [],
        rating,
        assignmentId,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      }),
    );

    // Same event names the older remark path used, so one filter in the trail finds both.
    await this.auditService.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSAYER_REMARK_ADDED',
      entityType: 'ASSAYER_REMARK',
      entityId: saved.id,
      userId: actor.userId,
      userDisplayName: actor.displayName,
      ipAddress: actor.ipAddress,
      remarks: `${signed(rating)} ${input.category} remark on ${assayer.displayName}`,
      metadata: {
        assayerId: input.assayerId,
        rating,
        category: input.category,
        authorRole,
        assignmentId,
      },
    });
    await this.recordActivity(
      input.assayerId,
      'ASSAYER_REMARK_ADDED',
      actor,
      `${signed(rating)} ${input.category.toLowerCase()} remark: ${text.length > 120 ? `${text.slice(0, 117)}…` : text}`,
    );
    await this.refreshCachedRating(input.assayerId);

    return saved;
  }

  /**
   * Soft-delete. The author may retract their own; a moderator may remove anyone's. Both are
   * recorded with who did it and why it was allowed.
   */
  async remove(remarkId: string, actor: RemarkActor): Promise<void> {
    const remark = await this.remarkRepository.findOne({ where: { id: remarkId, isActive: true } });
    if (!remark) throw new NotFoundException(`Remark ${remarkId} not found.`);

    const isAuthor = remark.authorId === actor.userId;
    const isModerator = actor.roleNames.some((r) => (REMARK_MODERATE_ROLES as string[]).includes(r));
    if (!isAuthor && !isModerator) {
      throw new ForbiddenException('Only the author, HR, operations management or an administrator can remove a remark.');
    }

    remark.isActive = false;
    remark.updatedBy = actor.userId;
    await this.remarkRepository.save(remark);

    await this.auditService.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSAYER_REMARK_REMOVED',
      entityType: 'ASSAYER_REMARK',
      entityId: remark.id,
      userId: actor.userId,
      userDisplayName: actor.displayName,
      ipAddress: actor.ipAddress,
      remarks: isAuthor ? 'Retracted by its author' : 'Removed by a moderator',
      metadata: {
        assayerId: remark.assayerId,
        rating: remark.rating,
        category: remark.category,
        originalAuthorId: remark.authorId,
        removedAs: isAuthor ? 'AUTHOR' : 'MODERATOR',
      },
    });
    await this.recordActivity(
      remark.assayerId,
      'ASSAYER_REMARK_REMOVED',
      actor,
      isAuthor ? 'Remark retracted by its author' : 'Remark removed by a moderator',
    );
    await this.refreshCachedRating(remark.assayerId);
  }

  /**
   * The rated remarks inside the scoring window for a whole candidate pool, in ONE query, keyed
   * by assayer and newest first.
   *
   * This is the only way the recommendation engine reads remarks. It is called once per
   * recommendation with every candidate id, never once per candidate — the engine was just
   * cleared of exactly that pattern and this must not put it back. Only the columns the scorer
   * and the card need are selected; a remark's text is small but a national pool's worth of
   * them is not.
   */
  async loadScoringWindow(
    assayerIds: string[],
    now: Date = new Date(),
  ): Promise<Record<string, RemarkForScoring[]>> {
    const out: Record<string, RemarkForScoring[]> = {};
    if (assayerIds.length === 0) return out;

    const since = new Date(now.getTime() - REMARK_SCORING_WINDOW_DAYS * 86_400_000);
    const rows = await this.remarkRepository.find({
      where: {
        assayerId: In(assayerIds),
        isActive: true,
        rating: Not(IsNull()),
        createdAt: MoreThanOrEqual(since),
      },
      select: ['assayerId', 'rating', 'category', 'content', 'authorRole', 'authorName', 'createdAt'] as any,
      order: { createdAt: 'DESC' },
    });

    for (const r of rows) {
      (out[r.assayerId] ||= []).push({
        rating: r.rating,
        category: r.category,
        content: r.content,
        authorRole: r.authorRole,
        authorName: r.authorName,
        createdAt: r.createdAt,
      });
    }
    return out;
  }

  /** The profile's cached 1–5 average; a derived figure, so a failure here is logged by nobody and undoes nothing. */
  private async refreshCachedRating(assayerId: string): Promise<void> {
    await this.assayerService.recomputeAverageRating(assayerId).catch(() => undefined);
  }

  /**
   * The drawer's History tab reads `assayer_activities`; the older remark path wrote there too,
   * but with `performedByName` left null so the row said "system". Filled in here.
   */
  private async recordActivity(assayerId: string, eventType: string, actor: RemarkActor, remarks: string): Promise<void> {
    await this.activityRepository
      .save(
        this.activityRepository.create({
          assayerId,
          eventType,
          previousState: null,
          newState: null,
          performedBy: actor.userId,
          performedByName: actor.displayName,
          remarks,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        }),
      )
      // The activity row is a convenience view; the audit trail above is the record. A failure
      // here must not undo a saved remark.
      .catch(() => undefined);
  }
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}
