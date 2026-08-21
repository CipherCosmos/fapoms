import { ForbiddenException } from '@nestjs/common';
import { SystemRole } from '@fapoms/shared';

/**
 * Field-level visibility for assayer records.
 *
 * Restricting *which endpoints* a role may call is not enough. Everyone who plans work needs to
 * see an assayer; almost nobody needs to see their Aadhaar number or their bank account. Every
 * reader used to receive the whole row, and the list endpoint was public, so those fields left
 * the system entirely.
 *
 * Who sees what follows from what the role has to do. OPERATIONS onboards assayers and pays
 * them — it absorbed the separate HR and finance roles — so it sees the identity documents it
 * has to verify and the bank details it has to pay into. That is a real widening compared with
 * when those were three roles: an operations user can now read every assayer's identity and
 * banking, where before a planner could read neither. It is the cost of one role doing all
 * three jobs, and it is worth re-reading if the team ever grows enough to separate them again.
 *
 * DESK, DESK_OPERATOR and AUDITOR see the operational subset: enough to know who did the work,
 * nothing about who they are. An assayer always sees their own record in full.
 */

/** Identity and personal data. Read to verify a new joiner, and for no other reason. */
const IDENTITY_FIELDS = [
  'panNumber', 'aadhaarNumber', 'dateOfBirth',
  'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation',
  'governmentDocuments',
];

/** Banking details. Read to pay someone, and for no other reason. */
const BANKING_FIELDS = ['bankAccountNumber', 'ifscCode', 'bankName', 'accountHolderName'];

/** Never returned to anyone through the API, whatever the role. */
const NEVER_EXPOSED = ['passwordHash'];

/**
 * The roles that onboard and pay assayers, and therefore see the whole record.
 *
 * Deliberately short. Adding a role here hands it every assayer's identity documents and bank
 * account at once — there is no partial entry.
 */
const FULL_ACCESS: string[] = [SystemRole.ADMIN, SystemRole.OPERATIONS];

/**
 * Strips fields the viewer's roles are not entitled to.
 *
 * `isSelf` lets an assayer see their own banking and personal details in the
 * mobile app without opening anyone else's.
 */
export function scopeAssayerForRoles<T extends Record<string, any>>(
  record: T,
  roles: string[],
  isSelf = false,
): Partial<T> {
  if (!record) return record;
  const out: Record<string, any> = { ...record };

  for (const f of NEVER_EXPOSED) delete out[f];

  const hasFull = roles.some((r) => FULL_ACCESS.includes(r));
  // Both gates read the same way now that one role does the onboarding and the paying. They
  // stay separate expressions because they answer different questions, and the moment the team
  // splits those jobs again this is the line that has to change, not the whole function.
  const canSeeBanking = hasFull || isSelf;
  const canSeeIdentity = hasFull || isSelf;

  if (!canSeeBanking) for (const f of BANKING_FIELDS) delete out[f];
  if (!canSeeIdentity) for (const f of IDENTITY_FIELDS) delete out[f];

  return out as Partial<T>;
}

export function scopeAssayerListForRoles<T extends Record<string, any>>(
  records: T[],
  roles: string[],
  selfId?: string,
): Partial<T>[] {
  return (records ?? []).map((r) => scopeAssayerForRoles(r, roles, !!selfId && r.id === selfId));
}

/**
 * Strip assayer identity and banking from a whole response, wherever they appear in it.
 *
 * `scopeAssayerForRoles` guards the four assayer routes. It guarded nothing else, and the
 * assayer record is joined into a great deal: schedules, assignments, the operations inbox,
 * documents, clarification threads. `pan_number` and `bank_account_number` decrypt on entity
 * load through a column transformer, so every one of those joins returned them in clear — to
 * DESK, DESK_OPERATOR and AUDITOR, the exact roles the comment at the top of this file says
 * must not see them. The front door was locked and the side windows were open.
 *
 * Rather than remember to redact at each of a dozen call sites, this walks the payload and
 * applies the same policy to anything that *is* an assayer — identified by carrying both an
 * `id` and an `assayerCode`, so it works however deeply the relation is nested and whatever
 * the property is called. A payload with no assayer in it is returned untouched.
 *
 * Cost is one pass over an object graph the database has already produced; against the query
 * that fetched it, that is nothing.
 */
export function redactAssayersDeep<T>(payload: T, roles: string[], selfId?: string): T {
  const hasFull = roles.some((r) => FULL_ACCESS.includes(r));
  // Nothing to strip for a role that may see everything — skip the walk entirely.
  if (hasFull) return payload;

  // Guards against a cyclic graph: TypeORM hands back parent↔child references in both
  // directions, and a naive walk would not terminate.
  const seen = new WeakSet<object>();

  const walk = (node: any): any => {
    if (node === null || typeof node !== 'object') return node;
    if (seen.has(node)) return node;
    seen.add(node);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) node[i] = walk(node[i]);
      return node;
    }

    // Dates, Buffers and the like are objects but carry nothing to redact, and copying them
    // would break their prototypes.
    if (node instanceof Date || Buffer.isBuffer(node)) return node;

    if (typeof node.assayerCode === 'string' && 'id' in node) {
      const isSelf = !!selfId && node.id === selfId;
      const scoped = scopeAssayerForRoles(node as Record<string, any>, roles, isSelf);
      // Delete in place rather than returning a copy: the node may be referenced from several
      // places in the graph, and replacing only this one would leave the others unredacted.
      for (const key of Object.keys(node)) {
        if (!(key in scoped)) delete node[key];
      }
    }

    for (const key of Object.keys(node)) node[key] = walk(node[key]);
    return node;
  };

  return walk(payload);
}

/**
 * `req.user.roles` holds RoleEntity rows for staff logins but plain `{ name }`
 * objects for assayer tokens (see AuthService.validateJwtPayload). Normalise both
 * to names so callers don't have to care which kind of principal they have.
 */
export function rolesOf(user: any): string[] {
  return (user?.roles ?? []).map((r: any) => (typeof r === 'string' ? r : r?.name)).filter(Boolean);
}

/** True when the principal is an assayer acting on records other than their own. */
export function isAssayerActingOnAnother(user: any, targetAssayerId: string): boolean {
  return rolesOf(user).includes('ASSAYER') && user?.id !== targetAssayerId;
}

/**
 * Rejects an assayer touching another assayer's record.
 *
 * Call sites previously wrote `req.user.role === SystemRole.ASSAYER && req.user.id !== id`.
 * `req.user` has no scalar `role` — `AuthService.validateJwtPayload` returns
 * `roles: [{ name: 'ASSAYER' }]` — so that condition was permanently `undefined === 'ASSAYER'`,
 * i.e. always false. The guard read as if it protected the record and in fact never once ran:
 * any assayer could write KYC and government-ID documents onto any other assayer's HR file.
 *
 * Centralised here so the roles-array shape is handled in exactly one place and the mistake
 * cannot be repeated by copying the old pattern.
 */
export function assertSelfOrPrivileged(user: any, targetAssayerId: string, action = 'modify this record'): void {
  if (isAssayerActingOnAnother(user, targetAssayerId)) {
    throw new ForbiddenException(`You can only ${action} on your own record.`);
  }
}
