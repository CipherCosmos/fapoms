import { Injectable, Logger, BadRequestException, ForbiddenException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { EventCategory } from '@fapoms/shared';
import { AuditService } from '../../core/audit/audit.service';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { appPublicUrl } from '../../infrastructure/notifications/email-provider';
import { UserEntity } from '../user/user.entity';
import { UserMfaEntity } from './user-mfa.entity';
import { MfaRecoveryCodeEntity } from './mfa-recovery-code.entity';
import {
  generateTotpSecret, verifyTotp, otpauthUri, generateRecoveryCodes, hashRecoveryCode,
} from './totp';
import { hashCode, numericCode, hashesEqual } from './otp-codes';
import { EmailService } from '../notifications/email.service';
import { SmsService } from '../notifications/sms.service';

const MAX_MFA_ATTEMPTS = 5;
const MFA_LOCK_MS = 15 * 60_000;

/** The factor types a user can enrol. TOTP is authenticator-app; EMAIL/SMS are delivered codes. */
export type MfaFactorType = 'TOTP' | 'EMAIL' | 'SMS';
/** A delivered login/enrolment code lives this long. Kept at or under the challenge's own TTL. */
const DELIVERED_CODE_TTL_S = 300;

/** Mask a destination for display in a response — enough to recognise, not enough to leak. */
function maskDestination(type: MfaFactorType, dest: string): string {
  if (type === 'EMAIL') {
    const [user, domain] = dest.split('@');
    if (!domain) return '***';
    const head = user.slice(0, 1);
    return `${head}${'*'.repeat(Math.max(1, user.length - 1))}@${domain}`;
  }
  // phone: reveal only the last two digits
  const digits = dest.replace(/\D/g, '');
  return digits.length <= 2 ? '**' : `${'*'.repeat(digits.length - 2)}${digits.slice(-2)}`;
}

/**
 * Multi-factor authentication (TOTP + single-use recovery codes). Every state change is audited and
 * attributable, secrets are encrypted at rest (the entity transformer), and verification is
 * rate-limited per account with a lockout — the same brute-force posture as the password path.
 *
 * STEP-UP: the two actions that WEAKEN an account — removing a factor and replacing the recovery
 * codes — require proof beyond the session: the current password or a fresh authenticator code
 * (`assertStepUp`). A stolen session alone therefore cannot switch MFA off or mint itself a fresh set
 * of recovery codes. Enrolling an ADDITIONAL factor still needs only the session (it adds a hurdle
 * rather than removing one); instant session revocation and the audit trail cover that residual.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    @InjectRepository(UserMfaEntity) private readonly mfa: Repository<UserMfaEntity>,
    @InjectRepository(MfaRecoveryCodeEntity) private readonly recovery: Repository<MfaRecoveryCodeEntity>,
    /** Only ever read for the recipient's name, so a code can be addressed to the person. */
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly emails: EmailService,
    /** Texts go through the one SMS door, like email through `EmailService` — never the gateway itself. */
    private readonly sms: SmsService,
  ) {}

  /** Login asks this: does the user have ANY confirmed factor (TOTP, email, or SMS) to satisfy? */
  async isChallengeRequired(userId: string): Promise<boolean> {
    return (await this.mfa.count({ where: { userId, confirmedAt: Not(IsNull()) } })) > 0;
  }

  /** The user's CONFIRMED factor types, in a stable preference order (TOTP first — no send needed). */
  async factorsFor(userId: string): Promise<MfaFactorType[]> {
    const rows = await this.mfa.find({ where: { userId, confirmedAt: Not(IsNull()) } });
    const have = new Set(rows.map((r) => r.type as MfaFactorType));
    return (['TOTP', 'EMAIL', 'SMS'] as MfaFactorType[]).filter((t) => have.has(t));
  }

  async status(userId: string): Promise<{
    enrolled: boolean; confirmed: boolean; factors: MfaFactorType[]; recoveryCodesRemaining: number;
    /**
     * Whether a text message can be set up as a factor on this server at all. The screen asks so it
     * can say so before the person types a number, rather than after enrolment is refused.
     */
    smsAvailable: boolean;
  }> {
    const rows = await this.mfa.find({ where: { userId } });
    const confirmed = rows.filter((r) => r.confirmedAt);
    const factors = (['TOTP', 'EMAIL', 'SMS'] as MfaFactorType[])
      .filter((t) => confirmed.some((r) => r.type === t));
    const remaining = confirmed.length
      ? await this.recovery.count({ where: { userId, usedAt: IsNull() } })
      : 0;
    return {
      enrolled: rows.length > 0,
      confirmed: confirmed.length > 0,
      factors,
      recoveryCodesRemaining: remaining,
      smsAvailable: this.sms.isEnabled(),
    };
  }

  /**
   * Begin enrolment: mint a secret and store it UNCONFIRMED (overwriting any prior unconfirmed
   * attempt), returning the otpauth URI + secret for the QR. Activation waits for confirmEnrol.
   * Refuses to clobber an ALREADY-CONFIRMED factor (disable it first).
   */
  async beginEnrol(userId: string, account: string): Promise<{ otpauthUri: string; secret: string }> {
    const existing = await this.mfa.findOne({ where: { userId, type: 'TOTP' } });
    if (existing?.confirmedAt) {
      throw new BadRequestException('MFA is already set up. Remove it before enrolling a new authenticator.');
    }
    const secret = generateTotpSecret();
    if (existing) {
      existing.secret = secret;
      existing.failedAttempts = 0;
      existing.lockedUntil = null;
      await this.mfa.save(existing);
    } else {
      await this.mfa.save(this.mfa.create({ userId, type: 'TOTP', secret, confirmedAt: null }));
    }
    await this.audit.recordEventSafe({
      category: EventCategory.USER, eventType: 'MFA_ENROLMENT_STARTED', entityType: 'USER_MFA',
      entityId: userId, userId, remarks: 'TOTP enrolment started',
    });
    return { otpauthUri: otpauthUri(secret, account), secret };
  }

  /**
   * Begin enrolment of a DELIVERED factor (email or SMS): store the destination on an unconfirmed
   * row and send a code to it, so the user proves they control that channel before it can ever
   * gate a login. SMS enrolment is refused with a clear error when no SMS provider is configured —
   * never silently accepted and then undeliverable. The pending code lives in Redis (hashed), not
   * the database.
   */
  async beginDeliveredEnrol(
    userId: string,
    type: 'EMAIL' | 'SMS',
    destination: string,
  ): Promise<{ sentTo: string }> {
    const dest = (destination || '').trim();
    if (type === 'EMAIL' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dest)) {
      throw new BadRequestException('A valid email address is required.');
    }
    if (type === 'SMS') {
      if (dest.replace(/\D/g, '').length < 10) throw new BadRequestException('A valid phone number is required.');
      if (!this.sms.isEnabled()) {
        throw new BadRequestException('SMS delivery is not configured on this server, so SMS cannot be used as a second factor. Use an authenticator app or email instead.');
      }
    }

    const existing = await this.mfa.findOne({ where: { userId, type } });
    if (existing?.confirmedAt) {
      throw new BadRequestException(`${type === 'EMAIL' ? 'Email' : 'SMS'} is already set up as a second factor. Remove it first to change the destination.`);
    }
    if (existing) {
      existing.secret = dest; existing.failedAttempts = 0; existing.lockedUntil = null;
      await this.mfa.save(existing);
    } else {
      await this.mfa.save(this.mfa.create({ userId, type, secret: dest, confirmedAt: null }));
    }

    const code = numericCode();
    await this.cache.setJson(`mfa:enrol:${userId}:${type}`, { hash: hashCode(code) }, DELIVERED_CODE_TTL_S);
    const delivered = await this.deliver(userId, type, dest, code, 'confirm your second factor');
    if (!delivered) {
      throw new BadRequestException('Could not send the code right now. Check the address/number and try again.');
    }
    await this.audit.recordEventSafe({
      category: EventCategory.USER, eventType: 'MFA_ENROLMENT_STARTED', entityType: 'USER_MFA',
      entityId: userId, userId, remarks: `${type} enrolment started`,
    });
    return { sentTo: maskDestination(type, dest) };
  }

  /**
   * Confirm enrolment by proving one code. For TOTP the code is checked against the stored secret;
   * for a delivered factor it is checked against the code just sent (Redis, single-use). Activates
   * the factor. Recovery codes are minted ONCE, when the user's FIRST factor is confirmed, and
   * returned in plaintext only then (stored solely as hashes); confirming a second factor returns
   * an empty list rather than silently reissuing and invalidating the codes the user already saved.
   */
  async confirmEnrol(userId: string, code: string, type: MfaFactorType = 'TOTP'): Promise<{ recoveryCodes: string[] }> {
    const row = await this.mfa.findOne({ where: { userId, type } });
    if (!row) throw new BadRequestException('Start MFA enrolment first.');
    if (row.confirmedAt) throw new BadRequestException('This factor is already active.');

    let ok = false;
    if (type === 'TOTP') {
      ok = verifyTotp(row.secret, code);
    } else {
      const pending = await this.cache.getJson<{ hash: string }>(`mfa:enrol:${userId}:${type}`);
      ok = !!pending && hashesEqual(pending.hash, hashCode(code));
      if (ok) await this.cache.del(`mfa:enrol:${userId}:${type}`);
    }
    if (!ok) {
      throw new BadRequestException(type === 'TOTP'
        ? 'That code is not valid. Check the time on your device and try again.'
        : 'That code is not valid or has expired. Request a new one and try again.');
    }

    // First factor for this user? (Decide before we mark this row confirmed.)
    const alreadyHadAFactor = (await this.mfa.count({ where: { userId, confirmedAt: Not(IsNull()) } })) > 0;
    row.confirmedAt = new Date();
    row.failedAttempts = 0;
    row.lockedUntil = null;
    await this.mfa.save(row);

    const codes = alreadyHadAFactor ? [] : await this.replaceRecoveryCodes(userId);
    await this.audit.recordEventSafe({
      category: EventCategory.USER, eventType: 'MFA_ENABLED', entityType: 'USER_MFA',
      entityId: userId, userId, remarks: `${type} confirmed and activated`,
    });
    return { recoveryCodes: codes };
  }

  /**
   * Send a login-time code for a DELIVERED factor and return its hash + expiry for the caller to
   * stash on the (already-created) login challenge. The code itself never leaves this method in the
   * clear. Refuses a factor the user has not confirmed, and a disabled SMS provider.
   */
  async sendLoginCode(userId: string, type: 'EMAIL' | 'SMS'): Promise<{ codeHash: string; expiresAt: number; sentTo: string }> {
    const row = await this.mfa.findOne({ where: { userId, type, confirmedAt: Not(IsNull()) } });
    if (!row) throw new BadRequestException('That second-factor method is not set up on this account.');
    if (type === 'SMS' && !this.sms.isEnabled()) {
      throw new BadRequestException('SMS delivery is not configured on this server.');
    }
    const code = numericCode();
    const delivered = await this.deliver(userId, type, row.secret, code, 'sign in');
    if (!delivered) throw new BadRequestException('Could not send the code right now. Try again, or use a different method.');
    await this.audit.recordEventSafe({
      category: EventCategory.USER, eventType: 'MFA_CODE_SENT', entityType: 'USER_MFA',
      entityId: userId, userId, remarks: `Login code sent by ${type}`,
    });
    return { codeHash: hashCode(code), expiresAt: Date.now() + DELIVERED_CODE_TTL_S * 1000, sentTo: maskDestination(type, row.secret) };
  }

  /**
   * Deliver a code over the chosen channel. Returns whether it went out; never throws.
   *
   * Both channels send now rather than queue — the person is on the sign-in screen waiting for it —
   * and the code travels only as template data: `sendNow` records the send without its body, so the
   * code is in no log and no table.
   */
  private async deliver(
    userId: string, type: 'EMAIL' | 'SMS', dest: string, code: string, purpose: string,
  ): Promise<boolean> {
    try {
      /*
        Who the code is for, so `{{name}}` reads as a name in whichever wording an administrator
        writes. One column of one row; a failed read leaves the placeholder empty rather than
        stopping a sign-in.
      */
      const recipientName = await this.recipientName(userId);
      if (type === 'EMAIL') {
        const res = await this.emails.sendNow({
          kind: 'MFA_CODE',
          to: dest,
          recipientName,
          content: {
            template: 'mfa-code',
            data: {
              otpCode: code,
              validMinutes: String(Math.round(DELIVERED_CODE_TTL_S / 60)),
              purpose,
              logoUrl: `${appPublicUrl()}/sumeru-logo@2x.png`,
              companyName: 'Sumeru Global',
            },
          },
          entityType: 'USER',
          entityId: userId,
          requestedBy: userId,
        });
        return !!res?.sent;
      }
      const res = await this.sms.sendNow({
        kind: 'MFA_CODE',
        to: dest,
        recipientName,
        content: {
          template: 'mfa-code',
          data: { code, validMinutes: String(Math.round(DELIVERED_CODE_TTL_S / 60)) },
        },
        entityType: 'USER',
        entityId: userId,
        requestedBy: userId,
      });
      return !!res?.sent;
    } catch (e) {
      this.logger.warn(`MFA code delivery over ${type} failed: ${(e as Error).message}`);
      return false;
    }
  }

  /** The person's name for the message, or nothing — never a reason a code fails to go out. */
  private async recipientName(userId: string): Promise<string | null> {
    try {
      const user = await this.users.findOne({ where: { id: userId }, select: ['id', 'displayName'] });
      return user?.displayName?.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Verify a login-time factor: a TOTP code OR a single-use recovery code. Per-account lockout after
   * repeated failures (like the password path). Returns true on success; throws on lockout.
   */
  async verify(userId: string, code: string): Promise<boolean> {
    const clean = (code || '').trim();
    // Lockout is tracked on the TOTP row when present (the repeated-guess target for an app code).
    // Email/SMS and recovery-only accounts are bounded instead by the login challenge's own
    // attempt cap, so a missing TOTP row is not a reason to refuse a recovery code here.
    const totpRow = await this.mfa.findOne({ where: { userId, type: 'TOTP', confirmedAt: Not(IsNull()) } });
    if (totpRow?.lockedUntil && totpRow.lockedUntil.getTime() > Date.now()) {
      throw new ForbiddenException('Too many incorrect codes. Try again in a few minutes.');
    }

    let ok = false;
    if (totpRow) ok = verifyTotp(totpRow.secret, clean);
    if (!ok && /-/.test(clean)) ok = await this.consumeRecoveryCode(userId, clean);

    if (ok) {
      if (totpRow && (totpRow.failedAttempts !== 0 || totpRow.lockedUntil)) {
        totpRow.failedAttempts = 0; totpRow.lockedUntil = null; await this.mfa.save(totpRow);
      }
      await this.audit.recordEventSafe({
        category: EventCategory.USER, eventType: 'MFA_VERIFIED', entityType: 'USER_MFA',
        entityId: userId, userId, remarks: 'MFA code accepted at login',
      });
      return true;
    }

    if (totpRow) {
      totpRow.failedAttempts = (totpRow.failedAttempts || 0) + 1;
      if (totpRow.failedAttempts >= MAX_MFA_ATTEMPTS) {
        totpRow.lockedUntil = new Date(Date.now() + MFA_LOCK_MS);
        totpRow.failedAttempts = 0;
      }
      await this.mfa.save(totpRow);
    }
    await this.audit.recordEventSafe({
      category: EventCategory.USER, eventType: 'MFA_FAILED', entityType: 'USER_MFA',
      entityId: userId, userId, remarks: 'Incorrect MFA code at login',
    });
    return false;
  }

  /**
   * Prove it is the account holder, not just somebody holding their session, before an action that
   * weakens the account. Either the current password or a code from the authenticator app counts.
   *
   * A wrong answer is refused (and audited); a wrong authenticator code counts toward the same
   * per-account lockout as a wrong code at login, so this is not a side door for guessing codes.
   * Recovery codes are deliberately NOT accepted: they are for losing the device, and spending one
   * here to regenerate them all would be circular.
   */
  async assertStepUp(userId: string, proof: { currentPassword?: string; code?: string }, action: string): Promise<void> {
    const password = typeof proof?.currentPassword === 'string' ? proof.currentPassword : '';
    const code = typeof proof?.code === 'string' ? proof.code.trim() : '';
    if (!password && !code) {
      throw new BadRequestException(
        'Confirm it is you: enter your current password or a code from your authenticator app.',
      );
    }

    let ok = false;
    if (password) {
      const user = await this.users.createQueryBuilder('u')
        .addSelect('u.passwordHash')
        .where('u.id = :id', { id: userId })
        .getOne();
      ok = !!user?.passwordHash && await bcrypt.compare(password, user.passwordHash);
    }
    if (!ok && code) {
      const totpRow = await this.mfa.findOne({ where: { userId, type: 'TOTP', confirmedAt: Not(IsNull()) } });
      if (totpRow) {
        if (totpRow.lockedUntil && totpRow.lockedUntil.getTime() > Date.now()) {
          throw new ForbiddenException('Too many incorrect codes. Try again in a few minutes.');
        }
        ok = verifyTotp(totpRow.secret, code);
        if (ok && (totpRow.failedAttempts !== 0 || totpRow.lockedUntil)) {
          totpRow.failedAttempts = 0; totpRow.lockedUntil = null; await this.mfa.save(totpRow);
        } else if (!ok) {
          totpRow.failedAttempts = (totpRow.failedAttempts || 0) + 1;
          if (totpRow.failedAttempts >= MAX_MFA_ATTEMPTS) {
            totpRow.lockedUntil = new Date(Date.now() + MFA_LOCK_MS);
            totpRow.failedAttempts = 0;
          }
          await this.mfa.save(totpRow);
        }
      }
    }

    if (!ok) {
      await this.audit.recordEventSafe({
        category: EventCategory.USER, eventType: 'MFA_STEP_UP_FAILED', entityType: 'USER_MFA',
        entityId: userId, userId, remarks: `Wrong password or code when trying to ${action}`,
      });
      throw new ForbiddenException(
        'That password or code is not right. Enter your current password, or a fresh code from your authenticator app.',
      );
    }
  }

  /**
   * Remove one factor (when `type` is given) or all of the user's MFA (when it is not). Recovery
   * codes belong to the account, not a single factor, so they are cleared only once NO confirmed
   * factor remains — removing one of several must not strand the others' recovery path.
   */
  async disable(userId: string, byUserId: string | null, type?: MfaFactorType): Promise<void> {
    if (type) {
      await this.mfa.delete({ userId, type });
    } else {
      await this.mfa.delete({ userId });
    }
    const stillConfirmed = await this.mfa.count({ where: { userId, confirmedAt: Not(IsNull()) } });
    if (stillConfirmed === 0) await this.recovery.delete({ userId });
    await this.audit.recordEventSafe({
      category: EventCategory.USER, eventType: 'MFA_DISABLED', entityType: 'USER_MFA',
      entityId: userId, userId: byUserId ?? undefined, remarks: type ? `${type} factor removed` : 'MFA removed',
    });
  }

  async regenerateRecoveryCodes(userId: string): Promise<string[]> {
    const active = await this.mfa.count({ where: { userId, confirmedAt: Not(IsNull()) } });
    if (active === 0) throw new BadRequestException('MFA is not active.');
    const codes = await this.replaceRecoveryCodes(userId);
    await this.audit.recordEventSafe({
      category: EventCategory.USER, eventType: 'MFA_RECOVERY_REGENERATED', entityType: 'USER_MFA',
      entityId: userId, userId, remarks: 'Recovery codes regenerated (old codes invalidated)',
    });
    return codes;
  }

  private async replaceRecoveryCodes(userId: string): Promise<string[]> {
    await this.recovery.delete({ userId });
    const { plaintext, hashes } = generateRecoveryCodes(10);
    await this.recovery.save(hashes.map((codeHash) => this.recovery.create({ userId, codeHash })));
    return plaintext;
  }

  /** Consume an unused recovery code atomically (single-use): mark used only if currently unused. */
  private async consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
    const hash = hashRecoveryCode(code);
    const res = await this.recovery
      .createQueryBuilder()
      .update(MfaRecoveryCodeEntity)
      .set({ usedAt: () => 'now()' })
      .where('user_id = :userId', { userId })
      .andWhere('code_hash = :hash', { hash })
      .andWhere('used_at IS NULL')
      .execute();
    if ((res.affected ?? 0) > 0) {
      await this.audit.recordEventSafe({
        category: EventCategory.USER, eventType: 'MFA_RECOVERY_USED', entityType: 'USER_MFA',
        entityId: userId, userId, remarks: 'A single-use recovery code was used to sign in',
      });
      return true;
    }
    return false;
  }
}
