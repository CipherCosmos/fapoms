/**
 * FAPOMS — Tenant isolation of notifications, against the real database (finding F-07).
 *
 * ## What was wrong
 *
 * Lifecycle notifications were fanned out by ROLE alone. `ASSAYER_ONBOARDED` declares
 * `roles: ['OPERATIONS', 'ADMIN']`, `NotificationDispatchService` contained no reference to
 * `organizationId` anywhere, and `notifications` had no organisational column at all. Activating
 * an assayer in one organisation therefore delivered "R. Nair is now active and available for
 * assignment" — a real person's name, a count, and a working link to their roster record — into
 * the bell of an OPERATIONS user belonging to a DIFFERENT organisation. Reproduced live.
 *
 * ## Why this is a `.db.spec.ts` and not a unit test
 *
 * The unit tests in `notification-dispatch.service.spec.ts` prove the dispatcher honours the
 * tenancy it is handed; they cannot prove the tenancy is derived correctly, because in them it is
 * a mock. Everything load-bearing here lives in the database: which organisation an assayer
 * belongs to, which organisation a user belongs to, the joins `ENTITY_ORGANIZATION_SQL` walks to
 * connect the two, and the SQL the read side filters with. A test that mocked any of those would
 * pass with the join wrong, which is the failure mode most likely to reoccur.
 *
 * So this runs the REAL `NotificationDispatchService`, the REAL `NotificationTenancyService` and
 * the REAL `NotificationService` against real Postgres, with two real organisations. Only the
 * edges that leave the process are stubbed — the Bull queue, the realtime publisher, the audit
 * writer (`audit_events` is append-only; a test has no business adding to it) and the settings
 * cache, which would otherwise need Redis to answer a question this test does not ask.
 *
 * ## Fixtures and safety
 *
 * Every row this creates is identified by an `NFIX-` code and a freshly generated uuid, and
 * everything is deleted by id afterwards. Nothing pre-existing is read into an assertion and
 * nothing pre-existing is written.
 */

import * as path from 'path';
import { DataSource, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { NotificationEntity } from './notification.entity';
import { NotificationPreferenceEntity } from './notification-preference.entity';
import { NotificationDispatchService } from './notification-dispatch.service';
import { NotificationService } from './notification.service';
import { NotificationTenancyService } from './notification-tenancy';
import { NOTIFICATION_CATALOG } from './notification-catalog';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { UserEntity } from '../user/user.entity';
import { RoleEntity } from '../user/role.entity';
import { PermissionEntity } from '../user/permission.entity';
import { ResponsibilityEntity } from '../user/responsibility.entity';
import { AssayerEntity } from '../assayer/assayer.entity';

const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  username: process.env.DB_USERNAME || 'fapoms',
  password: process.env.DB_PASSWORD || 'fapoms_dev',
  database: process.env.DB_DATABASE || 'fapoms',
};

/**
 * The entity closure the notification path actually needs, listed rather than globbed.
 *
 * `data-source.ts` globs `src/**\/*.entity.ts`, which under ts-jest means compiling every entity
 * in the codebase before the first assertion runs. This is the transitive closure of what the
 * dispatcher and the read service touch — notification, its two recipient types, and the role
 * chain the audience query joins through — and nothing else.
 */
/**
 * Every entity, by glob, rather than the handful this file names.
 *
 * A hand-picked list looks tidier and does not work: TypeORM resolves inverse sides eagerly
 * across the whole metadata graph, so naming `ResponsibilityEntity` without whatever declares
 * the other end of its `capabilities` relation aborts initialisation with "Entity metadata for
 * ResponsibilityEntity#capabilities was not found" — before a single assertion runs. Chasing the
 * closure of a relation graph by hand is a losing game and it breaks again the next time somebody
 * adds a relation.
 *
 * Same globs `data-source.ts` uses, and for the same reason it picks between them: `.ts` under
 * ts-node, `.js` against a build. Jest runs this through ts-node, so the source glob is the one
 * that matters here, but the compiled arm keeps it honest if that ever changes.
 */
const ENTITIES = __filename.endsWith('.js')
  ? [path.join(process.cwd(), 'dist/**/*.entity.js'), path.join(process.cwd(), 'dist/modules/**/*.entities.js')]
  : [path.join(process.cwd(), 'src/**/*.entity.ts'), path.join(process.cwd(), 'src/modules/**/*.entities.ts')];

describe('Notification tenant isolation (F-07)', () => {
  jest.setTimeout(60000);

  let ds: DataSource;
  let dispatch: NotificationDispatchService;
  let reads: NotificationService;
  let tenancy: NotificationTenancyService;
  let notifications: Repository<NotificationEntity>;

  /** Every id this spec creates, for the teardown. */
  const created = {
    organizations: [] as string[],
    users: [] as string[],
    assayers: [] as string[],
    notifications: [] as string[],
  };

  const tenant = {
    a: { organizationId: '', opsUserId: '', adminUserId: '', assayerId: '' },
    b: { organizationId: '', opsUserId: '', adminUserId: '', assayerId: '' },
  };

  const suffix = uuidv4().slice(0, 8);

  async function createOrganization(label: string): Promise<string> {
    const id = uuidv4();
    await ds.query(
      `INSERT INTO organizations (id, version, name, code, is_active, created_at, updated_at)
       VALUES ($1, 1, $2, $3, true, now(), now())`,
      [id, `NFIX ${label} ${suffix}`, `NFIX-ORG-${label}-${suffix}`],
    );
    created.organizations.push(id);
    return id;
  }

  async function createUser(label: string, organizationId: string, roleName: string): Promise<string> {
    const id = uuidv4();
    await ds.query(
      `INSERT INTO users (
         id, version, username, email, password_hash, first_name, last_name, display_name,
         status, is_active, organization_id, failed_login_attempts, must_change_password,
         created_at, updated_at
       ) VALUES ($1, 1, $2, $3, 'nfix-not-a-real-hash', 'NFIX', $4, $5, 'ACTIVE', true, $6, 0, false, now(), now())`,
      [id, `NFIX-${label}-${suffix}`, `nfix-${label}-${suffix}@nfix.invalid`.toLowerCase(), label, `NFIX ${label}`, organizationId],
    );
    await ds.query(
      `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name = $2`,
      [id, roleName],
    );
    created.users.push(id);
    return id;
  }

  async function createAssayer(label: string, organizationId: string): Promise<string> {
    const id = uuidv4();
    await ds.query(
      `INSERT INTO assayers (
         id, version, assayer_code, first_name, last_name, display_name,
         address, state, district, city, lifecycle_status, status, is_active,
         organization_id, created_at, updated_at
       ) VALUES ($1, 1, $2, 'NFIX', $3, $4, 'NFIX address', 'KL', 'Thrissur', 'Thrissur',
                 'ACTIVE', 'ACTIVE', true, $5, now(), now())`,
      [id, `NFIX-ASY-${label}-${suffix}`, label, `NFIX Assayer ${label}`, organizationId],
    );
    created.assayers.push(id);
    return id;
  }

  /** The rows one emit produced, read back straight from the table rather than from the result. */
  async function rowsInGroup(groupKey: string) {
    const rows = await ds.query(
      `SELECT id, user_id, assayer_id, organization_id, title, message
         FROM notifications WHERE group_key = $1`,
      [groupKey],
    );
    for (const r of rows) created.notifications.push(r.id);
    return rows as Array<{
      id: string; user_id: string | null; assayer_id: string | null;
      organization_id: string | null; title: string; message: string;
    }>;
  }

  beforeAll(async () => {
    ds = new DataSource({ type: 'postgres', ...DB_CONFIG, synchronize: false, logging: false, entities: ENTITIES });
    await ds.initialize();

    notifications = ds.getRepository(NotificationEntity);
    tenancy = new NotificationTenancyService(ds);

    /**
     * The real region ceiling, not a stub: the two ceilings compose in `emit` and a fixture whose
     * region narrowing silently dropped everybody would make an isolation assertion pass for
     * entirely the wrong reason. `PlatformSettingsService` is only reached by the staged
     * assertions this path never calls.
     */
    const regionGuard = new RegionGuardService(ds, { get: async () => 'off' } as any);

    const settingsStub: any = {
      defFor: async (type: string) => {
        const base = NOTIFICATION_CATALOG[type];
        return base ? { ...base, type, enabled: true, overridden: [], notes: null } : null;
      },
    };
    const auditStub: any = { recordEvent: async () => undefined };
    const publisherStub: any = { publish: () => undefined };
    const queueStub: any = { addBulk: async () => [], add: async () => ({ id: '1' }) };

    dispatch = new NotificationDispatchService(
      notifications,
      ds.getRepository(UserEntity),
      ds.getRepository(NotificationPreferenceEntity),
      auditStub,
      publisherStub,
      queueStub,
      settingsStub,
      regionGuard,
      tenancy,
    );

    reads = new NotificationService(
      notifications,
      ds.getRepository(NotificationPreferenceEntity),
      ds.getRepository(UserEntity),
      ds.getRepository(AssayerEntity),
      { sendToUser: async () => undefined } as any,
      publisherStub,
    );

    tenant.a.organizationId = await createOrganization('A');
    tenant.b.organizationId = await createOrganization('B');

    tenant.a.opsUserId = await createUser('ops-a', tenant.a.organizationId, 'OPERATIONS');
    tenant.a.adminUserId = await createUser('admin-a', tenant.a.organizationId, 'ADMIN');
    tenant.b.opsUserId = await createUser('ops-b', tenant.b.organizationId, 'OPERATIONS');
    tenant.b.adminUserId = await createUser('admin-b', tenant.b.organizationId, 'ADMIN');

    tenant.a.assayerId = await createAssayer('A', tenant.a.organizationId);
    tenant.b.assayerId = await createAssayer('B', tenant.b.organizationId);
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    try {
      // Everything this spec wrote, by id. Notifications first: they hold FKs onto the users and
      // assayers below (ON DELETE CASCADE would take them anyway, but a test should not rely on
      // a cascade to clean up after itself).
      const ids = [
        ...created.notifications,
        ...(await ds.query(
          `SELECT id FROM notifications WHERE user_id = ANY($1) OR assayer_id = ANY($2)`,
          [created.users, created.assayers],
        )).map((r: any) => r.id),
      ];
      if (ids.length) await ds.query(`DELETE FROM notifications WHERE id = ANY($1)`, [ids]);
      if (created.users.length) {
        await ds.query(`DELETE FROM user_roles WHERE user_id = ANY($1)`, [created.users]);
        await ds.query(`DELETE FROM users WHERE id = ANY($1)`, [created.users]);
      }
      if (created.assayers.length) await ds.query(`DELETE FROM assayers WHERE id = ANY($1)`, [created.assayers]);
      if (created.organizations.length) {
        await ds.query(`DELETE FROM organizations WHERE id = ANY($1)`, [created.organizations]);
      }
    } finally {
      await ds.destroy();
    }
  });

  /**
   * The isolation assertions below are only meaningful if the single-tenant shortcut in
   * `NotificationTenancyService` is inactive — with one organisation on the deployment it would
   * answer every lookup and the derivation would never be exercised. Creating two organisations
   * takes the count to three, which turns it off; this states that rather than assuming it.
   */
  it('runs against a genuinely multi-tenant deployment, so the single-tenant shortcut is off', async () => {
    const [{ count }] = await ds.query(`SELECT COUNT(*)::int AS count FROM organizations WHERE is_active = true`);
    expect(count).toBeGreaterThan(1);

    const resolved = await tenancy.resolve(
      { type: 'ASSAYER_ONBOARDED', entityType: 'ASSAYER', entityId: tenant.a.assayerId, payload: {} },
      'TENANT',
    );
    expect(resolved).toMatchObject({ organizationId: tenant.a.organizationId, source: 'ENTITY' });
  });

  describe('the acceptance test: activating an assayer notifies one tenant and not the other', () => {
    it('tenant A activation reaches tenant A staff and nobody in tenant B', async () => {
      const result = await dispatch.emit({
        type: 'ASSAYER_ONBOARDED',
        entityType: 'ASSAYER',
        entityId: tenant.a.assayerId,
        assayerId: tenant.a.assayerId,
        dedupeKey: `NFIX_ASSAYER_ONBOARDED:${tenant.a.assayerId}`,
        payload: { assayerName: `NFIX Assayer A ${suffix}` },
      });

      expect(result.organizationId).toBe(tenant.a.organizationId);

      const rows = await rowsInGroup(result.groupKey);
      const recipients = rows.map((r) => r.user_id).sort();

      expect(recipients).toEqual([tenant.a.opsUserId, tenant.a.adminUserId].sort());
      expect(recipients).not.toContain(tenant.b.opsUserId);
      // The ADMIN half is the deliberate decision, not an accident of the fixture:
      // `CROSS_TENANT_ROLES` lets a platform ADMIN read across organisations, and notifications
      // do not honour that — being pushed another tenant's roster changes is not the same act as
      // choosing to look at them.
      expect(recipients).not.toContain(tenant.b.adminUserId);

      // Every row says whose data it carries, which is what the read side filters on.
      for (const row of rows) expect(row.organization_id).toBe(tenant.a.organizationId);
      // The body names a real person. This is the exact string that crossed the boundary.
      expect(rows[0].message).toContain(`NFIX Assayer A ${suffix}`);

      // Stated from the other side too, straight from the table: tenant B's staff have nothing.
      const [{ count }] = await ds.query(
        `SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = ANY($1)`,
        [[tenant.b.opsUserId, tenant.b.adminUserId]],
      );
      expect(count).toBe(0);
    });

    it('tenant B activation reaches tenant B staff and nobody in tenant A', async () => {
      const before = await ds.query(
        `SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = ANY($1)`,
        [[tenant.a.opsUserId, tenant.a.adminUserId]],
      );

      const result = await dispatch.emit({
        type: 'ASSAYER_ONBOARDED',
        entityType: 'ASSAYER',
        entityId: tenant.b.assayerId,
        assayerId: tenant.b.assayerId,
        dedupeKey: `NFIX_ASSAYER_ONBOARDED:${tenant.b.assayerId}`,
        payload: { assayerName: `NFIX Assayer B ${suffix}` },
      });

      expect(result.organizationId).toBe(tenant.b.organizationId);

      const rows = await rowsInGroup(result.groupKey);
      const recipients = rows.map((r) => r.user_id).sort();

      expect(recipients).toEqual([tenant.b.opsUserId, tenant.b.adminUserId].sort());
      expect(recipients).not.toContain(tenant.a.opsUserId);
      expect(recipients).not.toContain(tenant.a.adminUserId);
      for (const row of rows) expect(row.organization_id).toBe(tenant.b.organizationId);

      // Tenant A's staff gained nothing from tenant B's activation — the count is unchanged from
      // whatever their own activation left them with.
      const after = await ds.query(
        `SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = ANY($1)`,
        [[tenant.a.opsUserId, tenant.a.adminUserId]],
      );
      expect(after[0].count).toBe(before[0].count);
    });
  });

  /**
   * A scoped write with an unscoped read is not a fix. The row planted below is what the world
   * looked like before this change: addressed to a user in one organisation, about an event in
   * another. It must be invisible to them in every direction — list, badge, and both mark-as-read
   * paths — and the last assertion proves it is the ceiling doing that rather than the fixture.
   */
  describe('the read side refuses a row belonging to another organisation', () => {
    let leakedId: string;

    beforeAll(async () => {
      leakedId = uuidv4();
      created.notifications.push(leakedId);
      await ds.query(
        `INSERT INTO notifications (
           id, version, is_active, user_id, organization_id, title, message, is_read,
           type, category, priority, status, channels, created_at, updated_at
         ) VALUES ($1, 1, true, $2, $3, 'NFIX leaked row', 'NFIX cross-tenant row', false,
                   'ASSAYER_ONBOARDED', 'WORKFORCE', 'LOW', 'DELIVERED', '["IN_APP"]'::jsonb, now(), now())`,
        [leakedId, tenant.b.opsUserId, tenant.a.organizationId],
      );
    });

    it('does not list it, does not count it, and will not let it be marked read', async () => {
      const page = await reads.findByUser(tenant.b.opsUserId, {}, tenant.b.organizationId);
      expect(page.items.map((i) => i.id)).not.toContain(leakedId);

      /**
       * The count is asserted against the row that SHOULD be there, not against zero.
       *
       * This user has a legitimate unread notification by now: the acceptance test above
       * activated tenant B's assayer and correctly delivered it to tenant B's staff, which is
       * this same person. Asserting `toBe(0)` would fail for the one reason the suite is meant to
       * prove is working, and would have to be "fixed" by weakening the test that proves it.
       *
       * So: whatever is in the bell, none of it is the leaked row, and the count agrees with the
       * list it came back with.
       */
      expect(page.unreadCount).toBe(page.items.filter((i) => !i.isRead).length);
      expect(page.items.map((i) => i.id)).not.toContain(leakedId);

      await expect(reads.markAsRead(leakedId, tenant.b.opsUserId, tenant.b.organizationId)).rejects.toThrow();
      await reads.markAllAsRead(tenant.b.opsUserId, tenant.b.organizationId);

      const [{ is_read }] = await ds.query(`SELECT is_read FROM notifications WHERE id = $1`, [leakedId]);
      expect(is_read).toBe(false);
    });

    it('would have shown it without the ceiling — so it is the ceiling hiding it, not the fixture', async () => {
      const unscoped = await reads.findByUser(tenant.b.opsUserId, {});
      expect(unscoped.items.map((i) => i.id)).toContain(leakedId);
    });
  });

  /**
   * The derivation table is the one part of this that cannot fail loudly on its own: a typo in a
   * join does not throw at compile time, and at runtime `lookup` catches, answers "unknown", and
   * the type quietly stops being delivered to anybody. Executing every statement against the real
   * schema is the only way that mistake shows up as a red test rather than as silence.
   */
  it('every entity-to-organisation lookup is valid against the live schema', async () => {
    const unknownId = uuidv4();
    for (const kind of NotificationTenancyService.entityLookupKinds()) {
      const sql = NotificationTenancyService.entityLookupSql(kind);
      await expect(ds.query(sql, [unknownId])).resolves.toBeDefined();
    }
  });

  it('derives the organisation from an assayer named only in the payload', async () => {
    // The redundancy that lets ~50 call sites keep their existing shape: no entityType this
    // knows, but the payload carries an assayer.
    const resolved = await tenancy.resolve(
      { type: 'ASSAYER_ONBOARDED', entityType: 'SOMETHING_UNKNOWN', entityId: uuidv4(), payload: { assayerId: tenant.b.assayerId } },
      'TENANT',
    );
    expect(resolved).toMatchObject({ organizationId: tenant.b.organizationId, source: 'ENTITY' });
  });

  it('refuses rather than guesses when nothing on the event names a tenant', async () => {
    const resolved = await tenancy.resolve(
      { type: 'PAYABLE_AWAITING_APPROVAL', entityType: 'PAYABLE', entityId: 'backlog', payload: { count: 3 } },
      'TENANT',
    );
    expect(resolved.organizationId).toBeNull();
    expect(resolved.source).toBe('UNRESOLVED');
  });
});
