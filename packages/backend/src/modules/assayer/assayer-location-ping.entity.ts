import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { AssayerEntity } from './assayer.entity';

/**
 * How a position came to be recorded. The distinction matters when the trail is used as evidence:
 * a check-in fix was taken under a human action at a known place, an app fix was taken by a timer.
 */
export enum LocationPingSource {
  /** Periodic fix pushed by the field app while tracking is on. */
  APP_TRACKING = 'APP_TRACKING',
  /** The fix captured at the moment of a branch check-in. Always trustworthy in time and place. */
  CHECK_IN = 'CHECK_IN',
  /** Staff recorded a position on the assayer's behalf (correction, phone-channel assayer). */
  STAFF_RECORDED = 'STAFF_RECORDED',
}

/**
 * One observed position of one assayer at one moment. Append-only.
 *
 * The platform previously kept a single `live_location` column on `assayers`, overwritten by every
 * push. That answers "where are they now?" and nothing else — there was no way to establish that a
 * journey happened, which is exactly what a travel allowance is paid for. `assayer_payables` has a
 * `travel_amount` column, and the distance behind it is computed at quote time from the assayer's
 * *registered home address* to the branch: a claimed distance, never an observed one, and not even
 * persisted afterwards. Nothing in the system could contradict a journey that never took place.
 *
 * This table is the missing evidence. It is deliberately raw: fixes are stored as reported, with
 * their accuracy and both clocks, and no filtering or smoothing is applied on write. Judgement
 * about what a set of fixes *means* belongs to TravelVerificationService, which can then be
 * changed and re-run over the same history. Cleaning data on the way in would destroy the record
 * an audit needs.
 *
 * Retention: this is movement data about identifiable workers, so it is not kept indefinitely.
 * See the retention note on `recordedAt` below.
 */
@Entity('assayer_location_pings')
/**
 * One index doing two jobs: the ordered range read every verification performs (one assayer's
 * fixes across a window), and the dedupe that keeps a re-sent batch from being counted twice.
 *
 * Declared **here** rather than only in the migration, and that is deliberate. Dev runs with
 * `DB_SYNCHRONIZE=true`, and synchronize rebuilds this table from the decorators — silently
 * dropping any index the migration created but the entity does not declare. That is not
 * hypothetical: the unique index was written as migration-only first, synchronize removed it, and
 * a retried upload duly inserted the same 46 fixes a second time, doubling the distance the whole
 * feature exists to check. A guarantee that a dev environment quietly deletes is not a guarantee.
 */
@Index('uq_location_pings_assayer_instant', ['assayerId', 'recordedAt'], { unique: true })
// The per-assignment read, for fixes explicitly tagged to a job.
@Index('idx_location_pings_assignment', ['assignmentId'])
export class AssayerLocationPingEntity extends BaseEntity {
  @Column({ name: 'assayer_id', type: 'uuid' })
  assayerId: string;

  @ManyToOne(() => AssayerEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assayer_id' })
  assayer: AssayerEntity;

  /**
   * The job in progress when the fix was taken, where the device knew it. Nullable on purpose:
   * a fix taken between jobs is still part of the day's movement, and a verification that only
   * looked at tagged fixes would miss the outbound journey — which is the part being paid for.
   */
  @Column({ name: 'assignment_id', type: 'uuid', nullable: true })
  assignmentId: string | null;

  @Column({ type: 'decimal', precision: 10, scale: 7 })
  latitude: number;

  @Column({ type: 'decimal', precision: 10, scale: 7 })
  longitude: number;

  /**
   * PostGIS point, maintained alongside the numeric pair so spatial queries can use an index —
   * the same arrangement `assayers.location` uses (see the geography index added in
   * 1789000000000, and the pre-filter that depends on it).
   */
  @Column({ type: 'geometry', spatialFeatureType: 'Point', srid: 4326, nullable: true })
  location: any | null;

  /**
   * Reported horizontal accuracy in metres. Kept because it decides whether a fix can be trusted
   * to contribute distance: a 2 km-accurate fix in a rural cell-tower area is not evidence of
   * having moved 2 km. Null when the platform did not report one.
   */
  @Column({ name: 'accuracy_meters', type: 'int', nullable: true })
  accuracyMeters: number | null;

  /** Reported ground speed in m/s where the platform provided it. A cross-check on the maths. */
  @Column({ name: 'speed_mps', type: 'decimal', precision: 8, scale: 2, nullable: true })
  speedMps: number | null;

  /**
   * When the device says the fix was taken.
   *
   * Retention anchor: this column is what a purge job would range over, and it is what the
   * verification windows are expressed in. Device-supplied and therefore not authoritative —
   * compare with `receivedAt` before trusting it (see the entity docblock).
   */
  @Column({ name: 'recorded_at', type: 'timestamptz' })
  recordedAt: Date;

  /**
   * When the server accepted it. Server-clocked, so it cannot be moved by the handset.
   *
   * The pair (recordedAt, receivedAt) is the cheapest tamper signal available: a batch of fixes
   * claiming to span this morning but all received in one burst this evening is a device that was
   * offline — ordinary and fine — while a fix whose device clock is *ahead* of the server, or a
   * long trail uploaded moments after an assignment closed, is worth a human look.
   */
  @Column({ name: 'received_at', type: 'timestamptz', default: () => 'now()' })
  receivedAt: Date;

  @Column({ type: 'varchar', length: 20, default: LocationPingSource.APP_TRACKING })
  source: LocationPingSource;

  /**
   * The OS reported this position as coming from a mock provider.
   *
   * Android exposes this and it is the single most direct answer to "was this location faked?".
   * Stored rather than acted on: one mocked fix is recorded and surfaced, never silently dropped
   * (dropping it would hide the strongest evidence there is) and never used to withhold pay on
   * its own — developer-options mocking is also switched on by people who are not committing
   * fraud, and the accusation is a manager's to make, not the scheduler's.
   */
  @Column({ name: 'is_mocked', type: 'boolean', default: false })
  isMocked: boolean;
}
