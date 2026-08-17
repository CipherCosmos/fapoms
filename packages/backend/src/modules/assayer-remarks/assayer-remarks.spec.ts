import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { SystemRole } from '@fapoms/shared';

import { AssayerRemarksService } from './assayer-remarks.service';
import { AssayerRemarkEntity } from '../assayer/assayer-remark.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { AssayerActivityEntity } from '../assayer/assayer-activity.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AuditService } from '../../core/audit/audit.service';
import { AssayerService } from '../assayer/assayer.service';
import {
  AssayerRemarkCategory,
  DEFAULT_FAIRNESS_OFFER_CAP,
  REMARK_WRITE_ROLES,
  REMARK_MODERATE_ROLES,
  fairnessScoreFrom,
  remarksScoreFrom,
  snapshotAuthorRole,
  summariseRemarks,
} from './assayer-remark.contract';

const DAY = 86_400_000;
const at = (daysAgo: number, now = new Date('2026-08-17T12:00:00Z')) => new Date(now.getTime() - daysAgo * DAY);
const NOW = new Date('2026-08-17T12:00:00Z');

/**
 * The scoring maths, on its own. These are the numbers the recommendation engine folds in, so
 * each boundary is pinned: neutral with nothing said, the two extremes, the recency weighting,
 * the window cut-off, and — the property everything else rests on — boundedness.
 */
describe('remark scoring maths', () => {
  const remark = (rating: number, daysAgo: number, extra: Partial<{ category: string; content: string }> = {}) => ({
    rating,
    category: extra.category ?? 'QUALITY',
    content: extra.content ?? 'x',
    authorRole: 'OPERATIONS_EXECUTIVE',
    authorName: 'Ops',
    createdAt: at(daysAgo),
  });

  it('nothing said scores a neutral 50', () => {
    const summary = summariseRemarks([], NOW);
    expect(summary).toEqual({ count: 0, weightedMean: null, latest: null });
    expect(remarksScoreFrom(summary)).toBe(50);
  });

  it('all +2 → 100, all −2 → 0, a single 0 → 50', () => {
    expect(remarksScoreFrom(summariseRemarks([remark(2, 1), remark(2, 30)], NOW))).toBe(100);
    expect(remarksScoreFrom(summariseRemarks([remark(-2, 1), remark(-2, 200)], NOW))).toBe(0);
    expect(remarksScoreFrom(summariseRemarks([remark(0, 5)], NOW))).toBe(50);
  });

  it('is bounded to [0, 100] whatever is thrown at it', () => {
    // Out-of-range ratings cannot exist behind the CHECK constraint, but the maths must not
    // depend on that: clamp, then average.
    const wild = [remark(99, 1), remark(-99, 2), remark(7, 3)];
    const score = remarksScoreFrom(summariseRemarks(wild, NOW));
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    // A thousand −2s are still exactly 0, not below it.
    const flood = Array.from({ length: 1000 }, (_, i) => remark(-2, i % 300));
    expect(remarksScoreFrom(summariseRemarks(flood, NOW))).toBe(0);
  });

  it('weights a recent remark far above an old one: exp(-age/90)', () => {
    // A −2 yesterday against a +2 from 180 days ago. Weights ≈ 0.989 vs 0.135, so the mean is
    // ≈ (−2×0.989 + 2×0.135) / (0.989+0.135) ≈ −1.52, and the score ≈ 12.
    const s = summariseRemarks([remark(-2, 1), remark(2, 180)], NOW);
    expect(s.count).toBe(2);
    expect(s.weightedMean).toBeCloseTo(-1.52, 1);
    expect(remarksScoreFrom(s)).toBeCloseTo(12, 0);
    // Flip the ages and the same two remarks read as a strong positive.
    const flipped = summariseRemarks([remark(2, 1), remark(-2, 180)], NOW);
    expect(flipped.weightedMean).toBeCloseTo(1.52, 1);
  });

  it('ignores remarks older than 365 days and unrated notes', () => {
    const s = summariseRemarks([remark(-2, 400), { ...remark(0, 3), rating: null as any }, remark(2, 10)], NOW);
    expect(s.count).toBe(1);
    expect(s.weightedMean).toBe(2);
  });

  it('reports the latest rated remark so the card can show the words', () => {
    const s = summariseRemarks([
      remark(1, 30, { category: 'PAPERWORK', content: 'Tidy.' }),
      remark(-1, 2, { category: 'PUNCTUALITY', content: 'Late twice this week.' }),
    ], NOW);
    expect(s.latest).toEqual(expect.objectContaining({
      rating: -1, category: 'PUNCTUALITY', text: 'Late twice this week.', authorRole: 'OPERATIONS_EXECUTIVE',
    }));
  });

  it('fairness: 0 offers → 100, cap → 0, linear between, cap-safe', () => {
    expect(fairnessScoreFrom(0)).toBe(100);
    expect(fairnessScoreFrom(4)).toBe(50);
    expect(fairnessScoreFrom(DEFAULT_FAIRNESS_OFFER_CAP)).toBe(0);
    expect(fairnessScoreFrom(50)).toBe(0);
    expect(fairnessScoreFrom(2, 4)).toBe(50);
    // A broken cap (0, negative, NaN) falls back to the default instead of dividing by zero.
    expect(fairnessScoreFrom(4, 0)).toBe(50);
    expect(fairnessScoreFrom(4, NaN)).toBe(50);
    expect(fairnessScoreFrom(4, -3)).toBe(50);
  });

  it('records the most senior authorising role for a multi-role author', () => {
    expect(snapshotAuthorRole(['VALIDATOR', 'HR_MANAGER'])).toBe('HR_MANAGER');
    expect(snapshotAuthorRole(['OPERATIONS_EXECUTIVE'])).toBe('OPERATIONS_EXECUTIVE');
    expect(snapshotAuthorRole([])).toBeNull();
  });

  it('never lets an assayer or a client user write, and keeps moderation narrower than writing', () => {
    expect(REMARK_WRITE_ROLES).not.toContain(SystemRole.ASSAYER);
    expect(REMARK_WRITE_ROLES).not.toContain(SystemRole.CLIENT_USER);
    expect(REMARK_WRITE_ROLES).toContain(SystemRole.OPERATIONS_EXECUTIVE);
    expect(REMARK_WRITE_ROLES).toContain(SystemRole.DATA_ENTRY_HEAD);
    for (const r of REMARK_MODERATE_ROLES) expect(REMARK_WRITE_ROLES).toContain(r);
    expect(REMARK_MODERATE_ROLES).not.toContain(SystemRole.OPERATIONS_EXECUTIVE);
  });
});

describe('AssayerRemarksService', () => {
  let service: AssayerRemarksService;

  const remarkRepo = {
    create: jest.fn((x: any) => x),
    save: jest.fn(async (x: any) => ({ id: x.id ?? 'r-1', ...x })),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
  };
  const assayerRepo = { findOne: jest.fn() };
  const assignmentRepo = { findOne: jest.fn() };
  const activityRepo = { create: jest.fn((x: any) => x), save: jest.fn().mockResolvedValue({}) };
  const audit = { recordEventSafe: jest.fn().mockResolvedValue(undefined), recordEvent: jest.fn() };
  const assayerService = { recomputeAverageRating: jest.fn().mockResolvedValue(undefined) };

  const ops = { userId: 'u-ops', displayName: 'Priya (Ops)', roleNames: ['OPERATIONS_EXECUTIVE'] };
  const hr = { userId: 'u-hr', displayName: 'Ravi (HR)', roleNames: ['HR_MANAGER'] };
  const validator = { userId: 'u-val', displayName: 'Meena', roleNames: ['VALIDATOR'] };

  beforeEach(async () => {
    jest.clearAllMocks();
    remarkRepo.create.mockImplementation((x: any) => x);
    remarkRepo.save.mockImplementation(async (x: any) => ({ id: x.id ?? 'r-1', ...x }));
    remarkRepo.find.mockResolvedValue([]);
    activityRepo.create.mockImplementation((x: any) => x);
    activityRepo.save.mockResolvedValue({});
    audit.recordEventSafe.mockResolvedValue(undefined);
    assayerService.recomputeAverageRating.mockResolvedValue(undefined);
    assayerRepo.findOne.mockResolvedValue({ id: 'as-1', displayName: 'Arjun' });

    const module = await Test.createTestingModule({
      providers: [
        AssayerRemarksService,
        { provide: getRepositoryToken(AssayerRemarkEntity), useValue: remarkRepo },
        { provide: getRepositoryToken(AssayerEntity), useValue: assayerRepo },
        { provide: getRepositoryToken(AssignmentEntity), useValue: assignmentRepo },
        { provide: getRepositoryToken(AssayerActivityEntity), useValue: activityRepo },
        { provide: AuditService, useValue: audit },
        { provide: AssayerService, useValue: assayerService },
      ],
    }).compile();
    service = module.get(AssayerRemarksService);
  });

  describe('create', () => {
    it('stores an attributed, internal, rated remark and audits it', async () => {
      const saved = await service.create(
        { assayerId: 'as-1', rating: -2, category: AssayerRemarkCategory.CONDUCT, text: '  Rude to the branch manager.  ' },
        ops,
      );
      expect(remarkRepo.save).toHaveBeenCalledWith(expect.objectContaining({
        assayerId: 'as-1',
        authorId: 'u-ops',
        authorName: 'Priya (Ops)',
        authorRole: 'OPERATIONS_EXECUTIVE',
        rating: -2,
        category: 'CONDUCT',
        content: 'Rude to the branch manager.',
        visibility: 'INTERNAL',
        assignmentId: null,
      }));
      expect(saved.id).toBe('r-1');
      expect(audit.recordEventSafe).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'ASSAYER_REMARK_ADDED',
        entityType: 'ASSAYER_REMARK',
        entityId: 'r-1',
        userId: 'u-ops',
        metadata: expect.objectContaining({ assayerId: 'as-1', rating: -2, category: 'CONDUCT', authorRole: 'OPERATIONS_EXECUTIVE' }),
      }));
      // The drawer's History tab gets a row that names the author, not "system".
      expect(activityRepo.save).toHaveBeenCalledWith(expect.objectContaining({
        assayerId: 'as-1', eventType: 'ASSAYER_REMARK_ADDED', performedBy: 'u-ops', performedByName: 'Priya (Ops)',
      }));
      // And the profile's cached 1–5 figure is refreshed straight away.
      expect(assayerService.recomputeAverageRating).toHaveBeenCalledWith('as-1');
    });

    it('refuses an out-of-range or fractional rating', async () => {
      for (const rating of [3, -3, 1.5, NaN]) {
        await expect(service.create({ assayerId: 'as-1', rating, category: AssayerRemarkCategory.OTHER, text: 'x' }, ops))
          .rejects.toBeInstanceOf(BadRequestException);
      }
      expect(remarkRepo.save).not.toHaveBeenCalled();
    });

    it('refuses empty or over-long text and unknown categories', async () => {
      await expect(service.create({ assayerId: 'as-1', rating: 0, category: AssayerRemarkCategory.OTHER, text: '   ' }, ops))
        .rejects.toBeInstanceOf(BadRequestException);
      await expect(service.create({ assayerId: 'as-1', rating: 0, category: AssayerRemarkCategory.OTHER, text: 'x'.repeat(1001) }, ops))
        .rejects.toBeInstanceOf(BadRequestException);
      await expect(service.create({ assayerId: 'as-1', rating: 0, category: 'GOSSIP' as any, text: 'x' }, ops))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(remarkRepo.save).not.toHaveBeenCalled();
    });

    it('404s for an unknown assayer', async () => {
      assayerRepo.findOne.mockResolvedValue(null);
      await expect(service.create({ assayerId: 'nope', rating: 1, category: AssayerRemarkCategory.QUALITY, text: 'x' }, ops))
        .rejects.toBeInstanceOf(NotFoundException);
    });

    it('links an assignment only when it belongs to the same assayer', async () => {
      assignmentRepo.findOne.mockResolvedValue({ id: 'asg-1', assayerId: 'as-1', assignmentNumber: 'ASG-1' });
      await service.create({ assayerId: 'as-1', rating: 2, category: AssayerRemarkCategory.PAPERWORK, text: 'Spotless.', assignmentId: 'asg-1' }, validator);
      expect(remarkRepo.save).toHaveBeenCalledWith(expect.objectContaining({ assignmentId: 'asg-1', authorRole: 'VALIDATOR' }));

      assignmentRepo.findOne.mockResolvedValue({ id: 'asg-2', assayerId: 'someone-else', assignmentNumber: 'ASG-2' });
      await expect(service.create({ assayerId: 'as-1', rating: 2, category: AssayerRemarkCategory.PAPERWORK, text: 'x', assignmentId: 'asg-2' }, validator))
        .rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('remove', () => {
    const existing = () => ({ id: 'r-9', assayerId: 'as-1', authorId: 'u-ops', rating: -1, category: 'QUALITY', isActive: true });

    it('lets the author retract their own remark, soft-deleting and auditing it', async () => {
      remarkRepo.findOne.mockResolvedValue(existing());
      await service.remove('r-9', ops);
      expect(remarkRepo.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'r-9', isActive: false, updatedBy: 'u-ops' }));
      expect(audit.recordEventSafe).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'ASSAYER_REMARK_REMOVED', entityId: 'r-9', userId: 'u-ops',
        metadata: expect.objectContaining({ removedAs: 'AUTHOR', originalAuthorId: 'u-ops' }),
      }));
    });

    it('lets a moderator remove someone else\'s remark', async () => {
      remarkRepo.findOne.mockResolvedValue(existing());
      await service.remove('r-9', hr);
      expect(remarkRepo.save).toHaveBeenCalledWith(expect.objectContaining({ isActive: false }));
      expect(audit.recordEventSafe).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({ removedAs: 'MODERATOR' }),
      }));
    });

    it('refuses a non-author, non-moderator', async () => {
      remarkRepo.findOne.mockResolvedValue(existing());
      await expect(service.remove('r-9', validator)).rejects.toBeInstanceOf(ForbiddenException);
      expect(remarkRepo.save).not.toHaveBeenCalled();
      expect(audit.recordEventSafe).not.toHaveBeenCalled();
    });

    it('404s for a remark that is already gone', async () => {
      remarkRepo.findOne.mockResolvedValue(null);
      await expect(service.remove('r-9', hr)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('loadScoringWindow', () => {
    it('is one query for the whole pool, keyed by assayer, and skips an empty pool entirely', async () => {
      expect(await service.loadScoringWindow([])).toEqual({});
      expect(remarkRepo.find).not.toHaveBeenCalled();

      remarkRepo.find.mockResolvedValue([
        { assayerId: 'a', rating: 2, category: 'QUALITY', content: 'x', authorRole: 'VALIDATOR', authorName: 'M', createdAt: at(1) },
        { assayerId: 'b', rating: -1, category: 'CONDUCT', content: 'y', authorRole: null, authorName: 'P', createdAt: at(2) },
        { assayerId: 'a', rating: 0, category: 'OTHER', content: 'z', authorRole: 'HR_MANAGER', authorName: 'R', createdAt: at(3) },
      ]);
      const out = await service.loadScoringWindow(['a', 'b', 'c'], NOW);
      expect(remarkRepo.find).toHaveBeenCalledTimes(1);
      expect(Object.keys(out).sort()).toEqual(['a', 'b']);
      expect(out.a).toHaveLength(2);
      expect(out.b[0]).toEqual(expect.objectContaining({ rating: -1, category: 'CONDUCT' }));
    });
  });

  describe('listForAssayer', () => {
    it('returns the rows newest first with the same summary the engine scores from', async () => {
      remarkRepo.find.mockResolvedValue([
        { id: '1', assayerId: 'as-1', rating: -2, category: 'CONDUCT', content: 'a', authorRole: 'OPERATIONS_EXECUTIVE', authorName: 'P', createdAt: new Date() },
      ]);
      const { remarks, summary } = await service.listForAssayer('as-1');
      expect(remarks).toHaveLength(1);
      expect(summary.count).toBe(1);
      expect(summary.weightedMean).toBe(-2);
      expect(remarksScoreFrom(summary)).toBe(0);
    });
  });
});
