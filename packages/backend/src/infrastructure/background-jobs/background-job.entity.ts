import {
  Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';
import type {
  BackgroundJobKind, BackgroundJobProgress, BackgroundJobResult, BackgroundJobStatus,
} from '@fapoms/shared';
import type { JobActor } from '../queue/job-actor';

/** One file of a several-file upload, as stored. */
export interface StoredInputObject {
  key: string;
  fileName: string;
  mimeType: string | null;
  size: number;
  sha256: string;
}

/**
 * One piece of work the server accepted and is doing in the background — see
 * `@fapoms/shared/background-jobs` for the vocabulary and `BackgroundJobsService` for the lifecycle.
 *
 * The row, not Bull, is the truth. Bull is how a worker is woken; it keeps a job for a while and
 * then forgets it, and a Redis flush forgets everything. The row is what every screen reads, what
 * survives a refresh, a deploy and a Redis restart, and what the recovery sweep reconciles Bull
 * against.
 *
 * The indexes are declared here as well as in the migration for the reason `outbound_messages`
 * gives: a `synchronize` environment rebuilds from entities and would otherwise drop them — and two
 * of them are not performance, they are the dedupe and one-at-a-time rules themselves.
 */
@Entity('background_jobs')
@Index('uq_background_jobs_dedupe_open', ['dedupeKey'], {
  unique: true,
  where: `"status" IN ('QUEUED', 'RUNNING', 'AWAITING_REVIEW') AND "dedupe_key" IS NOT NULL`,
})
@Index('uq_background_jobs_exclusive_running', ['exclusiveKey'], {
  unique: true,
  where: `"status" = 'RUNNING' AND "exclusive_key" IS NOT NULL`,
})
@Index('idx_background_jobs_requester', ['requestedBy', 'createdAt'])
@Index('idx_background_jobs_open', ['status', 'updatedAt'], {
  where: `"status" IN ('QUEUED', 'RUNNING', 'AWAITING_REVIEW')`,
})
@Index('idx_background_jobs_finished', ['finishedAt'], { where: `"finished_at" IS NOT NULL` })
export class BackgroundJobEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 64 })
  kind: BackgroundJobKind;

  @Column({ type: 'varchar', length: 24, default: 'QUEUED' })
  status: BackgroundJobStatus;

  @Column({ type: 'varchar', length: 300 })
  title: string;

  /** The person who started it: the only non-administrator who may see it. */
  @Column({ name: 'requested_by', type: 'uuid' })
  requestedBy: string;

  /**
   * Who it runs as, snapshotted in the request — every role (tenant scoping reads the whole list),
   * the organisation and the display name. A worker has no request to read these from.
   */
  @Column({ type: 'jsonb' })
  actor: JobActor;

  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  @Column({ name: 'scope_type', type: 'varchar', length: 32, nullable: true })
  scopeType: string | null;

  @Column({ name: 'scope_id', type: 'varchar', length: 64, nullable: true })
  scopeId: string | null;

  /**
   * The requester's regions at the moment they started it, or null for an unrestricted account.
   * Captured because the worker has no principal to ask, and because a regional administrator's
   * view of other people's jobs is decided by it.
   */
  @Column({ type: 'text', array: true, nullable: true })
  regions: string[] | null;

  /** The kind's own parameters, as the requester sent them. */
  @Column({ type: 'jsonb', nullable: true })
  params: Record<string, unknown> | null;

  @Column({ type: 'jsonb' })
  progress: BackgroundJobProgress;

  @Column({ type: 'jsonb', nullable: true })
  result: BackgroundJobResult | null;

  /** A row-level report too large for `result`, in object storage. */
  @Column({ name: 'result_object_key', type: 'text', nullable: true })
  resultObjectKey: string | null;

  @Column({ name: 'result_file_name', type: 'varchar', length: 255, nullable: true })
  resultFileName: string | null;

  @Column({ name: 'result_mime_type', type: 'varchar', length: 128, nullable: true })
  resultMimeType: string | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  /** The uploaded file, stored BEFORE the row was written — the job never carries bytes. */
  @Column({ name: 'input_object_key', type: 'text', nullable: true })
  inputObjectKey: string | null;

  @Column({ name: 'input_file_name', type: 'varchar', length: 255, nullable: true })
  inputFileName: string | null;

  @Column({ name: 'input_mime_type', type: 'varchar', length: 128, nullable: true })
  inputMimeType: string | null;

  @Column({ name: 'input_sha256', type: 'char', length: 64, nullable: true })
  inputSha256: string | null;

  @Column({ name: 'input_size', type: 'bigint', nullable: true })
  inputSize: string | null;

  /**
   * A job uploaded as several files (a batch of audit packets): each stored before the row was
   * written, like `inputObjectKey`. Null for a single-file or file-less job. `inputSize` is their
   * total and `inputSha256` a digest over their digests, in upload order.
   */
  @Column({ name: 'input_objects', type: 'jsonb', nullable: true })
  inputObjects: StoredInputObject[] | null;

  /**
   * The feature Bull queue that runs this job, when it is not the foundation's own `tracked-jobs`
   * queue — a bulk action or export that keeps its queue and is only tracked here. Null otherwise.
   * See `BackgroundJobsService.enqueueTracked`.
   */
  @Column({ name: 'runner_queue', type: 'varchar', length: 64, nullable: true })
  runnerQueue: string | null;

  /** Same person + kind + scope + file + parameters, unique while the job is open. */
  @Column({ name: 'dedupe_key', type: 'varchar', length: 128, nullable: true })
  dedupeKey: string | null;

  /** Kinds that must run one at a time (per kind, or per scope) share this while RUNNING. */
  @Column({ name: 'exclusive_key', type: 'varchar', length: 200, nullable: true })
  exclusiveKey: string | null;

  @Column({ name: 'parent_job_id', type: 'uuid', nullable: true })
  parentJobId: string | null;

  /** The Bull job currently carrying it — changes if it is deferred or re-enqueued. */
  @Column({ name: 'bull_job_id', type: 'varchar', length: 128, nullable: true })
  bullJobId: string | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'cancel_requested_at', type: 'timestamptz', nullable: true })
  cancelRequestedAt: Date | null;

  @Column({ name: 'cancel_requested_by', type: 'uuid', nullable: true })
  cancelRequestedBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
