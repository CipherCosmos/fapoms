import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import {
  AssayerStatus, AssayerLifecycleStatus,
  AssayerEngagementType, AssayerUnavailableReason,
} from '@fapoms/shared';
import { encryptedColumn } from '../../infrastructure/security/field-encryption';

@Entity('assayers')
@Index(['assayerCode'])
@Index(['employeeId'])
@Index(['status'])
@Index(['lifecycleStatus'])
@Index(['state'])
@Index(['organizationId'])
@Index(['managerId'])
export class AssayerEntity extends BaseEntity {
  @Column({ name: 'assayer_code', unique: true, length: 50 })
  assayerCode: string;

  @Column({ name: 'employee_id', type: 'varchar', length: 50, unique: true, nullable: true })
  employeeId: string | null;

  /**
   * `select: false` so the hash is never loaded unless a query asks for it
   * explicitly. It was previously returned by every assayer read, and the list
   * endpoint was public — so anyone who could reach the API could enumerate every
   * assayer's bcrypt hash. Authentication opts back in via addSelect.
   */
  @Column({ name: 'password_hash', type: 'varchar', length: 255, nullable: true, select: false })
  passwordHash: string | null;

  /**
   * Brute-force protection, mirroring what `users` has had all along.
   *
   * The assayer login branch had no attempt counter and no lockout, and there is no rate
   * limiting anywhere in the application — so an unlimited number of guesses could be made
   * against any assayer code. That mattered enormously because the bulk importer defaults
   * every new assayer to the documented password `assayer123`: 24 of 25 live accounts share
   * it. Without this, one wordlist of one entry unlocks the entire field workforce.
   */
  @Column({ name: 'failed_login_attempts', type: 'int', default: 0 })
  failedLoginAttempts: number;

  @Column({ name: 'locked_until', type: 'timestamptz', nullable: true })
  lockedUntil: Date | null;

  /**
   * Forces a password change at next sign-in.
   *
   * Set on any account whose password was issued by someone else — seeded accounts and
   * staff-initiated resets — so a credential the account holder did not choose cannot remain
   * in use indefinitely. This deployment needs it: every seeded account currently shares one
   * of two well-known passwords.
   */
  @Column({ name: 'must_change_password', type: 'boolean', default: false })
  mustChangePassword: boolean;


  @Column({ name: 'employee_code', type: 'varchar', length: 50, nullable: true })
  employeeCode: string | null;

  @Column({ name: 'first_name', length: 100 })
  firstName: string;

  @Column({ name: 'last_name', length: 100 })
  lastName: string;

  @Column({ name: 'display_name', length: 200 })
  displayName: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email: string | null;

  /**
   * Nullable because a roster is not a contact list.
   *
   * Client rosters arrive with code, name, address and district and no phone column at all — the
   * real one this product is fed has exactly those seven columns. Requiring a phone to *admit* an
   * assayer meant such a roster imported zero of its 25 people, each with its own "Phone is
   * required" line, and the operator's only route in was to invent numbers.
   *
   * Phone is not the login identifier it was described as: `AuthService` accepts assayer code,
   * phone or email. What a missing phone genuinely costs is the ability to ring this person — so
   * it blocks Call & Assign and phone-channel dispatch, and is surfaced as a gap on the record
   * (CRITICAL_FIELDS) rather than as a barrier to entry. An imported assayer opens at INVITED and
   * cannot be recommended until they reach ACTIVE regardless, so nothing undeployable escapes.
   */
  @Column({ type: 'varchar', length: 20, nullable: true })
  phone: string | null;

  @Column({ name: 'alternate_phone', type: 'varchar', length: 20, nullable: true })
  alternatePhone: string | null;

  @Column({ type: 'text' })
  address: string;

  @Column({ length: 100 })
  state: string;

  @Column({ length: 100 })
  district: string;

  @Column({ length: 100 })
  city: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  pincode: string | null;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  latitude: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  longitude: number | null;

  /**
   * Two indexes serve this column. The spatial GiST declared here covers geometry operators.
   * The candidate prefilter (`ST_DWithin(a.location::geography, …)`, recommendation.engine.ts)
   * needs a SECOND, functional GiST on `(location::geography)` — `idx_assayers_location_geography`,
   * created by migration 1790300000000-RestoreScaleIndexes. TypeORM cannot declare a functional
   * index, so that one is migration-only; `scale-indexes.spec.ts` asserts the migration still
   * creates it. Do not "tidy" it away: without it the prefilter is a full scan of every assayer.
   */
  @Column({ type: 'geometry', spatialFeatureType: 'Point', srid: 4326, nullable: true })
  @Index({ spatial: true })
  location: any | null;

  /**
   * How the home coordinate above was obtained, and how far off it may be — the same contract
   * as on branches, and it matters at least as much here.
   *
   * The conflict-of-interest floor (`minDistanceKm`) and the serviceability radius are both
   * measured from this point, so an assayer sitting on their city's centroid can be excluded
   * from a branch on their own street, or admitted to one 40 km away, with nothing on screen
   * indicating why. `'manual'` means a person placed it, and re-geocoding leaves it alone.
   */
  @Column({ name: 'geo_source', type: 'varchar', length: 20, nullable: true })
  geoSource: string | null;

  /** Radius in metres the home coordinate is trusted within. */
  @Column({ name: 'geo_accuracy_meters', type: 'integer', nullable: true })
  geoAccuracyMeters: number | null;

  /** What the geocoder matched, so ops can check the pin rather than trust it. */
  @Column({ name: 'geo_matched_name', type: 'varchar', length: 500, nullable: true })
  geoMatchedName: string | null;

  @Column({ name: 'geo_resolved_at', type: 'timestamptz', nullable: true })
  geoResolvedAt: Date | null;

  // ── Live location (opt-in) ────────────────────────────────────────────────
  // Home coordinates are `latitude`/`longitude` above. When the assayer opts in
  // from the mobile app, `isLiveEnabled` turns on and their live position is kept
  // in `liveLatitude`/`liveLongitude` (plus a geometry column for PostGIS). By
  // default it is OFF, so live coordinates are never used for recommendations
  // unless the assayer explicitly shares them.
  @Column({ name: 'is_live_enabled', type: 'boolean', default: false })
  isLiveEnabled: boolean;

  @Column({ name: 'live_latitude', type: 'decimal', precision: 10, scale: 7, nullable: true })
  liveLatitude: number | null;

  @Column({ name: 'live_longitude', type: 'decimal', precision: 10, scale: 7, nullable: true })
  liveLongitude: number | null;

  @Column({ name: 'live_location', type: 'geometry', spatialFeatureType: 'Point', srid: 4326, nullable: true })
  @Index({ spatial: true })
  liveLocation: any | null;

  /** The position the planning/recommendation engine should use: the live
   *  coordinate when the assayer has opted in and shared one, otherwise their
   *  home address coordinate. Mirrors how ride-hailing ranks by where you are
   *  now rather than where you live — but only for assayers who opted in. */
  get effectiveLatitude(): number | null {
    return this.isLiveEnabled && this.liveLatitude != null ? this.liveLatitude : this.latitude;
  }

  get effectiveLongitude(): number | null {
    return this.isLiveEnabled && this.liveLongitude != null ? this.liveLongitude : this.longitude;
  }

  /**
   * The assayer's registered home location, never their live position.
   *
   * Two questions get asked about where an assayer is, and they need different answers.
   * "Who is nearest to this branch today?" is a routing question and should follow the live
   * fix — that is `effectiveLatitude`/`effectiveLongitude` above. "How far does this person
   * live from the branch they are auditing?" is a compliance and money question, and must not
   * move because somebody's phone was in another city that morning: a travel allowance that
   * changes with a GPS reading is not auditable, and a conflict-of-interest floor measured
   * from a temporary position does not measure conflict of interest at all.
   *
   * These read the same columns as `latitude`/`longitude`; the name states the intent, so a
   * reader can tell which question a call site is asking.
   */
  get homeLatitude(): number | null {
    return this.latitude;
  }

  get homeLongitude(): number | null {
    return this.longitude;
  }

  @Column({
    type: 'enum',
    enum: AssayerStatus,
    default: AssayerStatus.ACTIVE,
  })
  status: AssayerStatus;

  @Column({
    name: 'lifecycle_status',
    type: 'enum',
    enum: AssayerLifecycleStatus,
    default: AssayerLifecycleStatus.INVITED,
  })
  lifecycleStatus: AssayerLifecycleStatus;

  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  // Encrypted at rest (AES-256-GCM) — stored as ciphertext, so the column is `text`. IFSC is a public
  // bank-branch routing code, not secret, so it stays plaintext and searchable.
  @Column({ name: 'pan_number', type: 'text', nullable: true, transformer: encryptedColumn })
  panNumber: string | null;

  @Column({ name: 'bank_account_number', type: 'text', nullable: true, transformer: encryptedColumn })
  bankAccountNumber: string | null;

  @Column({ name: 'ifsc_code', type: 'varchar', length: 20, nullable: true })
  ifscCode: string | null;

  /** Encrypted like the PAN beside it — an Aadhaar is the most sensitive identifier we hold. */
  @Column({ name: 'aadhaar_number', type: 'text', nullable: true, transformer: encryptedColumn })
  aadhaarNumber: string | null;

  /**
   * The bank, plainly. Not derivable from the IFSC without a lookup table we do not have, and
   * the roster records it for 98% of people, so it is a column rather than a join.
   */
  @Column({ name: 'bank_name', type: 'varchar', length: 150, nullable: true })
  bankName: string | null;

  @Column({ name: 'date_of_birth', type: 'date', nullable: true })
  dateOfBirth: Date | null;

  /**
   * Highest qualification, as recorded. Free text on purpose: the roster holds 104 distinct
   * values — "B.A", "Graduate", "10th Standard", "C.A" — mixing a level with a degree with a
   * professional certification. Forcing that into an enum would either lose detail or invent a
   * taxonomy nobody uses. It is displayed, not decided on.
   */
  @Column({ type: 'varchar', length: 150, nullable: true })
  qualification: string | null;

  /** The assayer's identifier in VSTS, the client-side system some audits are logged in. */
  @Column({ name: 'vsts_code', type: 'varchar', length: 60, nullable: true })
  vstsCode: string | null;

  /** Which HR person owns this record. The roster's "HR NAME" column. */
  @Column({ name: 'hr_owner_name', type: 'varchar', length: 120, nullable: true })
  hrOwnerName: string | null;

  /**
   * How the business engages this person — regular rotation, local only, cover, agency or
   * mystery audits. Separate from whether they are currently available, which is
   * `lifecycleStatus`: the roster wrote both into one cell and the two answer different
   * questions. See `readAvailability` for the reading.
   */
  @Column({ name: 'engagement_type', type: 'varchar', length: 30, nullable: true })
  engagementType: AssayerEngagementType | null;

  /**
   * Why they are unavailable, when they are.
   *
   * "Inactive" alone does not tell an operations lead whether to try again next month. Rejected
   * by us, not interested, no work in their area and deceased are four different futures.
   */
  @Column({ name: 'unavailable_reason', type: 'varchar', length: 40, nullable: true })
  unavailableReason: AssayerUnavailableReason | null;

  /**
   * The roster says somebody other than this person is doing their audits.
   *
   * Twenty-one rows say it — "Staff doing audit", "Friend is doing audit", "Husband doing
   * audit". Whoever wrote it meant it as an aside; it is a compliance matter, because the
   * person empanelled and background-checked is not the person entering the vault. Surfaced as
   * a flag rather than left in a notes field where nothing can count it.
   */
  @Column({ name: 'work_done_by_someone_else', type: 'boolean', default: false })
  workDoneBySomeoneElse: boolean;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @Column({ name: 'employment_type', type: 'varchar', length: 50, default: 'INTERNAL' })
  employmentType: string;

  /**
   * How offers reach this assayer. Not everyone in the field uses a smartphone, so the app can
   * never be the required channel:
   *  - AUTO  (default) — derived: has an active device token → APP, else PHONE.
   *  - APP   — offers wait for an in-app response (with a phone fallback when they go quiet).
   *  - PHONE — offers become call tasks for the desk immediately, and the SLA auto-decline
   *            never fires for them (they may never see an in-app offer to answer).
   */
  @Column({ name: 'preferred_contact_channel', type: 'varchar', length: 10, default: 'AUTO' })
  preferredContactChannel: 'AUTO' | 'APP' | 'PHONE';

  @Column({ name: 'joining_date', type: 'date', nullable: true })
  joiningDate: Date | null;

  @Column({ name: 'exit_date', type: 'date', nullable: true })
  exitDate: Date | null;

  @Column({ name: 'termination_date', type: 'date', nullable: true })
  terminationDate: Date | null;

  @Column({ name: 'manager_id', type: 'uuid', nullable: true })
  managerId: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  department: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  region: string | null;

  @Column({ name: 'emergency_contact_name', type: 'varchar', length: 200, nullable: true })
  emergencyContactName: string | null;

  @Column({ name: 'emergency_contact_phone', type: 'varchar', length: 20, nullable: true })
  emergencyContactPhone: string | null;

  @Column({ name: 'emergency_contact_relation', type: 'varchar', length: 100, nullable: true })
  emergencyContactRelation: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  photograph: string | null;

  @Column({ name: 'preferred_regions', type: 'jsonb', nullable: true })
  preferredRegions: string[] | null;

  @Column({ name: 'experience_years', type: 'int', default: 0 })
  experienceYears: number;

  @Column({ name: 'performance_rating', type: 'decimal', precision: 3, scale: 2, default: 5.00 })
  performanceRating: number;

  @Column({ type: 'jsonb', nullable: true })
  leaves: { startDate: string; endDate: string }[] | null;

  @Column({ name: 'working_hours', type: 'jsonb', nullable: true })
  workingHours: { start: string; end: string } | null;

  @Column({ name: 'max_daily_workload', type: 'int', default: 3 })
  maxDailyWorkload: number;

  @Column({ name: 'max_weekly_workload', type: 'int', default: 15 })
  maxWeeklyWorkload: number;

  @Column({ name: 'eligible_clients', type: 'jsonb', nullable: true })
  eligibleClients: string[] | null;

  @Column({ name: 'total_assignments', type: 'int', default: 0 })
  totalAssignments: number;

  @Column({ name: 'completed_assignments', type: 'int', default: 0 })
  completedAssignments: number;

  @Column({ name: 'cancelled_assignments', type: 'int', default: 0 })
  cancelledAssignments: number;

  @Column({ name: 'on_time_completions', type: 'int', default: 0 })
  onTimeCompletions: number;

  @Column({ name: 'last_assignment_date', type: 'timestamptz', nullable: true })
  lastAssignmentDate: Date | null;

  @Column({ name: 'average_rating', type: 'decimal', precision: 3, scale: 2, default: 0 })
  averageRating: number;

}

/**
 * Skills/certifications/languages/specializations live in the normalized
 * `workforce_attributes` table (see WorkforceAttributeEntity), not as columns on
 * AssayerEntity itself. AssayerService.hydrateWorkforceAttributes/hydrateAllWorkforceAttributes
 * attach them onto an already-loaded AssayerEntity in memory before candidate-matching code
 * reads them — this type documents that shape for the read side instead of scattering `as any`.
 */
export type AssayerWithWorkforceAttributes = AssayerEntity & {
  skills?: string[];
  certifications?: { name: string; expiryDate?: string | null }[];
  languages?: string[];
  specializations?: string[];
};
