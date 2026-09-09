import { AsyncLocalStorage } from 'async_hooks';

/**
 * Who is acting, from where, on which request — carried ambiently for the life of one request.
 *
 * Every audit row must record the actor, their role, the client IP, the user-agent, the session and
 * the request id (RBI IT-Governance MD 2023 wants trails "detailed enough for forensic evidence and
 * non-repudiation"; DPDP access logs want who-viewed-what). Threading those six values through the
 * ~36 services that write audit events, and every future one, is the kind of boilerplate that is
 * forgotten exactly on the call sites that matter. So they are captured ONCE per request into this
 * store and read back wherever an event is recorded, rather than passed by hand.
 *
 * Built on Node's own `AsyncLocalStorage` (no dependency): the store set at the edge of a request
 * stays attached across every `await` in that request's async chain, and is invisible to every
 * other concurrent request. The stored object is a single mutable reference on purpose — the
 * middleware seeds transport facts (ip, user-agent, request id) before auth has run, and the
 * interceptor later fills in the authenticated actor (`userId`, `role`, `sessionId`) by mutating
 * the same object, so a service reading it late in the request sees the complete picture.
 */
export interface RequestContext {
  /** Authenticated user id (uuid), or undefined for a pre-auth / anonymous request. */
  userId?: string;
  /** The actor's primary role name at the time of the request (e.g. ADMIN, OPERATIONS). */
  role?: string;
  /**
   * EVERY role the actor holds, not just the first one `role` reports.
   *
   * `role` takes whichever entry happens to come back first from `roles` and is fine for an
   * audit row, which only wants to say "an OPERATIONS user did this". Tenant scoping cannot use
   * it: the decision it drives is "may this principal read across organisations", and answering
   * that from one arbitrarily-chosen entry means an ADMIN whose roles array happens to start with
   * something else is refused, while the reverse — reading a cross-tenant role out of a principal
   * that does not hold it — is worse still. See `AmbientTenantContext.isCrossTenant`.
   */
  roleNames?: string[];
  /**
   * The organisation the actor belongs to, from `req.user.organizationId`.
   *
   * Carried here rather than resolved from the database at each read because this is the value
   * every tenant-scoped query filters on, and it must be the *authenticated* one — derived from
   * the principal the JWT guard resolved, never from a query string, header or body the caller
   * controls. Finding F-03 was exactly what happens without it: an OPERATIONS user in one
   * organisation read, suspended, revealed the bank details of and deleted an assayer belonging
   * to another, because no query anywhere had ever mentioned this column.
   */
  organizationId?: string;
  /** Display name, so an audit row can name the actor without a second lookup. */
  displayName?: string;
  /** Real client IP (Express `req.ip`, resolved through `trust proxy` — see main.ts). */
  ipAddress?: string;
  /** Raw User-Agent header, stored unparsed; device parsing happens at read time. */
  userAgent?: string;
  /** Durable session id (the access token's `sid` claim), linking the request to a device session. */
  sessionId?: string;
  /** Correlation/request id shared with logs and the exception filter (x-correlation-id). */
  requestId?: string;
  /** HTTP method and route template, for access-log context. */
  method?: string;
  route?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` with `context` as the ambient request context. Everything awaited inside `fn` — the
 * whole downstream request — reads that same context via {@link getRequestContext}.
 */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The current request's context, or `undefined` outside any request (a worker, a cron job, boot). */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Merge `patch` into the current request's context in place.
 *
 * Used by the auth interceptor to add `userId`/`role`/`sessionId` once the JWT principal is
 * resolved — the same store object the middleware seeded, so a mutation here is visible to code
 * that captured the context reference earlier. A no-op outside a request, by design: background
 * work has no request context and must not synthesise one.
 */
export function updateRequestContext(patch: Partial<RequestContext>): void {
  const current = storage.getStore();
  if (current) Object.assign(current, patch);
}
