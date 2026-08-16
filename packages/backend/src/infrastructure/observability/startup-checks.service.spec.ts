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
}) {
  const roles = opts.roles ?? ALL_ROLES;
  const staffed = opts.staffed ?? ALL_ROLES;

  const dataSource: any = {
    query: jest.fn(async (sql: string) =>
      /user_roles/.test(sql)
        ? staffed.map((name) => ({ name }))
        : roles.map((name) => ({ name })),
    ),
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
  it('passes when every role exists, is staffed, and both transports are up', async () => {
    const checks = await makeService({}).run();
    expect(checks.every((c) => c.ok)).toBe(true);
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
    const missing = ALL_ROLES.filter((r) => r !== SystemRole.DATA_ENTRY_HEAD);
    const checks = await makeService({ roles: missing, staffed: missing }).run();

    const roleCheck = byName(checks, 'roles');
    expect(roleCheck.ok).toBe(false);
    expect(roleCheck.critical).toBe(true);
    expect(roleCheck.detail).toContain(SystemRole.DATA_ENTRY_HEAD);
  });

  it('does not count ASSAYER as missing — assayers are not users', async () => {
    const checks = await makeService({ roles: ALL_ROLES, staffed: ALL_ROLES }).run();
    expect(byName(checks, 'roles').detail).not.toContain('ASSAYER');
  });

  it('warns when an event has roles but none of them are staffed', async () => {
    // Roles all exist; nobody holds the desk roles. DESK_SUBMIT_OVERDUE is addressed to
    // DATA_ENTRY_HEAD and VALIDATION_MANAGER only, so it reaches no one — the exact situation
    // that let an approved-but-unsent report go unannounced.
    const staffed = ALL_ROLES.filter(
      (r) => r !== SystemRole.DATA_ENTRY_HEAD && r !== SystemRole.VALIDATION_MANAGER,
    );
    const checks = await makeService({ staffed }).run();

    const recipients = byName(checks, 'notification recipients');
    expect(recipients.ok).toBe(false);
    expect(recipients.detail).toContain('DESK_SUBMIT_OVERDUE');
    // A staffing gap is not a broken deployment — it must not block boot under STRICT.
    expect(recipients.critical).toBe(false);
  });
});
