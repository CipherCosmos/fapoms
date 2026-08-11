import { ForbiddenException } from '@nestjs/common';
import { SystemRole } from '@fapoms/shared';

/**
 * Field-level visibility for assayer records.
 *
 * Restricting *which endpoints* a role may call is not enough: operations need to
 * see an assayer to plan work, but have no business seeing their PAN, bank
 * account or emergency contacts. Previously every reader received the whole row —
 * and the list endpoint was public, so those fields left the system entirely.
 *
 * HR own the workforce record, so they see everything. Finance see banking
 * because they disburse payments. Everyone else gets the operational subset.
 */

/** Personal and financial data that only HR (and administrators) may read. */
const HR_ONLY_FIELDS = [
  'panNumber', 'aadhaarNumber', 'dateOfBirth',
  'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation',
  'governmentDocuments',
];

/** Banking details — HR own them; Finance need them to pay. */
const BANKING_FIELDS = ['bankAccountNumber', 'ifscCode', 'bankName', 'accountHolderName'];

/** Never returned to anyone through the API, whatever the role. */
const NEVER_EXPOSED = ['passwordHash'];

const FULL_ACCESS: string[] = [SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER];

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
  const canSeeBanking = hasFull || roles.includes(SystemRole.FINANCE_MANAGER) || isSelf;
  const canSeePersonal = hasFull || isSelf;

  if (!canSeeBanking) for (const f of BANKING_FIELDS) delete out[f];
  if (!canSeePersonal) for (const f of HR_ONLY_FIELDS) delete out[f];

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
