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

interface AuthenticatedSocket extends Socket {
  user?: {
    id: string;
    userId?: string;
    roles?: { name: string }[];
    organizationId?: string;
  };
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

  @SubscribeMessage('subscribe:assignment')
  async handleSubscribeAssignment(client: AuthenticatedSocket, assignmentId: string) {
    if (client.user?.id) {
      await client.join(`assignment:${assignmentId}`);
    }
  }

  @SubscribeMessage('unsubscribe:assignment')
  async handleUnsubscribeAssignment(client: AuthenticatedSocket, assignmentId: string) {
    if (client.user?.id) {
      await client.leave(`assignment:${assignmentId}`);
    }
  }

  @SubscribeMessage('subscribe:query')
  async handleSubscribeQuery(client: AuthenticatedSocket, queryId: string) {
    if (client.user?.id) {
      await client.join(`query:${queryId}`);
    }
  }

  @SubscribeMessage('unsubscribe:query')
  async handleUnsubscribeQuery(client: AuthenticatedSocket, queryId: string) {
    if (client.user?.id) {
      await client.leave(`query:${queryId}`);
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
   */
  private emitOperational(eventName: string, payload: any) {
    const orgId = payload?.organizationId || payload?.metadata?.organizationId;
    if (orgId) {
      this.server.to(`org:${orgId}`).emit(eventName, payload);
      return;
    }
    this.server.to('staff').emit(eventName, payload);
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

      case 'assignment:fee-updated': {
        if (payload.assayerId) {
          this.server.to(`user:${payload.assayerId}`).emit('assignment:fee-updated', payload);
        }
        if (payload.organizationId) {
          this.server.to(`org:${payload.organizationId}`).emit('assignment:fee-updated', payload);
        }
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
      case 'query:responded': {
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

      case 'billing:created': {
        if (payload.assayerId) {
          this.server.to(`user:${payload.assayerId}`).emit('billing:created', payload);
        }
        this.emitOperational('billing:created', payload);
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
