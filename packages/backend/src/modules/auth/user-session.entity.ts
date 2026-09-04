import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
} from 'typeorm';

/**
 * One sign-in session — the durable "who logged in, from where, on what device, and is it still
 * live" record the compliance ask centres on ("entire history of all the user of each session with
 * IP").
 *
 * ## Why this is separate from `refresh_tokens`
 * A refresh-token row is one link in a rotation chain: a new one is written on every ~15-minute
 * refresh and the old one is revoked, and retention hard-deletes them within days of expiry. So the
 * refresh-token table can answer "is this token live" but not "show me this user's sessions over the
 * last year" — the rows for a session churn and are then purged. A session is the STABLE identity
 * that spans that whole rotation chain: minted once at login, its id (`sid`) is carried in every
 * access token and forward through every refresh, and the row is kept for the audit-retention window
 * rather than pruned with the tokens. `last_seen_at` moves forward as the session refreshes, so
 * "when did this device last authenticate" stays answerable without a row per refresh.
 *
 * The access token carries `sid`, so — unlike before — an authenticated request can be attributed to
 * a specific session/device, which is what makes per-session activity history and per-device revoke
 * possible.
 */
@Entity('user_sessions')
@Index('IDX_user_sessions_user', ['userId'])
@Index('IDX_user_sessions_user_active', ['userId', 'revokedAt'])
export class UserSessionEntity {
  /** The session id — this value is the access token's `sid` claim. */
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({
    name: 'principal_type',
    type: 'varchar',
    length: 20,
    comment: 'USER (staff) or ASSAYER — the two identity sources the login serves.',
  })
  principalType: 'USER' | 'ASSAYER';

  @Column({ name: 'ip_address', type: 'varchar', length: 50, nullable: true })
  ipAddress: string | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent: string | null;

  // Parsed from the user-agent at mint time so the sessions UI can show a human label without
  // re-parsing on every read. Raw user_agent is kept above for forensics.
  @Column({ name: 'device_browser', type: 'varchar', length: 80, nullable: true })
  deviceBrowser: string | null;

  @Column({ name: 'device_os', type: 'varchar', length: 80, nullable: true })
  deviceOs: string | null;

  @Column({ name: 'device_label', type: 'varchar', length: 160, nullable: true })
  deviceLabel: string | null;

  @Column({
    name: 'login_method',
    type: 'varchar',
    length: 20,
    comment: 'PASSWORD or BIOMETRIC — how the session was established.',
  })
  loginMethod: 'PASSWORD' | 'BIOMETRIC';

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'last_seen_at', type: 'timestamptz' })
  lastSeenAt: Date;

  /** When the session's authority lapses if not revoked first — aligned with the refresh TTL. */
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ name: 'revoked_reason', type: 'varchar', length: 60, nullable: true })
  revokedReason: string | null;

  /** Who revoked it (self, an admin, or the system on reuse detection); null while live. */
  @Column({ name: 'revoked_by_user_id', type: 'uuid', nullable: true })
  revokedByUserId: string | null;
}
