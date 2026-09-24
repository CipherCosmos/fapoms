import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AssayerEntity } from '../assayer/assayer.entity';
import { AuthService, isOnboardingStage, maySignIn } from '../auth/auth.service';
import { realtimeHealth } from '../../infrastructure/realtime/realtime-health';
import { AssayerLifecycleStatus } from '@fapoms/shared';

/**
 * Domain events that mean "this user's authority may have changed" — the gateway drops their live
 * sockets so the next connection re-authorizes. Published by UserService on role/scope/status
 * change and password reset; a suspended/terminated/rescoped account must not keep a warm socket.
 */
const AUTH_CHANGE_EVENTS = new Set<string>([
  'user:role-changed',
  'user:updated',
  'user:password-changed',
]);

/**
 * The same, for a field account, keyed on the assayer's id (`aggregateId`). A deleted record, and
 * every lifecycle transition the assayer state machine raises (`AssayerSuspendedEvent`,
 * `AssayerTerminatedEvent`, `AssayerActivatedEvent` …, published under their class names with
 * `newState`), can change whether the phone may hold a socket at all. An ordinary profile edit
 * (`assayer:updated`) carries no lifecycle change and is deliberately NOT one: dropping the phone's
 * socket on every address correction would be churn with nothing to re-authorize.
 */
export function assayerAuthChangeId(eventName: string, payload: any): string | null {
  const id = typeof payload?.aggregateId === 'string' ? payload.aggregateId : null;
  if (!id) return null;
  const name = payload?.eventType || eventName;
  if (name === 'assayer:deleted') return id;
  if (/^Assayer[A-Za-z]*Event$/.test(name) && payload?.newState !== undefined) return id;
  return null;
}

/** Room of the national (region-unassigned) internal staff — see `emitOperational`. */
export const NATIONAL_ROOM = 'staff:national';

/** Payload keys `RegionGuardService.resolveEventRegion` can place in a region. */
const PAYLOAD_KEYS_THAT_PLACE_AN_EVENT = ['branchId', 'projectBranchId', 'assignmentId', 'scheduleId', 'assayerId'];

/**
 * Whether a payload names something that lives in a region — the same identifiers
 * `RegionGuardService.resolveEventRegion` resolves. An event like that whose region could NOT be
 * resolved (lookup error, a row with no region) is regional traffic of unknown region, and goes to
 * the national desk only — never to every staff socket.
 */
export function namesARegionalRecord(payload: any): boolean {
  if (!payload || typeof payload !== 'object') return false;
  if (typeof (payload.region ?? payload.metadata?.region) === 'string') return true;
  const meta = payload.metadata ?? {};
  return PAYLOAD_KEYS_THAT_PLACE_AN_EVENT.some(
    (k) => typeof (payload[k] ?? meta[k]) === 'string' && (payload[k] ?? meta[k]),
  );
}
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { RegionGuardService, RoomVerdict, isInternalStaff } from '../../infrastructure/scope/region-guard.service';
import { verifyAccessToken } from '../../infrastructure/security/jwt-verify';
import { REGION_ORDER } from '@fapoms/shared';
import { FEEDBACK_TEAM_ROLE_NAMES } from '../feedback/feedback-roles';

/** Every region room a national (unassigned) staff socket joins. */
const ALL_REGIONS: string[] = REGION_ORDER;

interface AuthenticatedSocket extends Socket {
  user?: {
    id: string;
    userId?: string;
    roles?: { name: string }[];
    organizationId?: string;
  };
  /** Room-join decisions already made for this socket — see `joinIfEntitled`. */
  roomVerdicts?: Map<string, boolean>;
  /** Fires at the access token's expiry and drops the socket — see `handleConnection`. */
  expiryTimer?: ReturnType<typeof setTimeout>;
}

/** Longest a single timer may be set for (setTimeout overflows past 2^31-1 ms). */
const MAX_TIMER_MS = 2_147_483_647;

@Injectable()
@WebSocketGateway({
  cors: {
    origin: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:8081,http://localhost:19006').split(',').map(s => s.trim()),
    credentials: true,
  },
  namespace: '/events',
  // Field assayers work on 2G/3G inside bank vaults, so a socket routinely drops for a few seconds.
  // Connection-state recovery lets a client that reconnects within the window get its rooms back AND
  // replay the events it missed while away, instead of silently losing live updates until a manual
  // refresh. Auth still re-runs in handleConnection on every (re)connect.
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
    skipMiddlewares: true,
  },
  // The v4 defaults (pingTimeout 20s) are too aggressive for high-latency field networks and cause
  // spurious disconnect/reconnect churn. Give a slow link more room before the socket is declared dead.
  pingInterval: 25000,
  pingTimeout: 60000,
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private userSockets = new Map<string, Set<string>>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly eventPublisher: DomainEventPublisher,
    private readonly regionGuard: RegionGuardService,
    @InjectRepository(AssayerEntity)
    private readonly assayers: Repository<AssayerEntity>,
    /**
     * Resolves `AuthService` lazily, at connect time, so the socket runs the SAME session and
     * principal gate as an HTTP request without this @Global module importing AuthModule's graph
     * (see realtime.module.ts). Optional only so unit tests can construct the gateway by hand.
     */
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {
    this.eventPublisher.onPublish((eventName, payload, meta) => {
      // An authorization change must drop the live socket, not just the HTTP principal cache.
      // Rooms (user/role/org/staff/region) are joined ONCE at connect from the DB and never
      // re-evaluated, so a role downgrade, region removal, suspension or termination would
      // otherwise leave an already-connected socket receiving its old rooms' events for the rest
      // of the connection's life — access the user no longer possesses. Disconnecting forces a
      // reconnect, which re-runs handleConnection's gates and re-rooms against current authority.
      //
      // This half runs in EVERY process, remote deliveries included: `userSockets` is per process,
      // so only the process holding the socket can drop it.
      const name = payload?.eventType || eventName;
      if (AUTH_CHANGE_EVENTS.has(eventName) || AUTH_CHANGE_EVENTS.has(name)) {
        this.disconnectUserForReauth(payload?.userId);
        // A password change is nobody else's business; the profile/role events still refresh
        // the admin screens below.
        if (name === 'user:password-changed') return;
      }
      const assayerId = assayerAuthChangeId(eventName, payload);
      if (assayerId) this.disconnectUserForReauth(assayerId);

      // The broadcast runs ONCE, on the process that published the event. Its room emits already
      // reach every replica's sockets through the Socket.IO Redis adapter; re-emitting an event
      // that arrived over the domain-event bridge delivered it once per process. Only a process
      // whose server is NOT on the Redis adapter (Redis down at boot) still emits it locally,
      // because nothing else will reach its sockets.
      if (meta?.remote && realtimeHealth.crossProcessFanOut) return;
      this.broadcastEvent(eventName, payload);
    });
  }

  /**
   * Drop every live socket for a user whose authorization just changed, so their next request
   * re-authenticates. Bounded and cheap: one map lookup, disconnect the handful of sockets.
   */
  private disconnectUserForReauth(userId: string | undefined): void {
    if (!userId || !this.server) return;
    const socketIds = this.userSockets.get(userId);
    if (!socketIds || socketIds.size === 0) return;
    for (const sid of [...socketIds]) {
      const s = this.server.sockets.sockets.get(sid) as AuthenticatedSocket | undefined;
      if (s) {
        s.emit('error', { message: 'Your access changed; please reconnect.', code: 'REAUTH_REQUIRED' });
        s.disconnect();
      }
    }
    // handleDisconnect prunes userSockets as each socket goes; clear defensively in case a socket
    // object was already gone from the server registry.
    this.userSockets.delete(userId);
  }

  /**
   * The HTTP request gate, applied to a socket: the session must still be usable (not revoked, not
   * idle- or absolute-expired — `SessionService.touchIfUsable` inside `validateJwtPayload`) and the
   * account must still resolve to an active principal. Returns that principal — whose roles and
   * organisation are read from the database, not the token — or null to refuse.
   *
   * `undefined` means "no auth service in this context" (a unit test building the gateway by hand);
   * the caller then falls back to the token claims. In the running app `moduleRef` always exists,
   * and a failure to resolve the service there refuses the socket rather than skip the gate.
   */
  private async validatedPrincipal(payload: any, userId: string): Promise<any | null | undefined> {
    if (!this.moduleRef) return undefined;
    let auth: AuthService;
    try {
      auth = this.moduleRef.get(AuthService, { strict: false });
    } catch {
      console.warn('[EventsGateway] AuthService unavailable; refusing socket (fail-closed)');
      return null;
    }
    if (!auth) return null;
    return (await auth.validateJwtPayload({ ...payload, sub: userId })) ?? null;
  }

  afterInit() {
    console.log('[EventsGateway] Initialized');
  }

  async handleConnection(client: AuthenticatedSocket) {
    try {
      const token = client.handshake.auth?.token || client.handshake.query?.token;
      if (!token) {
        client.emit('error', { message: 'Authentication required' });
        client.disconnect();
        return;
      }

      // No valid, signed JWT — never trust an unsigned decode or the raw token string.
      const payload = await verifyAccessToken<any>(this.jwtService, token as string);
      if (!payload) {
        client.emit('error', { message: 'Invalid or expired token' });
        client.disconnect();
        return;
      }

      const userId = payload.id || payload.sub || payload.userId;
      if (!userId) {
        client.emit('error', { message: 'Invalid token payload' });
        client.disconnect();
        return;
      }

      /**
       * A restricted session gets no socket either.
       *
       * `JwtAuthGuard` refuses an onboarding principal on every HTTP route outside registration,
       * and refuses anybody still holding an issued password on every route but the one that
       * changes it. Neither check runs here: this handler verifies the token's signature and joins
       * rooms straight from its payload, so both gates stopped at the HTTP boundary and the socket
       * was a way round them.
       *
       * There is no live exposure today — 1,155 of 1,163 assayers have no `organization_id`, so an
       * onboarding session's `org:` room is empty, and the only `role:` broadcast goes to
       * super-admins. That is a property of this deployment's data, not of the design: the day such
       * a person is given an organisation they would receive that org's assignment changes,
       * counter-offers and fee updates over the socket, with the HTTP guard none the wiser.
       *
       * Read from the row rather than the token because the token is minted for fifteen minutes
       * and a person activated in that window would otherwise stay locked out of live updates for
       * the remainder of it. One indexed read per CONNECT, not per message.
       */
      const assayer = await this.assayers.findOne({
        where: { id: userId },
        select: { id: true, lifecycleStatus: true, mustChangePassword: true, isActive: true },
      });
      /**
       * The same per-connection status gate `loadPrincipal` applies on the HTTP path.
       *
       * The socket handshake verifies the JWT directly (not through `loadPrincipal`), so the
       * assayer status gate added there did NOT cover this path: a terminated, suspended,
       * soft-deleted or otherwise non-signable assayer holding a still-valid 15-minute token could
       * open a socket and join their rooms. Refuse them here too — checked before onboarding so a
       * closed account is told it is closed, not asked to finish registering.
       */
      if (assayer && (!maySignIn(assayer.lifecycleStatus as AssayerLifecycleStatus) || assayer.isActive === false)) {
        client.emit('error', { message: 'This account is closed.', code: 'ACCOUNT_CLOSED' });
        client.disconnect();
        return;
      }
      if (assayer && (isOnboardingStage(assayer.lifecycleStatus) || assayer.mustChangePassword)) {
        // Same discriminators the HTTP 403s carry, so a client can tell this apart from a dead
        // session and route to the screen that clears it rather than retrying for ever.
        client.emit('error', {
          message: assayer.mustChangePassword
            ? 'Change your password before continuing.'
            : 'Finish your registration before continuing.',
          code: assayer.mustChangePassword ? 'PASSWORD_CHANGE_REQUIRED' : 'REGISTRATION_IN_PROGRESS',
        });
        client.disconnect();
        return;
      }

      /*
        Same session and account gate as an HTTP request. The token alone proved only that it was
        signed within the last fifteen minutes; a session revoked by "sign out everywhere", an
        account suspended since, or roles changed since, all passed. Roles and organisation below
        come from this principal, not from the token's claims.
      */
      const principal = await this.validatedPrincipal(payload, userId);
      if (principal === null) {
        client.emit('error', { message: 'Your session has ended; please sign in again.', code: 'SESSION_INVALID' });
        client.disconnect();
        return;
      }
      const principalRoles: any[] = principal ? (principal.roles ?? []) : (payload.roles ?? []);
      const organizationId = principal ? (principal.organizationId ?? undefined) : payload.organizationId;

      client.user = {
        id: userId,
        userId,
        roles: principalRoles,
        organizationId,
      };

      /*
        A socket lives no longer than the token that opened it. Without this, one handshake held
        rooms for as long as the connection stayed up — days, on a desk left open — after the
        token had expired and long after anything else it authorized had stopped working. At
        expiry the socket is dropped; the web and phone clients reconnect with their current token
        (`manualReconnect.ts`), which runs this gate again.
      */
      if (typeof payload.exp === 'number') {
        const ms = Math.max(0, Math.min(payload.exp * 1000 - Date.now(), MAX_TIMER_MS));
        client.expiryTimer = setTimeout(() => {
          client.emit('error', { message: 'Your session token expired; reconnecting.', code: 'TOKEN_EXPIRED' });
          client.disconnect();
        }, ms);
        (client.expiryTimer as any)?.unref?.();
      }

      // With the Redis adapter, join() is async (room membership propagates across nodes). Await it
      // so a broadcast issued right after connect can't race ahead of the socket joining its rooms.
      await client.join(`user:${userId}`);

      for (const role of principalRoles) {
        const roleName = typeof role === 'string' ? role : role?.name;
        if (roleName) await client.join(`role:${roleName}`);
      }

      // No operational broadcast is sent to `org:` any more (see `emitOperational`): every
      // principal of the organisation, field assayers included, sits in it. Joined still, so a
      // future organisation-wide notice for everyone has a room.
      if (organizationId) {
        await client.join(`org:${organizationId}`);
      }

      /**
       * Internal staff share one room for organisation-wide operational traffic.
       *
       * Field assayers are deliberately excluded. Every broadcast in this gateway used to end
       * with an unconditional `server.emit(...)`, which goes to *every* connected socket and
       * bypasses the `user:`/`org:`/`assignment:` rooms joined just above — so an assayer's
       * phone received branch, client, zone, billing and other assayers' assignment events for
       * work they have no connection to. Verified against the running stack: a socket
       * authenticated as one assayer received project-branch events for an unrelated branch.
       *
       * `org:` alone is not enough as a replacement, because most tokens here carry no
       * organizationId — without this room those events would reach nobody and the web app's
       * live updates would silently stop.
       */
      const roleNames: string[] = principalRoles
        .map((r: any) => (typeof r === 'string' ? r : r?.name))
        .filter(Boolean);

      // ASSAYER and CLIENT_USER are external principals. CLIENT_USER is excluded for the same
      // reason `STAFF_ROLES` excludes it: `users` has no client_id, so a client user cannot be
      // scoped to their own client, and unscoped access to every client's operational traffic
      // is worse than no live updates. A token carrying no roles at all is treated as external
      // too — the room is opt-in, never a default. Same rule `region-guard.service.ts` applies
      // for the HTTP side; imported rather than re-declared so the two cannot drift apart.
      if (isInternalStaff(roleNames)) {
        await client.join('staff');
        // The organisation's own staff — what operational traffic naming an organisation goes
        // to, instead of `org:` (which also holds that organisation's assayers).
        if (organizationId) await client.join(`staff:org:${organizationId}`);

        /**
         * Territorial rooms, so a region-assigned operator is not in the national firehose.
         *
         * The `staff` room above still exists and still carries events whose region cannot be
         * determined — those are national by nature (client, zone, billing) or simply carry no
         * identifier to resolve. Anything that *can* be placed in a region is delivered here
         * instead, so a West operator's socket never receives the South's branch names, codes
         * and assignment traffic.
         *
         * Regions come from the database rather than the token: tokens issued before region
         * assignment existed carry no claim, and reading "absent" as "unrestricted" would put
         * the very accounts this protects straight back into the firehose.
         */
        // An unassigned account (regions == null, no error) is national and joins every region
        // room; an assigned one joins only its own. A LOOKUP FAILURE must fail CLOSED — join no
        // region rooms — not fall back to the national firehose: the old `.catch(() => null)` mapped
        // a transient DB error to "unrestricted", so a region-restricted operator whose lookup
        // errored at connect silently received every region's traffic. On failure the socket simply
        // gets no region events until it reconnects, which is the safe direction.
        let regions: string[] | null;
        let regionLookupFailed = false;
        try {
          regions = await this.regionGuard.getUserRegions(userId);
        } catch {
          regionLookupFailed = true;
          regions = null;
          console.warn(`[EventsGateway] region lookup failed for ${userId}; joining no region rooms (fail-closed)`);
        }
        const rooms = regionLookupFailed ? [] : (regions ?? ALL_REGIONS);
        for (const r of rooms) await client.join(`region:${r}`);
        // National desk only: where regional traffic whose region could not be resolved goes
        // (see `emitOperational`). A restricted account, or one whose lookup failed, never joins.
        if (!regionLookupFailed && regions === null) await client.join(NATIONAL_ROOM);
      }

      if (!this.userSockets.has(userId)) {
        this.userSockets.set(userId, new Set());
      }
      this.userSockets.get(userId)!.add(client.id);

      client.emit('connected', { userId, socketId: client.id });
    } catch (err: any) {
      console.error('[EventsGateway] Connection failed:', err?.message);
      client.emit('error', { message: 'Invalid or expired token' });
      client.disconnect();
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    if (client.expiryTimer) {
      clearTimeout(client.expiryTimer);
      client.expiryTimer = undefined;
    }
    if (client.user?.id) {
      const sockets = this.userSockets.get(client.user.id);
      if (sockets) {
        sockets.delete(client.id);
        if (sockets.size === 0) {
          this.userSockets.delete(client.user.id);
        }
      }
    }
  }

  private async joinIfEntitled(
    client: AuthenticatedSocket,
    room: string,
    entityId: unknown,
    check: () => Promise<RoomVerdict>,
  ) {
    if (!client.user?.id) return;

    // Cap how fast one socket may attempt subscriptions. Each attempt can run a DB verdict, and a
    // not-found verdict is deliberately not cached, so a client spraying random UUIDs would issue an
    // unbounded stream of queries. This bounds it per socket without affecting any real client, which
    // subscribes a handful of times per screen.
    if (!this.allowSubscribeAttempt(client)) {
      client.emit('error', { message: 'Too many subscription attempts; please slow down.' });
      return;
    }

    // Refuse malformed ids before they reach a query: a non-UUID would make Postgres throw,
    // and arbitrary strings must never become room names.
    if (typeof entityId !== 'string' || !EventsGateway.UUID_RE.test(entityId)) {
      client.emit('error', { message: `Invalid subscription id for ${room}` });
      return;
    }

    const cache = (client.roomVerdicts ??= new Map());
    let allowed = cache.get(room);
    if (allowed === undefined) {
      try {
        const verdict = await check();
        allowed = verdict.allowed;
        // Unknown ids are refused but not cached (the entity may exist moments later);
        // verdicts about a real entity are pinned for the socket's lifetime.
        if (verdict.found) cache.set(room, allowed);
      } catch {
        // Lookup failure — DB hiccup or a ForbiddenException about the account itself.
        // Refuse without caching so a transient error cannot pin a false refusal.
        allowed = false;
      }
    }

    if (allowed) {
      await client.join(room);
    } else {
      client.emit('error', { message: `Not authorized to subscribe to ${room}` });
    }
  }

  private static readonly UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Per-socket subscribe budget. Keyed by the socket object so it is discarded with the connection;
  // no per-connection field or cleanup needed.
  private static readonly SUBSCRIBE_MAX = 60;
  private static readonly SUBSCRIBE_WINDOW_MS = 10_000;
  private readonly subscribeBuckets = new WeakMap<object, { count: number; resetAt: number }>();

  private allowSubscribeAttempt(client: AuthenticatedSocket): boolean {
    const now = Date.now();
    let b = this.subscribeBuckets.get(client);
    if (!b || now > b.resetAt) {
      b = { count: 0, resetAt: now + EventsGateway.SUBSCRIBE_WINDOW_MS };
      this.subscribeBuckets.set(client, b);
    }
    b.count += 1;
    return b.count <= EventsGateway.SUBSCRIBE_MAX;
  }

  /**
   * Joining an entity room is an entitlement decision, not just an authentication one.
   *
   * This used to be `if (client.user?.id) join(...)` — so any authenticated principal, including
   * an external assayer, could subscribe to an arbitrary assignment UUID and receive that
   * assignment's status changes, comments, communications and fee negotiation. The rooms below
   * carry all of it.
   */
  @SubscribeMessage('subscribe:assignment')
  async handleSubscribeAssignment(client: AuthenticatedSocket, assignmentId: string) {
    await this.joinIfEntitled(client, `assignment:${assignmentId}`, assignmentId, () =>
      this.regionGuard.assignmentVerdict(client.user!, assignmentId),
    );
  }

  @SubscribeMessage('unsubscribe:assignment')
  async handleUnsubscribeAssignment(client: AuthenticatedSocket, assignmentId: string) {
    if (client.user?.id) {
      await client.leave(`assignment:${assignmentId}`);
    }
  }

  @SubscribeMessage('subscribe:query')
  async handleSubscribeQuery(client: AuthenticatedSocket, queryId: string) {
    await this.joinIfEntitled(client, `query:${queryId}`, queryId, () =>
      this.regionGuard.queryVerdict(client.user!, queryId),
    );
  }

  @SubscribeMessage('unsubscribe:query')
  async handleUnsubscribeQuery(client: AuthenticatedSocket, queryId: string) {
    if (client.user?.id) {
      await client.leave(`query:${queryId}`);
    }
  }

  @SubscribeMessage('subscribe:feedback')
  async handleSubscribeFeedback(client: AuthenticatedSocket, threadId: string) {
    // Was an unconditional join — any authenticated socket (an assayer included) could subscribe to
    // any thread id and receive its messages. Gated now like the assignment/query rooms.
    await this.joinIfEntitled(client, `feedback:${threadId}`, threadId, () =>
      this.regionGuard.feedbackVerdict(client.user!, threadId),
    );
  }

  @SubscribeMessage('unsubscribe:feedback')
  async handleUnsubscribeFeedback(client: AuthenticatedSocket, threadId: string) {
    if (client.user?.id) {
      await client.leave(`feedback:${threadId}`);
    }
  }

  /**
   * Organisation-wide operational traffic, scoped to people entitled to see it.
   *
   * Replaces the bare `this.server.emit(...)` that every branch of `broadcastEvent` used to end
   * with, which delivered to every connected socket — field assayers' phones included.
   *
   * ## Where it goes, in order
   *
   *  1. The event names a record that resolves to a region → `region:<R>` only.
   *  2. It names a regional record whose region could NOT be resolved (the lookup errored, or the
   *     row carries no region) → the national desk room only. FAIL CLOSED: this used to fall back
   *     to the organisation or the whole `staff` room, so a DB hiccup during resolution handed a
   *     region-restricted operator another region's branch and assignment traffic.
   *  3. It names nothing regional (clients, zones, holidays, users) → the organisation's STAFF
   *     room when the payload names an organisation, else `staff`.
   *
   * Never `org:`. That room holds every principal of the organisation, assayers included, and was
   * how `assignment:fee-updated` and other operational events reached phones that are
   * deliberately money-blind. Assayers receive what is theirs through `user:` and `assignment:`.
   */
  private emitOperational(eventName: string, payload: any) {
    const regional = namesARegionalRecord(payload);
    void this.regionGuard
      .resolveEventRegion(payload)
      .catch(() => null)
      .then((region) => {
        if (!this.server) return;
        if (region) {
          this.server.to(`region:${region}`).emit(eventName, payload);
          return;
        }
        if (regional) {
          this.server.to(NATIONAL_ROOM).emit(eventName, payload);
          return;
        }
        const orgId = payload?.organizationId || payload?.metadata?.organizationId;
        this.server.to(orgId ? `staff:org:${orgId}` : 'staff').emit(eventName, payload);
      });
  }

  broadcastEvent(eventName: string, payload: any) {
    if (!this.server) return;

    const eventType = payload?.eventType || eventName;

    switch (eventType) {
      case 'assignment:created':
      case 'AssignmentCreated': {
        if (payload.assayerId) {
          this.server.to(`user:${payload.assayerId}`).emit('assignment:created', payload);
        }
        // Without this the desk was only reached through `org:`, and most tokens issued here
        // carry no organizationId — so a newly offered assignment reached the assayer's phone
        // live and the operators' own queues not at all.
        this.emitOperational('assignment:created', payload);
        break;
      }

      case 'assignment:status-changed':
      case 'OfferAccepted':
      case 'OfferRejected':
      case 'AssignmentCancelled':
      case 'AuditScheduled':
      case 'AuditCompleted':
      case 'AssignmentClosed':
      case 'AssignmentCandidateSelected':
      case 'AssignmentContactInitiated':
      case 'AssignmentNegotiationStarted':
      case 'ASSIGNMENT_STATUS_CHANGE': {
        const asnId = payload.assignmentId || payload.aggregateId;
        if (asnId) {
          this.server.to(`assignment:${asnId}`).emit('assignment:status-changed', payload);
        }
        if (payload.assayerId) {
          this.server.to(`user:${payload.assayerId}`).emit('assignment:status-changed', payload);
        }
        this.emitOperational('assignment:status-changed', payload);
        break;
      }

      // `assignment:counter-offered` had a case here until in-app fee negotiation was removed —
      // nothing publishes it any more, so there is nothing left to route.

      case 'assignment:fee-updated': {
        /**
         * Deliberately NOT sent to `user:${assayerId}` any more. The payload carries the fee,
         * and the assayer's app is money-blind until the invoicing step — a desk fee edit is an
         * ops-internal fact. The publication itself must survive: the desk's queues refresh on
         * it, and the billing engine subscribes to it for repricing.
         */
        // Same gap as `assignment:created`: with delivery limited to `org:`, an agreed fee — the
        // number the desk queues track — never reached them live.
        this.emitOperational('assignment:fee-updated', payload);
        break;
      }

      case 'schedule:created':
      case 'schedule:updated': {
        if (payload.assignmentId) {
          this.server.to(`assignment:${payload.assignmentId}`).emit(eventType, payload);
        }
        if (payload.assayerId) {
          this.server.to(`user:${payload.assayerId}`).emit(eventType, payload);
        }
        this.emitOperational(eventType, payload);
        break;
      }

      case 'notification:new': {
        // An assayer's socket joins `user:${assayerId}` on connect (handleConnection
        // keys the room off the JWT `sub`, which is the assayer's own id for an
        // assayer login) — but this only ever read `payload.userId`, so a
        // notification addressed to an assayer had a live room waiting for it and
        // nothing was ever sent there. Real-time delivery to assayers never worked.
        if (payload.userId) {
          this.server.to(`user:${payload.userId}`).emit('notification:new', payload);
        }
        if (payload.assayerId) {
          this.server.to(`user:${payload.assayerId}`).emit('notification:new', payload);
        }
        break;
      }

      case 'comment:added': {
        const cAsnId = payload.assignmentId;
        if (cAsnId) {
          this.server.to(`assignment:${cAsnId}`).emit('comment:added', payload);
        }
        break;
      }

      // Every message posted to a clarification thread, and the thread's own lifecycle.
      // Same audience for all three: the open thread's room, the assayer's phone, and the
      // operational rooms.
      case 'query:raised':
      case 'query:responded':
      case 'query:reopened':
      case 'query:resolved':
      case 'query:message': {
        if (payload.queryId) {
          this.server.to(`query:${payload.queryId}`).emit(eventType, payload);
        }
        if (payload.assayerId) {
          this.server.to(`user:${payload.assayerId}`).emit(eventType, payload);
        }
        if (payload.validatorId) {
          this.server.to(`user:${payload.validatorId}`).emit(eventType, payload);
        }
        this.emitOperational(eventType, payload);
        break;
      }

      /**
       * Feedback & collaboration channel. The open thread's room gets every event;
       * the reporter's own room mirrors it so their "my feedback" list stays live —
       * except internal team notes, which the reporter must never receive. The
       * feedback team (FEEDBACK_TEAM_ROLES — the developers, plus PRODUCT_SUPPORT as
       * delegate since 2026-09-05) hear it in their role rooms so their queue and
       * dashboard refresh without a manual reload.
       */
      case 'feedback:new':
      case 'feedback:updated':
      case 'feedback:message': {
        if (payload.threadId) {
          this.server.to(`feedback:${payload.threadId}`).emit(eventType, payload);
        }
        const reporterRoom = payload.reporterUserId || payload.reporterAssayerId;
        if (reporterRoom && !payload.isInternal) {
          this.server.to(`user:${reporterRoom}`).emit(eventType, payload);
        }
        for (const role of FEEDBACK_TEAM_ROLE_NAMES) {
          this.server.to(`role:${role}`).emit(eventType, payload);
        }
        break;
      }

      case 'document:uploaded':
      case 'document:status-changed':
      case 'document:received':
      case 'document:dispatched': {
        if (payload.projectBranchId) {
          this.server.to(`branch:${payload.projectBranchId}`).emit(eventType, payload);
        }
        // The assayer the document concerns, when the publisher names one — their phone lists it.
        if (payload.assayerId) {
          this.server.to(`user:${payload.assayerId}`).emit(eventType, payload);
        }
        this.emitOperational(eventType, payload);
        break;
      }

      /**
       * A reassignment moves a job off one phone and onto another. Both phones must hear it (the
       * outgoing assayer's list otherwise kept the job until a refresh), plus the job's own room
       * and the desk. `oldAssayerId`/`previousAssayerId` is who lost it, `newAssayerId`/`assayerId`
       * who gained it.
       */
      case 'assignment:reassigned': {
        const asnId = payload.assignmentId || payload.aggregateId;
        if (asnId) this.server.to(`assignment:${asnId}`).emit(eventType, payload);
        const phones = new Set<string>(
          [payload.oldAssayerId, payload.previousAssayerId, payload.newAssayerId, payload.assayerId]
            .filter((id): id is string => typeof id === 'string' && !!id),
        );
        for (const id of phones) this.server.to(`user:${id}`).emit(eventType, payload);
        this.emitOperational(eventType, payload);
        break;
      }

      /** An expense claim approved or rejected: the claimant's phone, and the desk. Ids only. */
      case 'expense:decided': {
        if (payload.assayerId) this.server.to(`user:${payload.assayerId}`).emit(eventType, payload);
        this.emitOperational(eventType, payload);
        break;
      }

      case 'communication:created': {
        if (payload.assignmentId) {
          this.server.to(`assignment:${payload.assignmentId}`).emit('communication:created', payload);
        }
        this.emitOperational('communication:created', payload);
        break;
      }

      /**
       * Money events. The desk hears all of them through the operational rooms (never `org:`, so
       * never an assayer's phone by that route).
       *
       * The assayer's own phone hears only the two that move something the app shows AFTER the
       * work is billed — their invoice invitation and their payout's progress — because the app is
       * money-blind until then. `billing:booked` (a payable booked at completion) and
       * `billing:invoice-changed` (a CLIENT invoice) are desk facts and used to reach the phone
       * too. Payloads carry ids and statuses, never amounts.
       */
      case 'billing:payout-changed':
      case 'billing:assayer-invoice-changed': {
        if (payload.assayerId) {
          this.server.to(`user:${payload.assayerId}`).emit(eventType, payload);
        }
        this.emitOperational(eventType, payload);
        break;
      }

      case 'billing:booked':
      case 'billing:invoice-changed': {
        this.emitOperational(eventType, payload);
        break;
      }

      case 'branch:created':
      case 'branch:updated': {
        if (payload.clientId) {
          this.server.to(`client:${payload.clientId}`).emit(eventType, payload);
        }
        this.emitOperational(eventType, payload);
        break;
      }

      case 'client:created':
      case 'client:updated':
      case 'client:status-changed': {
        this.emitOperational(eventType, payload);
        break;
      }

      case 'organization:created':
      case 'organization:updated': {
        this.emitOperational(eventType, payload);
        break;
      }

      case 'user:created':
      case 'user:updated':
      case 'user:role-changed': {
        if (payload.userId) {
          this.server.to(`user:${payload.userId}`).emit(eventType, payload);
        }
        this.emitOperational(eventType, payload);
        break;
      }

      case 'assayer:created':
      case 'assayer:updated':
      case 'assayer:deleted': {
        if (payload.aggregateId) {
          this.server.to(`user:${payload.aggregateId}`).emit(eventType, payload);
        }
        this.emitOperational(eventType, payload);
        break;
      }

      case 'project:created':
      case 'project:updated':
      case 'project:deleted': {
        this.emitOperational(eventType, payload);
        break;
      }

      case 'holiday:created':
      case 'holiday:updated':
      case 'holiday:deleted': {
        this.emitOperational(eventType, payload);
        break;
      }

      case 'zone:created':
      case 'zone:updated':
      case 'zone:deleted': {
        if (payload.clientId) {
          this.server.to(`client:${payload.clientId}`).emit(eventType, payload);
        }
        this.emitOperational(eventType, payload);
        break;
      }

      /**
       * Voice-call signalling (ring / answered / ended). Strictly targeted: a call event
       * goes only to the users named on it — never to an org-wide room, because "the phone
       * is ringing" pushed to every staff browser would ring desks that were never called.
       * The one exception is a ring with no resolvable callee (`ringStaffRoom`), where the
       * clarification has no recorded raiser and the whole desk is better than nobody.
       */
      case 'call:incoming':
      case 'call:answered':
      case 'call:ended': {
        for (const uid of payload.targetUserIds ?? []) {
          this.server.to(`user:${uid}`).emit(eventType, payload);
        }
        if (eventType === 'call:incoming' && payload.ringStaffRoom) {
          this.server.to('staff').emit(eventType, payload);
        }
        break;
      }

      /**
       * A background job changed (queued, progressed, finished). Only ever to the person who
       * started it: the payload names their file and what it did, and nobody else's Jobs tray
       * should hear about it. An administrator watching everybody's jobs reads them by poll.
       * Must NOT fall through to `default`, which would broadcast it to the operational rooms.
       */
      case 'job:updated': {
        if (payload?.requestedBy && payload?.job) {
          this.server.to(`user:${payload.requestedBy}`).emit('job:updated', payload.job);
        }
        break;
      }

      default: {
        this.broadcastGenericEvent(eventType, payload);
        break;
      }
    }
  }

  private broadcastGenericEvent(eventName: string, payload: any) {
    const aggregateId = payload?.aggregateId;

    if (eventName.startsWith('Project') || eventName.startsWith('ProjectBranch')) {
      if (aggregateId) {
        this.server.to(`project:${aggregateId}`).emit(eventName, payload);
      }
      this.emitOperational(eventName, payload);
      return;
    }

    if (eventName.startsWith('Assayer')) {
      if (aggregateId) {
        this.server.to(`user:${aggregateId}`).emit(eventName, payload);
      }
      this.emitOperational(eventName, payload);
      return;
    }

    if (eventName.startsWith('Validation')) {
      if (aggregateId) {
        this.server.to(`validation:${aggregateId}`).emit(eventName, payload);
      }
      this.emitOperational(eventName, payload);
      return;
    }

    this.emitOperational(eventName, payload);
  }

  sendToUser(userId: string, event: string, data: any) {
    if (this.server) {
      this.server.to(`user:${userId}`).emit(event, data);
    }
  }

  sendToAssignment(assignmentId: string, event: string, data: any) {
    if (this.server) {
      this.server.to(`assignment:${assignmentId}`).emit(event, data);
    }
  }
}
