import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Injectable } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { RegionGuardService, RoomVerdict } from '../../infrastructure/scope/region-guard.service';
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
}

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
  ) {
    this.eventPublisher.onPublish((eventName, payload) => {
      this.broadcastEvent(eventName, payload);
    });
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

      let payload: any;
      try {
        payload = await this.jwtService.verifyAsync(token as string);
      } catch {
        // No valid, signed JWT — never trust an unsigned decode or the raw token string.
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

      client.user = {
        id: userId,
        userId,
        roles: payload.roles || [],
        organizationId: payload.organizationId,
      };

      // With the Redis adapter, join() is async (room membership propagates across nodes). Await it
      // so a broadcast issued right after connect can't race ahead of the socket joining its rooms.
      await client.join(`user:${userId}`);

      if (payload.roles) {
        for (const role of payload.roles) {
          const roleName = typeof role === 'string' ? role : role.name;
          if (roleName) await client.join(`role:${roleName}`);
        }
      }

      if (payload.organizationId) {
        await client.join(`org:${payload.organizationId}`);
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
      const roleNames: string[] = (payload.roles || [])
        .map((r: any) => (typeof r === 'string' ? r : r?.name))
        .filter(Boolean);

      // ASSAYER and CLIENT_USER are external principals. CLIENT_USER is excluded for the same
      // reason `STAFF_ROLES` excludes it: `users` has no client_id, so a client user cannot be
      // scoped to their own client, and unscoped access to every client's operational traffic
      // is worse than no live updates. A token carrying no roles at all is treated as external
      // too — the room is opt-in, never a default.
      const EXTERNAL_ROLES = ['ASSAYER', 'CLIENT_USER'];
      const isInternalStaff =
        roleNames.length > 0 && roleNames.some((r) => !EXTERNAL_ROLES.includes(r));
      if (isInternalStaff) {
        await client.join('staff');

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
        const regions = await this.regionGuard.getUserRegions(userId).catch(() => null);
        // An unassigned account is national and joins every region room; an assigned one joins
        // only its own. Failing to read the assignment (the catch above) yields null → national,
        // which matches how the account behaved before this room existed.
        const rooms = regions ?? ALL_REGIONS;
        for (const r of rooms) await client.join(`region:${r}`);
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
   * Replaces the bare `this.server.emit(...)` that every branch of `broadcastEvent` used to
   * end with. That form ignores rooms entirely and delivers to every connected socket, which
   * on this system meant field assayers' phones received the whole operational firehose —
   * other assayers' assignments and fees, client and branch records, billing events.
   *
   * Delivery is to the event's own organisation where the payload names one, and otherwise to
   * internal staff. Assayers still receive everything genuinely theirs through the
   * `user:` and `assignment:` room emits, which are untouched.
   *
   * ## Region routing
   *
   * On top of that, an event that can be placed in a region goes to `region:<R>` rather than
   * the whole staff/org room, so a region-assigned operator does not receive other regions'
   * branch names, codes and assignment traffic. The region is *resolved* from whatever
   * identifier the payload carries rather than read from a field, because 75 call sites
   * publish these events and a publisher that forgot the field would be a silent leak.
   *
   * Fire-and-forget: the resolution is a cached, indexed lookup, and a failure degrades to the
   * previous unrouted behaviour rather than dropping the event.
   */
  private emitOperational(eventName: string, payload: any) {
    void this.regionGuard
      .resolveEventRegion(payload)
      .catch(() => null)
      .then((region) => {
        const orgId = payload?.organizationId || payload?.metadata?.organizationId;
        const base = orgId ? `org:${orgId}` : 'staff';
        if (region) {
          // Intersection of "this organisation" and "this region" — socket.io treats multiple
          // `.to()` calls as a union, so the org room is deliberately not added here.
          this.server.to(`region:${region}`).emit(eventName, payload);
          return;
        }
        this.server.to(base).emit(eventName, payload);
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
        if (payload.organizationId) {
          this.server.to(`org:${payload.organizationId}`).emit('assignment:created', payload);
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
        if (payload.organizationId) {
          this.server.to(`org:${payload.organizationId}`).emit('assignment:status-changed', payload);
        }
        this.emitOperational('assignment:status-changed', payload);
        break;
      }

      /**
       * A counter-offer — the single event a fee negotiation actually runs on.
       *
       * It had no case here at all, so it fell through to `broadcastGenericEvent`, whose only
       * delivery is `emitOperational` — the staff/region/org rooms. Assayers are deliberately
       * excluded from those rooms (see EXTERNAL_ROLES above), and the `assignment:` room was
       * never addressed either. The consequence was one-directional negotiation: an assayer
       * countering from the field appeared on the desk live, but when the desk countered back
       * the offer sat on the server and the assayer's phone showed the old fee until they
       * pulled to refresh — even though the mobile app subscribes to this exact event.
       *
       * Routed like `assignment:status-changed`, because it is the same kind of change: the
       * assayer it concerns, anyone watching that assignment, and the desk.
       */
      case 'assignment:counter-offered': {
        const coAsnId = payload.assignmentId || payload.aggregateId;
        if (coAsnId) {
          this.server.to(`assignment:${coAsnId}`).emit('assignment:counter-offered', payload);
        }
        if (payload.assayerId) {
          this.server.to(`user:${payload.assayerId}`).emit('assignment:counter-offered', payload);
        }
        if (payload.organizationId) {
          this.server.to(`org:${payload.organizationId}`).emit('assignment:counter-offered', payload);
        }
        this.emitOperational('assignment:counter-offered', payload);
        break;
      }

      case 'assignment:fee-updated': {
        if (payload.assayerId) {
          this.server.to(`user:${payload.assayerId}`).emit('assignment:fee-updated', payload);
        }
        if (payload.organizationId) {
          this.server.to(`org:${payload.organizationId}`).emit('assignment:fee-updated', payload);
        }
        // Same gap as `assignment:created`: with delivery limited to `org:`, an agreed fee — the
        // number a negotiation exists to settle — never reached the desk's queues live.
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
        if (payload.organizationId) {
          this.server.to(`org:${payload.organizationId}`).emit(eventType, payload);
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

      case 'query:raised':
      case 'query:responded':
      // Every message posted to a clarification thread. Same audience as the lifecycle
      // events: the open thread's room, the assayer's phone, and the operational rooms.
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
        if (payload.organizationId) {
          this.server.to(`org:${payload.organizationId}`).emit(eventType, payload);
        }
        this.emitOperational(eventType, payload);
        break;
      }

      /**
       * Feedback & collaboration channel. The open thread's room gets every event;
       * the reporter's own room mirrors it so their "my feedback" list stays live —
       * except internal team notes, which the reporter must never receive. The
       * feedback team (FEEDBACK_TEAM_ROLES — super administrators only) hear it in their
       * role rooms so their queue and dashboard refresh without a manual reload.
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
      case 'document:status-changed': {
        if (payload.projectBranchId) {
          this.server.to(`branch:${payload.projectBranchId}`).emit(eventType, payload);
        }
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

      // Money events. The assayer whose money moved hears it on their phone; the desk hears all.
      case 'billing:booked':
      case 'billing:payout-changed':
      case 'billing:invoice-changed': {
        if (payload.assayerId) {
          this.server.to(`user:${payload.assayerId}`).emit(eventType, payload);
        }
        this.emitOperational(eventType, payload);
        break;
      }

      case 'branch:created':
      case 'branch:updated': {
        if (payload.clientId) {
          this.server.to(`client:${payload.clientId}`).emit(eventType, payload);
        }
        if (payload.organizationId) {
          this.server.to(`org:${payload.organizationId}`).emit(eventType, payload);
        }
        this.emitOperational(eventType, payload);
        break;
      }

      case 'client:created':
      case 'client:updated':
      case 'client:status-changed': {
        if (payload.organizationId) {
          this.server.to(`org:${payload.organizationId}`).emit(eventType, payload);
        }
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
        if (payload.organizationId) {
          this.server.to(`org:${payload.organizationId}`).emit(eventType, payload);
        }
        this.emitOperational(eventType, payload);
        break;
      }

      case 'project:created':
      case 'project:updated':
      case 'project:deleted': {
        if (payload.organizationId) {
          this.server.to(`org:${payload.organizationId}`).emit(eventType, payload);
        }
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

      default: {
        this.broadcastGenericEvent(eventType, payload);
        break;
      }
    }
  }

  private broadcastGenericEvent(eventName: string, payload: any) {
    const aggregateId = payload?.aggregateId;

    if (eventName.startsWith('Project') || eventName.startsWith('ProjectBranch')) {
      if (payload?.metadata?.organizationId) {
        this.server.to(`org:${payload.metadata.organizationId}`).emit(eventName, payload);
      }
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
