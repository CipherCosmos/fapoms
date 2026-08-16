import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SystemRole } from '@fapoms/shared';
import { EmailProvider } from '../notifications/email-provider';
import { FcmProvider } from '../notifications/fcm-provider';
import { NOTIFICATION_CATALOG } from '../../modules/notifications/notification-catalog';

/**
 * One loud block at boot saying what this deployment can and cannot actually do.
 *
 * Nearly every configuration defect this platform has shipped shared a shape: something was
 * missing, the code degraded politely, and nobody found out until a person went looking. Email
 * was unconfigured for weeks while `email_status` quietly filled with SUPPRESSED. Eight of the
 * thirteen roles vanished in a schema squash, so `DESK_SUBMIT_OVERDUE` addressed an empty set and
 * an overdue report announced itself to nobody. The push credential was assumed missing for so
 * long it was written down as fact in the project notes — while it was, in truth, loading fine.
 *
 * Degrading rather than crashing is the right behaviour: email being unconfigured must never stop
 * an audit being planned. What was missing is the other half — saying so, once, somewhere nobody
 * has to go looking for. Every check below is a thing that fails silently at runtime by design.
 *
 * Non-fatal by default, because a half-configured deployment is still worth having up. Set
 * `STARTUP_CHECKS_STRICT=true` — CI and production are the intended users — to make a failure
 * refuse the boot instead.
 */

export interface StartupCheck {
  name: string;
  ok: boolean;
  /** One line, written for whoever is reading a boot log at 2am. */
  detail: string;
  /** A failure that makes the deployment wrong rather than merely reduced. */
  critical: boolean;
}

/**
 * Assayers authenticate against the `assayers` table, not `users`, and deliberately have no row
 * in `roles`. Notifications reach them by `assayerId`, never by role fan-out.
 */
const NOT_A_USER_ROLE: string[] = [SystemRole.ASSAYER];

@Injectable()
export class StartupChecksService implements OnApplicationBootstrap {
  private readonly logger = new Logger('StartupChecks');
  private last: StartupCheck[] = [];

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Resolved through `ModuleRef` with `strict: false`, not constructor-injected.
   *
   * `EmailProvider` and `FcmProvider` live in `NotificationsModule`, which is not global, so
   * constructor injection from here yields nothing. With `@Optional()` that failure is *silent*:
   * both arrive as `undefined` and every run reports "NOT configured" — which is exactly what
   * the first version of this file did, on a deployment where both were demonstrably working.
   * A check that cries wolf is worse than no check, because the next real failure reads as noise.
   *
   * `strict: false` searches the whole container, so it finds them wherever they are declared.
   * Returns null only when a provider genuinely is not registered.
   */
  private resolve<T>(type: new (...args: any[]) => T): T | null {
    try {
      return this.moduleRef.get(type, { strict: false });
    } catch {
      return null;
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    // Never let a diagnostic be the thing that takes the process down.
    const checks = await this.run().catch((err) => {
      this.logger.error(`Startup checks could not run: ${err?.message ?? err}`);
      return [] as StartupCheck[];
    });
    if (!checks.length) return;

    this.report(checks);

    const fatal = checks.filter((c) => !c.ok && c.critical);
    if (fatal.length && process.env.STARTUP_CHECKS_STRICT === 'true') {
      throw new Error(
        `Startup checks failed: ${fatal.map((c) => c.name).join(', ')}. `
        + 'Unset STARTUP_CHECKS_STRICT to boot anyway.',
      );
    }
  }

  /** The last result, so a health endpoint can serve it without re-querying. */
  getLastResults(): StartupCheck[] {
    return this.last;
  }

  async run(): Promise<StartupCheck[]> {
    const checks: StartupCheck[] = [];
    const roleNames = await this.roleNames();

    // ── Roles exist ──────────────────────────────────────────────────────────
    const missingRoles = Object.values(SystemRole)
      .filter((r) => !NOT_A_USER_ROLE.includes(r))
      .filter((r) => !roleNames.has(r));
    checks.push({
      name: 'roles',
      ok: missingRoles.length === 0,
      critical: true,
      detail: missingRoles.length
        ? `${missingRoles.length} role(s) in SystemRole have no row and cannot be assigned: ${missingRoles.join(', ')}. Run migrations.`
        : `all ${roleNames.size} roles present`,
    });

    // ── Every notification can reach somebody ────────────────────────────────
    // A role that exists but nobody holds is a staffing decision, not a defect — but an event
    // whose every role is unstaffed reaches no one, and that is indistinguishable at runtime
    // from "everybody has already read it".
    const staffed = await this.staffedRoleNames();
    const unreachable = Object.entries(NOTIFICATION_CATALOG)
      .filter(([, entry]) => (entry.roles?.length ?? 0) > 0)
      .filter(([, entry]) => !entry.roles!.some((r) => staffed.has(r)))
      .map(([type]) => type);
    checks.push({
      name: 'notification recipients',
      ok: unreachable.length === 0,
      critical: false,
      detail: unreachable.length
        ? `${unreachable.length} event(s) reach nobody — no active user holds any of their roles: ${unreachable.slice(0, 6).join(', ')}${unreachable.length > 6 ? '…' : ''}`
        : 'every role-addressed event has at least one recipient',
    });

    // ── Outbound email ───────────────────────────────────────────────────────
    const email = this.resolve(EmailProvider);
    checks.push({
      name: 'email',
      ok: email?.isEnabled() ?? false,
      critical: false,
      detail: !email
        ? 'provider not registered in this process'
        : email.isEnabled()
          ? 'transport configured'
          : 'NOT configured — every email notification will be recorded SUPPRESSED and silently not sent. Administration → Platform Settings → Email delivery.',
    });

    // ── Push ─────────────────────────────────────────────────────────────────
    const fcm = this.resolve(FcmProvider);
    checks.push({
      name: 'push',
      ok: fcm?.isEnabled() ?? false,
      critical: false,
      detail: !fcm
        ? 'provider not registered in this process'
        : fcm.isEnabled()
          ? 'FCM credential loaded'
          : 'NOT configured — no push will reach any handset. Provide the Firebase service account.',
    });

    this.last = checks;
    return checks;
  }

  private async roleNames(): Promise<Set<string>> {
    const rows: Array<{ name: string }> = await this.dataSource.query('SELECT name FROM roles');
    return new Set(rows.map((r) => r.name));
  }

  /** Roles at least one active user actually holds. */
  private async staffedRoleNames(): Promise<Set<string>> {
    const rows: Array<{ name: string }> = await this.dataSource.query(`
      SELECT DISTINCT r.name
      FROM roles r
      JOIN user_roles ur ON ur.role_id = r.id
      JOIN users u ON u.id = ur.user_id
      WHERE u.is_active = true AND u.status = 'ACTIVE'
    `);
    return new Set(rows.map((r) => r.name));
  }

  /**
   * Printed as one contiguous block rather than lines scattered through the boot sequence —
   * the whole point is that it cannot be missed or read as routine noise.
   */
  private report(checks: StartupCheck[]): void {
    const failed = checks.filter((c) => !c.ok);
    const lines = checks.map((c) => `  ${c.ok ? 'ok  ' : c.critical ? 'FAIL' : 'warn'}  ${c.name.padEnd(22)} ${c.detail}`);
    const body = ['Startup checks', ...lines].join('\n');

    if (failed.some((c) => c.critical)) this.logger.error(body);
    else if (failed.length) this.logger.warn(body);
    else this.logger.log(body);
  }
}
