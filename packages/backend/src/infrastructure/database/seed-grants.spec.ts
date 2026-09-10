import { ROLE_PERMISSIONS, ALL_GRANTED_PERMISSIONS } from '../../modules/auth/role-permissions';
import {
  buildPermissionCatalogue,
  mergeRelation,
  permissionKey,
  resolveGrant,
  PermissionSpec,
} from './seed-grants';

/**
 * THE SEED MAY ADD. IT MAY NOT NARROW.
 *
 * Measured on the live deployment on 2026-09-10: ADMIN held 57 of the 63 grants the code table
 * declares, DEVELOPER 57 of 64, OPERATIONS 36 of 39, DESK_OPERATOR 3 of 6. Nineteen grants gone,
 * including the only `SYSTEM:APPROVE:PLATFORM` in the system — so no principal could approve a
 * destructive request and the two-person data-wipe rule could not be completed by anybody.
 *
 * Two independent faults, each of which alone was survivable:
 *
 *  1. the permission list the seed writes had fallen twelve keys behind `ROLE_PERMISSIONS`, and
 *     a key with no row was dropped by `.filter(Boolean)` rather than reported;
 *  2. roles were loaded without their `permissions` relation, so the merge that the code's own
 *     comment describes as "merge, never replace" started from an empty map — and assigning a
 *     many-to-many in TypeORM deletes every junction row the new array does not name.
 *
 * These cases pin the three decisions. They are not the whole proof: what a seed does to a
 * database is proven against a database, by `verify-migrations-from-empty.mjs`, which builds one
 * from template0, migrates, seeds, and compares every role's rows to what it declares.
 */
describe('the permission catalogue covers every grant that is handed out', () => {
  const listed: PermissionSpec[] = [
    { resource: 'PROJECT', action: 'VIEW', scope: 'PLATFORM', description: 'View all projects' },
  ];

  it('keeps the hand-written entries, descriptions and all', () => {
    const catalogue = buildPermissionCatalogue(listed);
    expect(catalogue).toEqual(expect.arrayContaining(listed));
  });

  it('adds a row for every key ROLE_PERMISSIONS grants and the list forgot', () => {
    const keys = new Set(buildPermissionCatalogue(listed).map(permissionKey));
    const missing = ALL_GRANTED_PERMISSIONS.filter(k => !keys.has(k));
    expect(missing).toEqual([]);
  });

  it('covers the twelve that were missing, by name', () => {
    // Named rather than counted: a future edit that drops one of these should say which.
    const keys = new Set(buildPermissionCatalogue(listed).map(permissionKey));
    for (const key of [
      'ASSAYER:VIEW:ORGANIZATION',
      'DOCUMENT:VIEW:ORGANIZATION',
      'REFERENCE_DATA:VIEW:ORGANIZATION',
      'VALIDATION:VIEW:ORGANIZATION',
      'ORGANIZATION:CREATE:ORGANIZATION',
      'ORGANIZATION:EDIT:ORGANIZATION',
      'ORGANIZATION:DELETE:ORGANIZATION',
      'OCR:CREATE:ORGANIZATION',
      'OCR:EDIT:ORGANIZATION',
      'SYSTEM:VIEW:PLATFORM',
      'SYSTEM:EDIT:PLATFORM',
      'SYSTEM:APPROVE:PLATFORM',
    ]) {
      expect(keys.has(key)).toBe(true);
    }
  });

  it('adds nothing twice when the list is already complete', () => {
    const complete = ALL_GRANTED_PERMISSIONS.map((key): PermissionSpec => {
      const [resource, action, scope] = key.split(':');
      return { resource, action, scope, description: 'listed by hand' };
    });
    const catalogue = buildPermissionCatalogue(complete);
    expect(catalogue).toHaveLength(complete.length);
    expect(catalogue.every(p => p.description === 'listed by hand')).toBe(true);
  });

  it('describes a derived row well enough to read in the permissions table', () => {
    const derived = buildPermissionCatalogue([]).find(p => permissionKey(p) === 'SYSTEM:APPROVE:PLATFORM');
    expect(derived?.description).toBe('APPROVE SYSTEM (PLATFORM)');
  });

  it('is the same set the roles are built from, so neither half can drift alone', () => {
    // Every grant in the code table belongs to at least one role; the catalogue covers all of
    // them. If ROLE_PERMISSIONS ever grants a key no role holds, this is where it shows up.
    const granted = new Set(Object.values(ROLE_PERMISSIONS).flat());
    expect([...granted].sort()).toEqual(ALL_GRANTED_PERMISSIONS);
  });
});

describe('a declared grant that resolves to nothing stops the run', () => {
  const map = new Map([['PROJECT:VIEW:PLATFORM', { id: 'p1' }]]);

  it('returns what is there', () => {
    expect(resolveGrant(map, 'PROJECT:VIEW:PLATFORM', 'role ADMIN')).toEqual({ id: 'p1' });
  });

  it('throws rather than quietly handing back a shorter list', () => {
    expect(() => resolveGrant(map, 'SYSTEM:APPROVE:PLATFORM', 'role ADMIN'))
      .toThrow(/role ADMIN is declared to hold SYSTEM:APPROVE:PLATFORM/);
  });

  it('names who wanted it, because the same key is asked for by several holders', () => {
    expect(() => resolveGrant(map, 'OCR:EDIT:ORGANIZATION', 'capability OCR_EDIT'))
      .toThrow(/capability OCR_EDIT/);
  });
});

describe('merging a relation cannot remove what the row already had', () => {
  const existing = [{ id: 'a' }, { id: 'b' }];

  it('unions, keeping grants this seed does not know about', () => {
    // HOLIDAY, ZONE, PLANNING, BILLING and CUSTOMER_MASTER arrive by migration and are absent
    // from the seed's lists. A replace would strip them; that outage is what the merge exists for.
    const merged = mergeRelation(existing, [{ id: 'b' }, { id: 'c' }], 'role OPERATIONS permissions');
    expect(merged.map(m => m.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('keeps one entry per id when both sides name it', () => {
    const merged = mergeRelation(existing, [{ id: 'a' }], 'role ADMIN permissions');
    expect(merged).toHaveLength(2);
  });

  it('refuses an unloaded relation instead of treating it as empty', () => {
    // This is the live defect, exactly: `roleRepository.find()` leaves the relation undefined,
    // the old code read it as `?? []`, and the assignment that followed deleted every grant the
    // seed's own list did not name.
    expect(() => mergeRelation(undefined, [{ id: 'a' }], 'role ADMIN permissions'))
      .toThrow(/role ADMIN permissions was loaded without its relation/);
  });

  it('accepts an empty relation, which is a loaded row that genuinely holds nothing', () => {
    expect(mergeRelation([], [{ id: 'a' }], 'role PRODUCT_SUPPORT permissions')).toEqual([{ id: 'a' }]);
  });
});
