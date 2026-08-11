import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { AccessToken } from 'livekit-server-sdk';
import { ValidationQueryEntity } from '../validation-query/validation-query.entity';
import { QueryMessageAuthor, ValidationQueryMessageEntity } from '../validation-query/validation-query-message.entity';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';

/**
 * Voice calls between the assayer on a clarification and the data-entry desk.
 *
 * Media never touches this server — audio flows through the self-hosted LiveKit SFU
 * (docker-compose `livekit`). What lives here is everything a *call* is beyond audio:
 * who may ring whom, the ring/answer/decline/missed lifecycle, and the paper trail —
 * every call outcome is written into the clarification's own thread, because a call about
 * a query is part of that query's story, exactly like a typed reply.
 *
 * The room name is derived from the query id, so a call is always anchored to the
 * clarification it is about. Tokens are minted per-participant, audio-only, short-lived,
 * and scoped to that one room — possession of a token for one call grants nothing else.
 *
 * Ring state is in-memory (`active` map + missed-call timers). That is correct for the
 * single-node deployment this ships into; on multiple API replicas it must move to Redis —
 * marked below rather than silently assumed.
 */
export interface ActiveCall {
  roomName: string;
  queryId: string;
  callerUserId: string;
  callerName: string;
  callerIsAssayer: boolean;
  /** User ids that were rung and may answer. */
  calleeUserIds: string[];
  startedAt: number;
  answeredAt: number | null;
  missedTimer: NodeJS.Timeout | null;
}

/** How long a call rings before it is recorded as missed and the caller told to give up. */
const RING_TIMEOUT_MS = 40_000;
/** Tokens outlive the longest plausible answer delay, not the call — LiveKit keeps a joined participant connected after expiry. */
const TOKEN_TTL_SECONDS = 10 * 60;

@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);
  private readonly active = new Map<string, ActiveCall>();

  constructor(
    @InjectRepository(ValidationQueryEntity)
    private readonly queryRepository: Repository<ValidationQueryEntity>,
    @InjectRepository(ValidationQueryMessageEntity)
    private readonly messageRepository: Repository<ValidationQueryMessageEntity>,
    private readonly events: DomainEventPublisher,
    private readonly notificationDispatch: NotificationDispatchService,
  ) {}

  /**
   * Client-facing LiveKit signaling address. A relative path, on purpose: clients never
   * talk to the SFU directly. They resolve `/livekit` against the origin they already use
   * (web: the page's own origin through the Vite proxy; mobile: its API origin), and this
   * server pipes the WebSocket to the livekit container (see main.ts). No second public
   * endpoint, no host leakage, nothing client-steerable. LIVEKIT_PUBLIC_URL can still
   * override for a deployment that fronts the SFU with its own TLS name.
   */
  config(): { url: string } {
    return { url: process.env.LIVEKIT_PUBLIC_URL || '/livekit' };
  }

  /**
   * Start a call about a clarification.
   *
   * The caller is either the query's assayer or a member of staff; the callee is whoever
   * is on the other side: staff ring the assayer's `user:` room, the assayer rings the
   * user who raised the query (with the whole staff room as fallback when the raiser is
   * unknown — an unanswerable call is worse than a broad ring to the desk).
   */
  async initiate(user: { id: string; name?: string; isAssayer: boolean }, queryId: string) {
    const query = await this.queryRepository.findOne({ where: { id: queryId, isActive: true } });
    if (!query) throw new NotFoundException('Clarification not found.');

    if (user.isAssayer && query.assayerId !== user.id) {
      throw new ForbiddenException('You can only call about your own clarifications.');
    }

    const calleeUserIds = user.isAssayer
      ? await this.resolveDeskCallee(query)
      : [query.assayerId];

    // One live call per query. A second initiate while one rings is almost always a
    // double-tap; joining the existing ring keeps both parties in the same room.
    const existing = [...this.active.values()].find((c) => c.queryId === queryId);
    if (existing) {
      return {
        roomName: existing.roomName,
        url: this.config().url,
        token: await this.mintToken(existing.roomName, user.id, user.name),
        rejoined: true,
      };
    }

    const roomName = `query-${queryId}-${Date.now()}`;
    const call: ActiveCall = {
      roomName,
      queryId,
      callerUserId: user.id,
      callerName: user.name || (user.isAssayer ? 'Field assayer' : 'Data entry desk'),
      callerIsAssayer: user.isAssayer,
      calleeUserIds,
      startedAt: Date.now(),
      answeredAt: null,
      missedTimer: setTimeout(() => this.expireUnanswered(roomName), RING_TIMEOUT_MS),
    };
    this.active.set(roomName, call);

    // Ring the other side. Target users get it in their `user:` room; when an assayer's
    // query has no recorded raiser, the desk's shared room rings instead so *someone* can
    // pick up. Payload is routed by the events gateway's `call:*` cases.
    this.events.publish('call:incoming', {
      eventType: 'call:incoming',
      roomName,
      queryId,
      callerUserId: call.callerUserId,
      callerName: call.callerName,
      targetUserIds: calleeUserIds,
      ringStaffRoom: !user.isAssayer ? false : calleeUserIds.length === 0,
      queryText: query.queryText?.slice(0, 120) ?? null,
    });

    return {
      roomName,
      url: this.config().url,
      token: await this.mintToken(roomName, user.id, user.name),
      rejoined: false,
    };
  }

  /**
   * Which ONE desk person an assayer's call should ring.
   *
   * Order of preference: the user who raised the query; else the staff member who last
   * wrote in this thread (they own the conversation — call records are excluded because
   * assayer-initiated calls also log into the thread). Only when the thread has never
   * been touched by any identifiable staff member does the desk-wide ring remain — an
   * unanswerable call is worse than a broad one, but it is now the true last resort.
   */
  private async resolveDeskCallee(query: ValidationQueryEntity): Promise<string[]> {
    if (query.raisedByUserId) return [query.raisedByUserId];
    const lastStaffMessage = await this.messageRepository.findOne({
      where: {
        validationQueryId: query.id,
        authorType: QueryMessageAuthor.STAFF,
        // The assayer's own call records are logged with their id; never ring the assayer.
        authorId: Not(query.assayerId),
      },
      order: { createdAt: 'DESC' },
    });
    return lastStaffMessage?.authorId ? [lastStaffMessage.authorId] : [];
  }

  /** Callee accepts: cancel the missed-call clock, tell both sides, hand back a token. */
  async answer(user: { id: string; name?: string }, roomName: string) {
    const call = this.mustBeParty(roomName, user.id, /* calleeOnly */ true);
    if (call.missedTimer) { clearTimeout(call.missedTimer); call.missedTimer = null; }
    call.answeredAt = call.answeredAt ?? Date.now();

    this.events.publish('call:answered', {
      eventType: 'call:answered',
      roomName,
      queryId: call.queryId,
      targetUserIds: [call.callerUserId, ...call.calleeUserIds],
      answeredByUserId: user.id,
    });

    return {
      roomName,
      url: this.config().url,
      token: await this.mintToken(roomName, user.id, user.name),
    };
  }

  /** Callee declines the ring. Logged in the thread — a refused call is an event, not a non-event. */
  async decline(user: { id: string }, roomName: string) {
    const call = this.mustBeParty(roomName, user.id, true);
    await this.close(call, 'declined', `Call declined`);
    return { ok: true };
  }

  /** Either side hangs up. Before answer this is a cancel; after, a completed call with duration. */
  async hangup(user: { id: string }, roomName: string) {
    const call = this.mustBeParty(roomName, user.id, false);
    if (call.answeredAt) {
      const seconds = Math.max(1, Math.round((Date.now() - call.answeredAt) / 1000));
      const mins = Math.floor(seconds / 60);
      await this.close(call, 'ended', `Voice call — ${mins ? `${mins}m ` : ''}${seconds % 60}s`);
    } else {
      await this.close(call, 'cancelled', 'Call cancelled before answer');
    }
    return { ok: true };
  }

  /** Nobody picked up inside the ring window. */
  private async expireUnanswered(roomName: string) {
    const call = this.active.get(roomName);
    if (!call || call.answeredAt) return;
    await this.close(call, 'missed', 'Missed call');
  }

  /**
   * Tear a call down: broadcast the end to every party and append the outcome to the
   * clarification thread. The thread write goes straight to the message repository rather
   * than through `postMessage` — a system-generated call record must not be blocked by the
   * guards that govern human replies (resolved threads, author identity).
   */
  private async close(call: ActiveCall, reason: 'ended' | 'declined' | 'missed' | 'cancelled', logLine: string) {
    if (call.missedTimer) clearTimeout(call.missedTimer);
    this.active.delete(call.roomName);

    this.events.publish('call:ended', {
      eventType: 'call:ended',
      roomName: call.roomName,
      queryId: call.queryId,
      reason,
      targetUserIds: [call.callerUserId, ...call.calleeUserIds],
    });

    try {
      const message = this.messageRepository.create({
        validationQueryId: call.queryId,
        authorType: call.callerIsAssayer ? QueryMessageAuthor.ASSAYER : QueryMessageAuthor.STAFF,
        authorId: call.callerUserId,
        authorName: call.callerName,
        body: `📞 ${logLine}`,
        createdBy: call.callerUserId,
        updatedBy: call.callerUserId,
      });
      await this.messageRepository.save(message);
      await this.queryRepository.update(call.queryId, { lastMessageAt: new Date() });
    } catch (err) {
      // The call itself succeeded or failed on its own terms; a logging failure must not
      // surface as a call error. It is still a real loss — say so loudly in the log.
      this.logger.error(`Failed to record call outcome for query ${call.queryId}: ${(err as Error).message}`);
    }

    /**
     * A missed call is the one outcome the callee has no way to discover: the ring
     * disappeared from a screen they weren't looking at, and the thread line lands in a
     * conversation they'd have to open to see. Only the *callee* is told — the caller
     * watched it go unanswered. A desk-wide ring with no resolvable callee
     * (`calleeUserIds` empty) has nobody specific to tell, so it stays a thread entry.
     */
    if (reason === 'missed' && call.calleeUserIds.length > 0) {
      const calleeId = call.calleeUserIds[0];
      this.notificationDispatch.emitSafe({
        type: 'CALL_MISSED',
        entityType: 'VALIDATION_QUERY',
        entityId: call.queryId,
        actorUserId: call.callerUserId,
        // The callee sits on whichever side the caller isn't: an assayer's call rings the
        // desk user, and the desk's call rings the assayer.
        assayerId: call.callerIsAssayer ? null : calleeId,
        ownerUserId: call.callerIsAssayer ? calleeId : null,
        dedupeKey: `CALL_MISSED:${call.roomName}`,
        payload: {
          queryId: call.queryId,
          roomName: call.roomName,
          callerName: call.callerName,
        },
      });
    }
  }

  private mustBeParty(roomName: string, userId: string, calleeOnly: boolean): ActiveCall {
    const call = this.active.get(roomName);
    if (!call) throw new NotFoundException('This call has already ended.');
    const isCaller = call.callerUserId === userId;
    const isCallee = call.calleeUserIds.includes(userId) || call.calleeUserIds.length === 0;
    if (calleeOnly ? !isCallee : !(isCaller || isCallee)) {
      throw new ForbiddenException('You are not a participant in this call.');
    }
    return call;
  }

  /** Audio-only token, one room, short TTL. */
  private async mintToken(roomName: string, userId: string, name?: string): Promise<string> {
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!apiKey || !apiSecret) {
      throw new BadRequestException('Calling is not configured on this server (LIVEKIT_API_KEY/SECRET missing).');
    }
    const token = new AccessToken(apiKey, apiSecret, {
      identity: userId,
      name: name || undefined,
      ttl: TOKEN_TTL_SECONDS,
    });
    token.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
    });
    return token.toJwt();
  }
}
