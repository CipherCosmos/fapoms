/**
 * FAPOMS — who a background job runs as.
 *
 * A write that used to happen inside a request reads the ambient request context twice over:
 * `tenantWhere`/`tenantSql` scope every record lookup to the caller's organisation (and widen it for
 * a cross-tenant role anywhere in the role list), and audit rows name the actor, their role and
 * display name from it. A Bull worker has no request, and with no context those lookups run
 * unscoped and the audit trail loses who did it.
 *
 * So a job that performs a person's write carries this snapshot of the principal, taken in the
 * request, and the worker runs the work inside it with `runAsJobActor`. The roster bulk actions, the
 * planning write jobs and the document dispatch batch each grew their own copy of this — three
 * interfaces, three `runWithRequestContext` wrappers, three request-to-actor builders that did not
 * even read the same fields. This is the one home; see `one-implementation-rule`.
 */

import { getRequestContext, runWithRequestContext } from '../../core/context/request-context';

export interface JobActor {
  userId: string;
  /** EVERY role the principal holds — tenant scoping reads the whole list, not the first entry. */
  roleNames: string[];
  organizationId?: string;
  displayName?: string;
}

/**
 * The principal as the request sees it, for a job to carry.
 *
 * Prefers the ambient request context — it is exactly what tenant scoping and the audit service
 * read in the request — and falls back to `req.user` for anything the context has not filled.
 */
export function jobActorFrom(req: { user?: any }): JobActor {
  const ctx = getRequestContext();
  const user = req.user ?? {};
  const rolesFromUser: string[] = (user.roles ?? [])
    .map((r: any) => (typeof r === 'string' ? r : r?.name))
    .filter(Boolean);
  return {
    userId: user.id,
    roleNames: ctx?.roleNames?.length ? ctx.roleNames : rolesFromUser,
    organizationId: ctx?.organizationId ?? user.organizationId ?? undefined,
    displayName: ctx?.displayName ?? user.displayName ?? user.username ?? undefined,
  };
}

/** Runs `work` inside the scope of the person who started the job. */
export function runAsJobActor<T>(actor: JobActor, work: () => Promise<T>): Promise<T> {
  return runWithRequestContext(
    {
      userId: actor.userId,
      role: actor.roleNames[0],
      roleNames: actor.roleNames,
      organizationId: actor.organizationId,
      displayName: actor.displayName,
    },
    work,
  );
}
