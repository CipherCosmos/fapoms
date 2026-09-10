import { SystemRole } from '@fapoms/shared';

/**
 * Which self-service endpoint a signed-in principal's own account actions go to.
 *
 * FAPOMS has two kinds of principal and they live in different tables. Staff are `users` rows.
 * Assayers are not — they carry their own `password_hash` on the `assayers` table and authenticate
 * as a different kind of caller entirely. The API has always had both doors
 * (`POST /users/me/change-password` and `POST /assayers/me/change-password`); the web app only
 * ever knocked on the staff one.
 *
 * What that cost: an assayer issued app access by the desk could sign in on the web, was correctly
 * stopped at the forced password change, and could never pass it. Submitting a valid password
 * answered `404 User <their assayer id> not found` — an internal identifier, on the only screen
 * they could reach, with no way forward. The same call sits behind Settings → Security, where the
 * failure is dressed as "Please check your current password", which is worse: it is wrong, and it
 * blames the person.
 *
 * The read beside these writes is polymorphic — `GET /users/me` answers 200 for an assayer,
 * because the auth layer synthesises a profile from the assayer row. A read that works next to a
 * write that 404s is exactly how this stayed invisible.
 *
 * One helper rather than a check at each call site, so a third self-service screen inherits the
 * right answer instead of repeating the assumption.
 */
export const isAssayerPrincipal = (roles: { name: string }[] | string[] | undefined | null): boolean => {
  if (!roles?.length) return false;
  return (roles as Array<{ name: string } | string>).some(
    (r) => (typeof r === 'string' ? r : r?.name) === SystemRole.ASSAYER,
  );
};

/** `POST` here to change one's own password. */
export const changeOwnPasswordPath = (roles: { name: string }[] | string[] | undefined | null): string =>
  (isAssayerPrincipal(roles) ? '/assayers/me/change-password' : '/users/me/change-password');
