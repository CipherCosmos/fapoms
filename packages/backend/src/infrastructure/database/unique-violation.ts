/**
 * Recognise a Postgres unique-constraint violation, optionally for one named index.
 *
 * TypeORM wraps driver errors in `QueryFailedError` and copies the driver's fields onto it, so
 * the SQLSTATE lives at `err.code` (or `err.driverError.code`) and the index/constraint name at
 * `err.constraint`. Matching on the name matters when a table carries several unique indexes:
 * "a duplicate of THIS invariant" is the only case a caller can safely treat as "already exists".
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string; driverError?: { code?: string; constraint?: string } };
  const code = e?.code ?? e?.driverError?.code;
  if (code !== '23505') return false;
  if (!constraint) return true;
  const name = e?.constraint ?? e?.driverError?.constraint;
  return name === constraint;
}
