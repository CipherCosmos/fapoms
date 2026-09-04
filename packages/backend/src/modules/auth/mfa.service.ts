import { Injectable, Logger, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { EventCategory } from '@fapoms/shared';
import { AuditService } from '../../core/audit/audit.service';
import { UserMfaEntity } from './user-mfa.entity';
import { MfaRecoveryCodeEntity } from './mfa-recovery-code.entity';
import {
  generateTotpSecret, verifyTotp, otpauthUri, generateRecoveryCodes, hashRecoveryCode,
} from './totp';

const MAX_MFA_ATTEMPTS = 5;
const MFA_LOCK_MS = 15 * 60_000;

/**
 * Multi-factor authentication (TOTP + single-use recovery codes). Every state change is audited and
 * attributable, secrets are encrypted at rest (the entity transformer), and verification is
 * rate-limited per account with a lockout — the same brute-force posture as the password path.
 *
 * SECURITY NOTE (documented residual, step-up auth is out of Wave 2 scope): enrol/disable/regenerate
 * here require an authenticated session but NOT a fresh password re-entry, so an attacker who already
 * holds a live session could change a victim's MFA. Mitigated for now by: instant session revocation
 * ("log out all devices"), the audit trail below, and that the far more common attack — stolen
 * credentials — is exactly what MFA at login stops. Step-up re-auth on these actions is the tracked
 * follow-up.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    @InjectRepository(UserMfaEntity) private readonly mfa: Repository<UserMfaEntity>,
    @InjectRepository(MfaRecoveryCodeEntity) private readonly recovery: Repository<MfaRecoveryCodeEntity>,
    private readonly audit: AuditService,
  ) {}

  /** Login asks this: does the user have a CONFIRMED factor that must be satisfied? */
  async isChallengeRequired(userId: string): Promise<boolean> {
    const row = await this.mfa.findOne({ where: { userId, type: 'TOTP' } });
    return !!row?.confirmedAt;
  }

  async status(userId: string): Promise<{ enrolled: boolean; confirmed: boolean; recoveryCodesRemaining: number }> {
    const row = await this.mfa.findOne({ where: { userId, type: 'TOTP' } });
    const remaining = row?.confirmedAt
      ? await this.recovery.count({ where: { userId, usedAt: IsNull() } })
      : 0;
    return { enrolled: !!row, confirmed: !!row?.confirmedAt, recoveryCodesRemaining: remaining };
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
   * Confirm enrolment by proving one code. Activates the factor and issues fresh recovery codes
   * (returned in plaintext ONCE; only hashes are stored). Enrol-confirm-before-activate.
   */
  async confirmEnrol(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const row = await this.mfa.findOne({ where: { userId, type: 'TOTP' } });
    if (!row) throw new BadRequestException('Start MFA enrolment first.');
    if (row.confirmedAt) throw new BadRequestException('MFA is already active.');
    if (!verifyTotp(row.secret, code)) {
      throw new BadRequestException('That code is not valid. Check the time on your device and try again.');
    }
    row.confirmedAt = new Date();
    row.failedAttempts = 0;
    row.lockedUntil = null;
    await this.mfa.save(row);
    const codes = await this.replaceRecoveryCodes(userId);
    await this.audit.recordEventSafe({
      category: EventCategory.USER, eventType: 'MFA_ENABLED', entityType: 'USER_MFA',
      entityId: userId, userId, remarks: 'TOTP confirmed and activated',
    });
    return { recoveryCodes: codes };
  }

  /**
   * Verify a login-time factor: a TOTP code OR a single-use recovery code. Per-account lockout after
   * repeated failures (like the password path). Returns true on success; throws on lockout.
   */
  async verify(userId: string, code: string): Promise<boolean> {
    const row = await this.mfa.findOne({ where: { userId, type: 'TOTP' } });
    if (!row?.confirmedAt) return false; // nothing to verify against — caller should not have challenged
    if (row.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
      throw new ForbiddenException('Too many incorrect codes. Try again in a few minutes.');
    }

    const clean = (code || '').trim();
    let ok = verifyTotp(row.secret, clean);
    if (!ok && /-/.test(clean)) ok = await this.consumeRecoveryCode(userId, clean);

    if (ok) {
      if (row.failedAttempts !== 0 || row.lockedUntil) {
        row.failedAttempts = 0; row.lockedUntil = null; await this.mfa.save(row);
      }
      await this.audit.recordEventSafe({
        category: EventCategory.USER, eventType: 'MFA_VERIFIED', entityType: 'USER_MFA',
        entityId: userId, userId, remarks: 'MFA code accepted at login',
      });
      return true;
    }

    row.failedAttempts = (row.failedAttempts || 0) + 1;
    if (row.failedAttempts >= MAX_MFA_ATTEMPTS) {
      row.lockedUntil = new Date(Date.now() + MFA_LOCK_MS);
      row.failedAttempts = 0;
    }
    await this.mfa.save(row);
    await this.audit.recordEventSafe({
      category: EventCategory.USER, eventType: 'MFA_FAILED', entityType: 'USER_MFA',
      entityId: userId, userId, remarks: 'Incorrect MFA code at login',
    });
    return false;
  }

  async disable(userId: string, byUserId: string | null): Promise<void> {
    await this.mfa.delete({ userId, type: 'TOTP' });
    await this.recovery.delete({ userId });
    await this.audit.recordEventSafe({
      category: EventCategory.USER, eventType: 'MFA_DISABLED', entityType: 'USER_MFA',
      entityId: userId, userId: byUserId ?? undefined, remarks: 'MFA removed',
    });
  }

  async regenerateRecoveryCodes(userId: string): Promise<string[]> {
    const row = await this.mfa.findOne({ where: { userId, type: 'TOTP' } });
    if (!row?.confirmedAt) throw new BadRequestException('MFA is not active.');
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
