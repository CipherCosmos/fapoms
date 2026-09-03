import { SystemRole } from '@fapoms/shared';

/**
 * Which permissions each role holds — the one table, in one place.
 *
 * Two things decide who may call a route: `@Roles(...)`, which names the audience and denies
 * anything it does not name, and `@RequirePermissions('resource:action:scope')`, which the
 * PermissionsGuard resolves against the grants below. Both must pass. So a role named by
 * `@Roles` but missing the route's permission is refused — while the code says it is allowed.
 * That is a bug every time, and `route-permission-parity.spec.ts` fails the build on it.
 *
 * These lists are the union of what the thirteen roles they replaced held, so nobody lost an
 * ability in the consolidation — see `LEGACY_ROLE_ALIASES` for what became what. The grants
 * lived partly in the seed and partly across a chain of migrations before this, so what a role
 * actually held could not be read anywhere.
 *
 * A grant with scope PLATFORM implies every narrower scope — see PermissionsGuard.
 */
/**
 * Seven read grants added on 2026-09-03, after the roles screen was made to actually work.
 *
 * Each was a role that could WRITE a resource it could not READ: OPERATIONS could create, edit and
 * delete an assayer without holding ASSAYER:VIEW; DESK could create and edit a validation it could
 * not view; and so on for documents and reference data. That was invisible while `@Roles(...)` was
 * the only gate, because the role's NAME opened the route and the permission table was never
 * consulted. It stopped being invisible the moment permissions became authoritative: annotating a
 * list endpoint with `resource:view:*` would have locked out the very roles that own the screen.
 *
 * These grants are strictly weaker than the write grants each role already held on the same
 * resource, and every one of those routes was already reachable by name, so nothing gained access
 * it did not have. What changed is that the table now says so.
 */
export const ROLE_PERMISSIONS: Record<SystemRole, string[]> = {
  /**
   * Everything. ADMIN is the union of what SUPER_ADMINISTRATOR and ADMINISTRATOR held —
   * they differed by seven routes, all of them the product-feedback queue, which PRODUCT_SUPPORT
   * owns and ADMIN keeps a copy of so nothing waits on that role being staffed.
   */
  [SystemRole.ADMIN]: [
    'ASSAYER:CREATE:ORGANIZATION',
    'ASSAYER:DELETE:ORGANIZATION',
    'ASSAYER:EDIT:ORGANIZATION',
    'ASSAYER:VIEW:PLATFORM',
    'ASSIGNMENT:ACCEPT:SELF',
    'ASSIGNMENT:CANCEL:ORGANIZATION',
    'ASSIGNMENT:CREATE:ORGANIZATION',
    'ASSIGNMENT:NEGOTIATE:ORGANIZATION',
    'ASSIGNMENT:VIEW:ASSIGNED_RECORDS',
    'ASSIGNMENT:VIEW:PLATFORM',
    'AUDIT_LOG:VIEW:PLATFORM',
    'BILLING:APPROVE:ORGANIZATION',
    'BILLING:CREATE:ORGANIZATION',
    'BILLING:EDIT:ORGANIZATION',
    'BILLING:VIEW:PLATFORM',
    'BRANCH:CREATE:ORGANIZATION',
    'BRANCH:DELETE:ORGANIZATION',
    'BRANCH:EDIT:ORGANIZATION',
    'BRANCH:IMPORT:ORGANIZATION',
    'BRANCH:VIEW:PLATFORM',
    'CLIENT:CREATE:ORGANIZATION',
    'CLIENT:DELETE:ORGANIZATION',
    'CLIENT:EDIT:ORGANIZATION',
    'CLIENT:VIEW:PLATFORM',
    'CONFIGURATION:EDIT:PLATFORM',
    'CONFIGURATION:VIEW:PLATFORM',
    'DOCUMENT:CREATE:ORGANIZATION',
    'DOCUMENT:DOWNLOAD:PLATFORM',
    'DOCUMENT:EDIT:ORGANIZATION',
    'DOCUMENT:GENERATE:ORGANIZATION',
    'DOCUMENT:UPLOAD:ORGANIZATION',
    'DOCUMENT:VIEW:PLATFORM',
    'OCR:CREATE:ORGANIZATION',
    'OCR:EDIT:ORGANIZATION',
    'ORGANIZATION:CREATE:ORGANIZATION',
    'ORGANIZATION:DELETE:ORGANIZATION',
    'ORGANIZATION:EDIT:ORGANIZATION',
    'PLANNING:CREATE:ORGANIZATION',
    'PLANNING:DELETE:ORGANIZATION',
    'PLANNING:EDIT:ORGANIZATION',
    'PLANNING:VIEW:PLATFORM',
    'PROJECT:ARCHIVE:ORGANIZATION',
    'PROJECT:CLOSE:ORGANIZATION',
    'PROJECT:CREATE:ORGANIZATION',
    'PROJECT:DELETE:ORGANIZATION',
    'PROJECT:EDIT:ORGANIZATION',
    'PROJECT:VIEW:PLATFORM',
    'REFERENCE_DATA:CREATE:ORGANIZATION',
    'REFERENCE_DATA:DELETE:ORGANIZATION',
    'REFERENCE_DATA:EDIT:ORGANIZATION',
    'REFERENCE_DATA:VIEW:PLATFORM',
    'SCHEDULING:CREATE:ORGANIZATION',
    'SCHEDULING:MODIFY:ORGANIZATION',
    'SCHEDULING:VIEW:PLATFORM',
    'USER:CREATE:PLATFORM',
    'USER:EDIT:PLATFORM',
    'USER:VIEW:PLATFORM',
    'VALIDATION:APPROVE:ORGANIZATION',
    'VALIDATION:ASSIGN:ORGANIZATION',
    'VALIDATION:CREATE:ORGANIZATION',
    'VALIDATION:EDIT:ORGANIZATION',
    'VALIDATION:REVIEW:ASSIGNED_RECORDS',
    'VALIDATION:VIEW:PLATFORM',
  ],

  /**
   * The work, the money and the workforce, folded into one. The union of what
   * OPERATIONS_MANAGER, OPERATIONS_EXECUTIVE, FINANCE_MANAGER and HR_MANAGER held. The executive
   * grade had no grant of its own; finance and workforce were folded in deliberately — see the
   * note on SystemRole.OPERATIONS about the approval gate that trade gives up.
   */
  [SystemRole.OPERATIONS]: [
    'ASSAYER:CREATE:ORGANIZATION',
    'ASSAYER:DELETE:ORGANIZATION',
    'ASSAYER:EDIT:ORGANIZATION',
    'ASSAYER:VIEW:ORGANIZATION',
    'ASSIGNMENT:CANCEL:ORGANIZATION',
    'ASSIGNMENT:CREATE:ORGANIZATION',
    'ASSIGNMENT:NEGOTIATE:ORGANIZATION',
    'ASSIGNMENT:VIEW:PLATFORM',
    'BILLING:APPROVE:ORGANIZATION',
    'BILLING:CREATE:ORGANIZATION',
    'BILLING:EDIT:ORGANIZATION',
    'BILLING:VIEW:PLATFORM',
    'BRANCH:CREATE:ORGANIZATION',
    'BRANCH:EDIT:ORGANIZATION',
    'BRANCH:IMPORT:ORGANIZATION',
    'BRANCH:VIEW:PLATFORM',
    'CLIENT:CREATE:ORGANIZATION',
    'CLIENT:EDIT:ORGANIZATION',
    'CLIENT:VIEW:PLATFORM',
    'DOCUMENT:CREATE:ORGANIZATION',
    'DOCUMENT:DOWNLOAD:PLATFORM',
    'DOCUMENT:GENERATE:ORGANIZATION',
    'DOCUMENT:UPLOAD:ORGANIZATION',
    'DOCUMENT:VIEW:ORGANIZATION',
    'PLANNING:CREATE:ORGANIZATION',
    'PLANNING:EDIT:ORGANIZATION',
    'PLANNING:VIEW:PLATFORM',
    'PROJECT:ARCHIVE:ORGANIZATION',
    'PROJECT:CLOSE:ORGANIZATION',
    'PROJECT:CREATE:ORGANIZATION',
    'PROJECT:DELETE:ORGANIZATION',
    'PROJECT:EDIT:ORGANIZATION',
    'PROJECT:VIEW:PLATFORM',
    'REFERENCE_DATA:CREATE:ORGANIZATION',
    'REFERENCE_DATA:DELETE:ORGANIZATION',
    'REFERENCE_DATA:EDIT:ORGANIZATION',
    'REFERENCE_DATA:VIEW:ORGANIZATION',
    'SCHEDULING:CREATE:ORGANIZATION',
    'SCHEDULING:MODIFY:ORGANIZATION',
    'SCHEDULING:VIEW:PLATFORM',
  ],

  /**
   * The whole paperwork pipeline: the union of DOCUMENT_EXECUTIVE (packets out),
   * DATA_ENTRY_HEAD (packets back, data entry, validation) and VALIDATION_MANAGER, which could
   * do nothing the head could not.
   */
  [SystemRole.DESK]: [
    'ASSAYER:VIEW:ORGANIZATION',
    'ASSIGNMENT:VIEW:PLATFORM',
    'BRANCH:VIEW:PLATFORM',
    'DOCUMENT:CREATE:ORGANIZATION',
    'DOCUMENT:DOWNLOAD:PLATFORM',
    'DOCUMENT:EDIT:ORGANIZATION',
    'DOCUMENT:GENERATE:ORGANIZATION',
    'DOCUMENT:UPLOAD:ORGANIZATION',
    'DOCUMENT:VIEW:ORGANIZATION',
    'OCR:EDIT:ORGANIZATION',
    'PROJECT:VIEW:PLATFORM',
    'SCHEDULING:VIEW:PLATFORM',
    'VALIDATION:CREATE:ORGANIZATION',
    'VALIDATION:EDIT:ORGANIZATION',
    'VALIDATION:VIEW:ORGANIZATION',
  ],

  /**
   * What VALIDATOR held: enough to take a packet from the queue, type it up and
   * hand it back. Strictly less than DESK, which is the point of it.
   */
  [SystemRole.DESK_OPERATOR]: [
    'ASSAYER:VIEW:ORGANIZATION',
    'DOCUMENT:DOWNLOAD:PLATFORM',
    'DOCUMENT:VIEW:ORGANIZATION',
    'PROJECT:VIEW:PLATFORM',
    'VALIDATION:REVIEW:ASSIGNED_RECORDS',
    'VALIDATION:VIEW:ORGANIZATION',
  ],

  /**
   * Read-only oversight; formerly READ_ONLY_AUDITOR. Every grant here is a VIEW.
   */
  [SystemRole.AUDITOR]: [
    'ASSAYER:VIEW:ORGANIZATION',
    'ASSIGNMENT:VIEW:PLATFORM',
    'AUDIT_LOG:VIEW:PLATFORM',
    'BILLING:VIEW:PLATFORM',
    'BRANCH:VIEW:PLATFORM',
    'CLIENT:VIEW:PLATFORM',
    // Named by `@Roles` on every document read it can reach — the list, the stats, the operations
    // overview, the chain-of-custody trail, the data entry queue — and granted none of them. The
    // name opened those routes while nothing declared a permission; the moment they declare one,
    // the auditor is refused the screen it was explicitly admitted to.
    'DOCUMENT:VIEW:ORGANIZATION',
    'PLANNING:VIEW:PLATFORM',
    'PROJECT:VIEW:PLATFORM',
    'SCHEDULING:VIEW:PLATFORM',
  ],

  /**
   * No grants. The feedback queue this role owns is gated by `@Roles` alone, so
   * an empty list denies nothing. Stated rather than omitted.
   */
  [SystemRole.PRODUCT_SUPPORT]: [],

  /**
   * No grants, and none possible: an assayer authenticates from the `assayers` table and
   * has no row in `roles`. Every route they reach is gated by name alone.
   */
  [SystemRole.ASSAYER]: [],

  /**
   * The client's own people, seeing their own work. An external principal.
   */
  [SystemRole.CLIENT_USER]: [
    'BRANCH:VIEW:PLATFORM',
    'PROJECT:VIEW:PLATFORM',
    'SCHEDULING:VIEW:PLATFORM',
  ],
};

/** Every permission any role is granted — what the `permissions` table must contain. */
export const ALL_GRANTED_PERMISSIONS: string[] = [
  ...new Set(Object.values(ROLE_PERMISSIONS).flat()),
].sort();
