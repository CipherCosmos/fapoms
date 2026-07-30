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

      client.join(`user:${userId}`);

      if (payload.roles) {
        for (const role of payload.roles) {
          const roleName = typeof role === 'string' ? role : role.name;
          if (roleName) client.join(`role:${roleName}`);
        }
      }

      if (payload.organizationId) {
        client.join(`org:${payload.organizationId}`);
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
  handleSubscribeAssignment(client: AuthenticatedSocket, assignmentId: string) {
    if (client.user?.id) {
      client.join(`assignment:${assignmentId}`);
    }
  }

  @SubscribeMessage('unsubscribe:assignment')
  handleUnsubscribeAssignment(client: AuthenticatedSocket, assignmentId: string) {
    if (client.user?.id) {
      client.leave(`assignment:${assignmentId}`);
    }
  }

  @SubscribeMessage('subscribe:query')
  handleSubscribeQuery(client: AuthenticatedSocket, queryId: string) {
    if (client.user?.id) {
      client.join(`query:${queryId}`);
    }
  }

  @SubscribeMessage('unsubscribe:query')
  handleUnsubscribeQuery(client: AuthenticatedSocket, queryId: string) {
    if (client.user?.id) {
      client.leave(`query:${queryId}`);
    }
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
        this.server.emit('assignment:status-changed', payload);
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
        this.server.emit(eventType, payload);
        break;
      }

      case 'notification:new': {
        if (payload.userId) {
          this.server.to(`user:${payload.userId}`).emit('notification:new', payload);
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
        this.server.emit(eventType, payload);
        break;
      }

      case 'document:uploaded':
      case 'document:status-changed': {
        if (payload.projectBranchId) {
          this.server.to(`branch:${payload.projectBranchId}`).emit(eventType, payload);
        }
        this.server.emit(eventType, payload);
        break;
      }

      case 'communication:created': {
        if (payload.assignmentId) {
          this.server.to(`assignment:${payload.assignmentId}`).emit('communication:created', payload);
        }
        this.server.emit('communication:created', payload);
        break;
      }

      case 'billing:created': {
        if (payload.assayerId) {
          this.server.to(`user:${payload.assayerId}`).emit('billing:created', payload);
        }
        this.server.emit('billing:created', payload);
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
        this.server.emit(eventType, payload);
        break;
      }

      case 'client:created':
      case 'client:updated':
      case 'client:status-changed': {
        if (payload.organizationId) {
          this.server.to(`org:${payload.organizationId}`).emit(eventType, payload);
        }
        this.server.emit(eventType, payload);
        break;
      }

      case 'organization:created':
      case 'organization:updated': {
        this.server.emit(eventType, payload);
        break;
      }

      case 'user:created':
      case 'user:updated':
      case 'user:role-changed': {
        if (payload.userId) {
          this.server.to(`user:${payload.userId}`).emit(eventType, payload);
        }
        this.server.emit(eventType, payload);
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
        this.server.emit(eventType, payload);
        break;
      }

      case 'project:created':
      case 'project:updated':
      case 'project:deleted': {
        if (payload.organizationId) {
          this.server.to(`org:${payload.organizationId}`).emit(eventType, payload);
        }
        this.server.emit(eventType, payload);
        break;
      }

      case 'audit:started':
      case 'audit:closed': {
        if (payload.assayerId) {
          this.server.to(`user:${payload.assayerId}`).emit(eventType, payload);
        }
        if (payload.projectId) {
          this.server.to(`project:${payload.projectId}`).emit(eventType, payload);
        }
        this.server.emit(eventType, payload);
        break;
      }

      case 'holiday:created':
      case 'holiday:updated':
      case 'holiday:deleted': {
        this.server.emit(eventType, payload);
        break;
      }

      case 'zone:created':
      case 'zone:updated':
      case 'zone:deleted': {
        if (payload.clientId) {
          this.server.to(`client:${payload.clientId}`).emit(eventType, payload);
        }
        this.server.emit(eventType, payload);
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
      this.server.emit(eventName, payload);
      return;
    }

    if (eventName.startsWith('Assayer')) {
      if (aggregateId) {
        this.server.to(`user:${aggregateId}`).emit(eventName, payload);
      }
      this.server.emit(eventName, payload);
      return;
    }

    if (eventName.startsWith('Validation')) {
      if (aggregateId) {
        this.server.to(`validation:${aggregateId}`).emit(eventName, payload);
      }
      this.server.emit(eventName, payload);
      return;
    }

    this.server.emit(eventName, payload);
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
