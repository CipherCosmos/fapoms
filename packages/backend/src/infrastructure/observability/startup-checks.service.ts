import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SystemRole } from '@fapoms/shared';
import { EmailProvider } from '../notifications/email-provider';
import { FcmProvider } from '../notifications/fcm-provider';
import { NOTIFICATION_CATALOG } from '../../modules/notifications/notification-catalog';
import { RUNTIME_ASSERTIONS } from '../database/roles/role-model';

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

    // ── Clock sync (NTP) ─────────────────────────────────────────────────────
    // Audit timestamps and the hash chain's ordering are only as trustworthy as the clock behind
    // them, and CERT-In 2022 requires ICT systems to be NTP-synced (to NPL/NIC in India). This
    // cannot verify the NTP daemon from inside the process, but it CAN catch the symptom that
    // matters: the app server and the database disagreeing about the time. A large drift means one
    // of them is not synced, and audit rows will carry a time nobody can trust.
    checks.push(await this.clockDriftCheck());

    // ── Data residency ───────────────────────────────────────────────────────
    // CERT-In requires logs stored within India; RBI's outsourcing direction requires customer data
    // stored only in India. The app cannot detect where it is hosted, so this is a declared value —
    // a deliberate acknowledgement that the operator has confirmed India-only hosting, and a loud
    // reminder in the boot log when they have not.
    checks.push(this.dataResidencyCheck());

    // ── Database identity ────────────────────────────────────────────────────
    // The audit trail is append-only by trigger, and a trigger is only as strong as the identity
    // that could remove it. This deployment used to connect as a superuser, so anything holding
    // the application's credential could `ALTER TABLE audit_events DISABLE TRIGGER` and then
    // delete at will — demonstrated in a throwaway database on 2026-09-09. The role split in
    // `database/roles/role-model.ts` closes that, and this is where a deployment finds out it was
    // not applied: at boot, in the log, rather than during an incident.
    checks.push(...(await this.databaseIdentityChecks()));

    this.last = checks;
    return checks;
  }

  /**
   * What the runtime's own database identity can do, asked of the database rather than assumed.
   *
   * The list is `RUNTIME_ASSERTIONS`, shared with `db:harden` and with
   * `runtime-privileges.db.spec.ts`, so the property the deployment verifies and the property the
   * tests assert are one list rather than three that can drift apart.
   *
   * Critical, so `STARTUP_CHECKS_STRICT=true` refuses the boot. A deployment running as a
   * superuser is not degraded, it is unprotected, and the whole point of the split is that the
   * protection cannot be assumed from the fact that the code is correct.
   *
   * A failure to RUN the queries is reported as one failed check rather than thrown: a database
   * that cannot answer `SELECT rolsuper FROM pg_roles` has a bigger problem than this, and the
   * other checks above should still get to say what they found.
   */
  private async databaseIdentityChecks(): Promise<StartupCheck[]> {
    try {
      const out: StartupCheck[] = [];
      for (const { what, sql } of RUNTIME_ASSERTIONS) {
        const rows = await this.dataSource.query(sql);
        const ok = rows?.[0]?.ok === true;
        out.push({
          name: `Database identity: ${what}`,
          ok,
          detail: ok
            ? 'yes'
            : 'NO — run `npm run db:harden` against this database, and check DB_USERNAME is the runtime role',
          critical: true,
        });
      }
      return out;
    } catch (err) {
      return [{
        name: 'Database identity',
        ok: false,
        detail: `could not be determined: ${(err as Error).message}`,
        critical: true,
      }];
    }
  }

  /** App-vs-database clock drift — the observable symptom of a missing NTP sync. */
  private async clockDriftCheck(): Promise<StartupCheck> {
    const thresholdMs = Number(process.env.CLOCK_DRIFT_WARN_MS) || 5_000;
    try {
      const before = Date.now();
      const rows: Array<{ now: string | Date }> = await this.dataSource.query('SELECT now() AS now');
      const after = Date.now();
      // Charge the round-trip to the app side of the comparison so query latency cannot masquerade
      // as drift: the DB clock is compared against the midpoint of when we could have observed it.
      const appMid = before + (after - before) / 2;
      const driftMs = Math.abs(new Date(rows[0].now).getTime() - appMid);
      return {
        name: 'clock sync',
        ok: driftMs <= thresholdMs,
        critical: false,
        detail: driftMs <= thresholdMs
          ? `app and database clocks agree within ${Math.round(driftMs)} ms`
          : `app and database clocks differ by ${Math.round(driftMs)} ms (> ${thresholdMs} ms) — check NTP sync (CERT-In requires it); audit timestamps may be unreliable`,
      };
    } catch (err) {
      return { name: 'clock sync', ok: false, critical: false, detail: `could not compare clocks: ${(err as Error).message}` };
    }
  }

  /** Declared hosting region — India is required for logs (CERT-In) and customer data (RBI). */
  private dataResidencyCheck(): StartupCheck {
    const region = (process.env.DATA_RESIDENCY_REGION || '').trim().toUpperCase();
    if (!region) {
      return {
        name: 'data residency',
        ok: false,
        critical: false,
        detail: 'DATA_RESIDENCY_REGION unset — confirm this deployment (database, object store, logs) is hosted in India, then set it to IN. CERT-In requires logs in India; RBI requires customer data stored only in India.',
      };
    }
    return {
      name: 'data residency',
      ok: region === 'IN',
      critical: false,
      detail: region === 'IN'
        ? 'declared India (IN)'
        : `declared "${region}" — CERT-In and RBI require Indian jurisdiction for logs and customer data; a non-IN region is almost certainly a misconfiguration`,
    };
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
