import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { BillingJobsWorker } from './billing-jobs.worker';
import { BillingJobsService } from './billing-jobs.service';
import { BillingEngineService } from './billing-engine.service';
import {
  BILLING_JOB,
  BILLING_QUEUE,
  BOOK_ASSIGNMENT_JOB_OPTIONS,
} from './billing-jobs.contract';

describe('BillingJobsWorker & BillingJobsService (Financial Processing Durability)', () => {
  let worker: BillingJobsWorker;
  let service: BillingJobsService;
  let billingEngine: { bookAssignment: jest.Mock };
  let queue: { add: jest.Mock; getJob: jest.Mock; getJobs: jest.Mock };

  beforeEach(async () => {
    billingEngine = {
      bookAssignment: jest.fn(),
    };

    queue = {
      add: jest.fn(),
      getJob: jest.fn(),
      getJobs: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingJobsWorker,
        BillingJobsService,
        {
          provide: BillingEngineService,
          useValue: billingEngine,
        },
        {
          provide: getQueueToken(BILLING_QUEUE),
          useValue: queue,
        },
      ],
    }).compile();

    worker = module.get<BillingJobsWorker>(BillingJobsWorker);
    service = module.get<BillingJobsService>(BillingJobsService);
  });

  describe('BillingJobsService.enqueueBookAssignment', () => {
    /**
     * The job id keys on the completion EVENT, not the assignment.
     *
     * Bull refuses a job whose id already exists, which is what makes this idempotent against a
     * redelivered event. Keyed on the assignment, that same mechanism silently dropped every
     * booking after the first one the assignment ever had: an audit reopened, redone and
     * completed again enqueued a job with the id of the first — already succeeded — and Bull
     * discarded it without a word, so the assayer was never paid for the work they redid.
     */
    it('keys the job on the completion event, so a redo is a new job', async () => {
      const mockJob = { id: 'book-assignment:outbox-uuid-1' };
      queue.add.mockResolvedValueOnce(mockJob);

      const job = await service.enqueueBookAssignment('asn-123', 'user-1', 'outbox-uuid-1');

      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        BILLING_JOB.BOOK_ASSIGNMENT,
        { assignmentId: 'asn-123', userId: 'user-1', outboxEventId: 'outbox-uuid-1' },
        expect.objectContaining({
          jobId: 'book-assignment:outbox-uuid-1',
          attempts: 5,
          backoff: { type: 'exponential', delay: 2000 },
          timeout: 60000,
        }),
      );
      expect(job).toBe(mockJob);
    });

    /**
     * Two completions of one assignment — the original and the redo after a reopen — carry
     * different event ids and must therefore produce different jobs. This is the case the old
     * key could not express, and the one the assayer's pay depends on.
     */
    it('gives a redo of the same assignment its own job', async () => {
      queue.add.mockResolvedValue({ id: 'x' });

      await service.enqueueBookAssignment('asn-123', 'user-1', 'event-first-completion');
      await service.enqueueBookAssignment('asn-123', 'user-1', 'event-after-redo');

      const jobIds = queue.add.mock.calls.map((c: any[]) => c[2].jobId);
      expect(jobIds).toEqual(['book-assignment:event-first-completion', 'book-assignment:event-after-redo']);
      expect(new Set(jobIds).size).toBe(2);
    });

    /**
     * And the redelivery it protects against still collapses: the at-least-once bus replaying one
     * event twice yields one job id, so Bull drops the second and the assignment is booked once.
     */
    it('gives a redelivery of the SAME completion event the same job id', async () => {
      queue.add.mockResolvedValue({ id: 'x' });

      await service.enqueueBookAssignment('asn-123', 'user-1', 'event-one');
      await service.enqueueBookAssignment('asn-123', 'user-1', 'event-one');

      const jobIds = queue.add.mock.calls.map((c: any[]) => c[2].jobId);
      expect(new Set(jobIds).size).toBe(1);
    });

    /** No event id (a direct or legacy call) keeps the old key rather than becoming unbounded. */
    it('falls back to the assignment id when there is no event id', async () => {
      queue.add.mockResolvedValue({ id: 'x' });
      await service.enqueueBookAssignment('asn-123', 'user-1');
      expect(queue.add.mock.calls[0][2].jobId).toBe('book-assignment:asn-123');
    });

    it('removes a dead/failed job with same ID so manual replay or relay can enqueue cleanly', async () => {
      const deadJob = {
        id: 'book-assignment:asn-123',
        getState: jest.fn().mockResolvedValue('failed'),
        failedReason: 'deadlock after 5 attempts',
        remove: jest.fn().mockResolvedValue(undefined),
      };
      queue.getJob.mockResolvedValueOnce(deadJob);
      const newJob = { id: 'book-assignment:asn-123' };
      queue.add.mockResolvedValueOnce(newJob);

      const job = await service.enqueueBookAssignment('asn-123', 'operator-replay');

      expect(queue.getJob).toHaveBeenCalledWith('book-assignment:asn-123');
      expect(deadJob.remove).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(job).toBe(newJob);
    });
  });

  describe('BillingJobsWorker.bookAssignment', () => {
    const makeJob = (data: { assignmentId: string; userId?: string }, attemptsMade = 0) =>
      ({
        id: `book-assignment:${data.assignmentId}`,
        data,
        attemptsMade,
      } as any);

    it('successfully books assignment and returns result', async () => {
      billingEngine.bookAssignment.mockResolvedValueOnce({
        booked: true,
        entryId: 'entry-1',
        payableId: 'payable-1',
      });

      const job = makeJob({ assignmentId: 'asn-1', userId: 'user-1' });
      const result = await worker.bookAssignment(job);

      expect(billingEngine.bookAssignment).toHaveBeenCalledWith('asn-1', 'user-1');
      expect(result).toEqual({
        booked: true,
        entryId: 'entry-1',
        payableId: 'payable-1',
      });
    });

    it('gracefully completes without error on already-booked duplicate runs', async () => {
      billingEngine.bookAssignment.mockResolvedValueOnce({
        booked: false,
        reason: 'already booked',
        entryId: 'entry-1',
        payableId: 'payable-1',
      });

      const job = makeJob({ assignmentId: 'asn-1' });
      const result = await worker.bookAssignment(job);

      expect(result).toMatchObject({
        booked: false,
        reason: 'already booked',
      });
    });

    it('gracefully completes without error on concurrent booking race caught by unique constraints', async () => {
      billingEngine.bookAssignment.mockResolvedValueOnce({
        booked: false,
        reason: 'already booked (concurrent)',
        entryId: 'entry-1',
        payableId: 'payable-1',
      });

      const job = makeJob({ assignmentId: 'asn-1' });
      const result = await worker.bookAssignment(job);

      expect(result).toMatchObject({
        booked: false,
        reason: 'already booked (concurrent)',
      });
    });

    it('gracefully completes without retry loop on benign NO_FEE assignments', async () => {
      billingEngine.bookAssignment.mockResolvedValueOnce({
        booked: false,
        reason: 'NO_FEE',
      });

      const job = makeJob({ assignmentId: 'asn-1' });
      const result = await worker.bookAssignment(job);

      expect(result).toMatchObject({
        booked: false,
        reason: 'NO_FEE',
      });
    });

    it.each([
      'assignment not found',
      'assignment not completed',
      'no assayer on assignment',
      'no client for assignment',
    ])('throws on missing prerequisite "%s" so the job fails visibly in the operational failure queue', async (prerequisiteReason) => {
      billingEngine.bookAssignment.mockResolvedValueOnce({
        booked: false,
        reason: prerequisiteReason,
      });

      const job = makeJob({ assignmentId: 'asn-1' });
      await expect(worker.bookAssignment(job)).rejects.toThrow(
        `Billing booking prerequisite failed: ${prerequisiteReason}`,
      );
    });

    it('throws on unexpected booking failure so BullMQ applies exponential backoff retry', async () => {
      billingEngine.bookAssignment.mockResolvedValueOnce({
        booked: false,
        reason: 'database deadlock',
      });

      const job = makeJob({ assignmentId: 'asn-1' });
      await expect(worker.bookAssignment(job)).rejects.toThrow('Billing booking prerequisite failed: database deadlock');
    });

    it('propagates unhandled database exception to BullMQ for retry', async () => {
      billingEngine.bookAssignment.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));

      const job = makeJob({ assignmentId: 'asn-1' });
      await expect(worker.bookAssignment(job)).rejects.toThrow('Connection terminated unexpectedly');
    });
  });
});
