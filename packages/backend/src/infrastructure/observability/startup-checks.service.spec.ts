import { SystemRole } from '@fapoms/shared';
import { StartupChecksService } from './startup-checks.service';
import { EmailProvider } from '../notifications/email-provider';
import { FcmProvider } from '../notifications/fcm-provider';

/**
 * The startup check exists to replace silence with a statement, so the thing that matters most
 * is that its statements are *true*. Its first version reported email and push as unconfigured
 * on a deployment where both were working — because it constructor-injected providers from a
 * module it could not see, and `@Optional()` turned that into `undefined` without a word. A
 * check that cries wolf is worse than no check: the next real failure reads as noise.
 */

const ALL_ROLES = Object.values(SystemRole).filter((r) => r !== SystemRole.ASSAYER);

function makeService(opts: {
  roles?: string[];
  staffed?: string[];
  email?: boolean | null;
  push?: boolean | null;
  dbNow?: Date;
  /** How a database would answer the runtime-privilege questions. `false` = not hardened. */
  dbRole?: boolean;
}) {
  const roles = opts.roles ?? ALL_ROLES;
  const staffed = opts.staffed ?? ALL_ROLES;

  const dataSource: any = {
    query: jest.fn(async (sql: string) => {
      if (/now\(\)/.test(sql)) return [{ now: opts.dbNow ?? new Date() }];
      if (/user_roles/.test(sql)) return staffed.map((name) => ({ name }));
      // The database-identity checks each ask one boolean question of the catalogue. `opts.dbRole`
      // says how a hardened database would answer; the default is "correctly hardened", so the
      // "everything is fine" case below stays a statement about roles and transports.
      if (/\bok\b/.test(sql)) return [{ ok: opts.dbRole ?? true }];
      return roles.map((name) => ({ name }));
    }),
  };

  const moduleRef: any = {
    get: (type: any) => {
      if (type === EmailProvider) {
        if (opts.email === null) throw new Error('not registered');
        return { isEnabled: () => opts.email ?? true };
      }
      if (type === FcmProvider) {
        if (opts.push === null) throw new Error('not registered');
        return { isEnabled: () => opts.push ?? true };
      }
      throw new Error('unknown');
    },
  };

  return new StartupChecksService(dataSource, moduleRef);
}

const byName = (checks: any[], name: string) => checks.find((c) => c.name === name);

describe('startup checks', () => {
  // Residency is a declared value; the "all ok" cases assume a correctly-declared India deployment.
  // Clock drift reads none of this — its dbNow defaults to now(), so it agrees by construction.
  const savedRegion = process.env.DATA_RESIDENCY_REGION;
  beforeEach(() => { process.env.DATA_RESIDENCY_REGION = 'IN'; });
  afterEach(() => {
    if (savedRegion === undefined) delete process.env.DATA_RESIDENCY_REGION;
    else process.env.DATA_RESIDENCY_REGION = savedRegion;
  });

  it('passes when every role exists, is staffed, and both transports are up', async () => {
    const checks = await makeService({}).run();
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it('refuses a database where the runtime identity is still privileged', async () => {
    // The finding this check exists for: FAPOMS connected as a superuser, so anything holding the
    // application's credential could disable the audit triggers and delete. A deployment that has
    // not run `db:harden` must be told at boot, not during an incident — and marked critical, so
    // STARTUP_CHECKS_STRICT refuses to start rather than degrading politely.
    const checks = await makeService({ dbRole: false }).run();
    const identity = checks.filter((c) => c.name.startsWith('Database identity'));
    expect(identity.length).toBeGreaterThanOrEqual(9);
    expect(identity.every((c) => c.ok)).toBe(false);
    expect(identity.every((c) => c.critical)).toBe(true);
    expect(identity[0].detail).toMatch(/db:harden/);
  });

  it('reports database identity as critical and failed when the catalogue cannot be read', async () => {
    const service = makeService({});
    (service as any).dataSource.query = jest.fn(async (sql: string) => {
      if (/\bok\b/.test(sql)) throw new Error('permission denied for table pg_roles');
      return [];
    });
    const checks = await service.run();
    const identity = checks.filter((c) => c.name.startsWith('Database identity'));
    expect(identity).toHaveLength(1);
    expect(identity[0].ok).toBe(false);
    expect(identity[0].critical).toBe(true);
  });

  it('warns when the app and database clocks disagree (a missing NTP sync)', async () => {
    // DB clock an hour off the app clock — far beyond the 5s threshold.
    const checks = await makeService({ dbNow: new Date(Date.now() + 3_600_000) }).run();
    const clock = byName(checks, 'clock sync');
    expect(clock.ok).toBe(false);
    expect(clock.critical).toBe(false);
    expect(clock.detail).toMatch(/NTP/);
  });

  it('passes the clock check when app and database agree', async () => {
    const checks = await makeService({}).run();
    expect(byName(checks, 'clock sync').ok).toBe(true);
  });

  it('warns when data residency is unset or not India', async () => {
    delete process.env.DATA_RESIDENCY_REGION;
    const unset = await makeService({}).run();
    expect(byName(unset, 'data residency').ok).toBe(false);
    expect(byName(unset, 'data residency').detail).toMatch(/DATA_RESIDENCY_REGION unset/);

    process.env.DATA_RESIDENCY_REGION = 'US';
    const wrong = await makeService({}).run();
    expect(byName(wrong, 'data residency').ok).toBe(false);
    expect(byName(wrong, 'data residency').detail).toMatch(/Indian jurisdiction/);
  });

  it('passes data residency when declared IN (case-insensitive)', async () => {
    process.env.DATA_RESIDENCY_REGION = 'in';
    const checks = await makeService({}).run();
    expect(byName(checks, 'data residency').ok).toBe(true);
  });

  it('reports the transports truthfully rather than assuming they are missing', async () => {
    // The exact regression: providers live in a non-global module. Resolution must find them.
    const checks = await makeService({ email: true, push: true }).run();
    expect(byName(checks, 'email').ok).toBe(true);
    expect(byName(checks, 'push').ok).toBe(true);
  });

  it('distinguishes "not registered" from "registered but unconfigured"', async () => {
    const absent = await makeService({ email: null, push: null }).run();
    expect(byName(absent, 'email').detail).toMatch(/not registered/);

    const off = await makeService({ email: false, push: false }).run();
    expect(byName(off, 'email').detail).toMatch(/NOT configured/);
    expect(byName(off, 'email').ok).toBe(false);
  });

  it('fails critically when a SystemRole has no row — nobody could be given it', async () => {
    const missing = ALL_ROLES.filter((r) => r !== SystemRole.DESK);
    const checks = await makeService({ roles: missing, staffed: missing }).run();

    const roleCheck = byName(checks, 'roles');
    expect(roleCheck.ok).toBe(false);
    expect(roleCheck.critical).toBe(true);
    expect(roleCheck.detail).toContain(SystemRole.DESK);
  });

  it('does not count ASSAYER as missing — assayers are not users', async () => {
    const checks = await makeService({ roles: ALL_ROLES, staffed: ALL_ROLES }).run();
    expect(byName(checks, 'roles').detail).not.toContain('ASSAYER');
  });

  it('warns when an event has roles but none of them are staffed', async () => {
    // Every role exists; nobody holds DESK. DESK_SUBMIT_OVERDUE is addressed to the desk and
    // nowhere else, so it reaches no one — the exact situation that let an approved-but-unsent
    // report go unannounced.
    const staffed = ALL_ROLES.filter((r) => r !== SystemRole.DESK);
    const checks = await makeService({ staffed }).run();

    const recipients = byName(checks, 'notification recipients');
    expect(recipients.ok).toBe(false);
    expect(recipients.detail).toContain('DESK_SUBMIT_OVERDUE');
    // A staffing gap is not a broken deployment — it must not block boot under STRICT.
    expect(recipients.critical).toBe(false);
  });
});
