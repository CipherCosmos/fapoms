import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { In, Repository } from 'typeorm';
import {
  EventCategory,
  NotificationChannel,
  NotificationStatus,
  // The addressing direction of the role hierarchy: an audience naming ADMIN (or
  // PRODUCT_SUPPORT) also reaches every role that implies it — today, DEVELOPER — so a pure
  // developer hears everything addressed to the roles they absorbed, without the catalog
  // naming DEVELOPER anywhere. (expandRoles is the gating direction; this is who-should-hear.)
  expandAudience,
} from '@fapoms/shared';
import { NotificationEntity } from './notification.entity';
import { NotificationPreferenceEntity } from './notification-preference.entity';
import { UserEntity } from '../user/user.entity';
import { AuditService } from '../../core/audit/audit.service';
import { NOT_A_RECORD_ENTITY_ID } from '../../core/audit/audit-event';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { NOTIFICATION_CATALOG, renderTemplate } from './notification-catalog';
import { NotificationSettingsService, EffectiveNotificationType } from './notification-settings.service';
import { NOTIFICATION_QUEUE } from './notification.constants';
import { usersHoldingPermission } from './permission-audience';
import { NotificationTenancy, NotificationTenancyService } from './notification-tenancy';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { FAILED_JOB_RETENTION } from '../../infrastructure/queue/queued-job';

export interface EmitOptions {
  /** A key in `NOTIFICATION_CATALOG`. */
  type: string;
  /** Fills the templates and is stored for deep-linking. */
  payload: Record<string, any>;
  entityType?: string;
  entityId?: string;
  /** Whoever triggered this — excluded from recipients when `skipActor`. */
  actorUserId?: string | null;
  /** Resolves the `ASSIGNED_ASSAYER` recipient. */
  assayerId?: string | null;
  /** Resolves the `RECORD_OWNER` recipient. */
  ownerUserId?: string | null;
  /**
   * Collapses repeats of one logical event. Same key twice = one notification.
   * Defaults to `type:entityId`, which is right for state changes and wrong for
   * anything genuinely repeatable — pass an explicit key there.
   */
  dedupeKey?: string;
  /**
   * The owning organisation, when the caller already knows it beyond doubt.
   *
   * Optional on purpose, and almost nothing should pass it: the organisation is derived from the
   * emitting entity instead (`NotificationTenancyService`), because there are ~50 call sites and
   * a required field that 49 remember is a leak on the fiftieth. This exists for the case
   * `TenantContext`'s own comment describes — "background work that touches tenant-owned data
   * must carry the organisation id explicitly in its job payload and pass it down" — where a
   * worker holds the id and the event has no single entity to look it up from. It is trusted
   * over the entity lookup, so it must never be filled in from the requesting principal.
   */
  organizationId?: string | null;
}

export interface EmitResult {
  groupKey: string;
  created: number;
  suppressed: number;
  recipients: { userIds: string[]; assayerIds: string[] };
  /** The organisation this event was scoped to; null for a platform-scoped type. */
  organizationId: string | null;
}

/**
 * Turns one business event into the right set of notifications.
 *
 * This is the piece that was missing. Previously a service that wanted to tell
 * someone something had to know *who* — so it either hardcoded a single user id
 * or, far more often, told nobody. Here a service says only what happened, and
 * the catalog plus the live role assignments decide who hears about it.
 *
 * Delivery is split by channel. In-app recipients are `DELIVERED` the moment the
 * row exists — for them the row *is* the delivery, already visible in their
 * bell. Push is handed to `NotificationDeliveryWorker` via the queue, so a slow
 * or unreachable FCM delays a push instead of slowing down, or failing, the
 * business action that raised it.
 */
@Injectable()
export class NotificationDispatchService {
  private readonly logger = new Logger(NotificationDispatchService.name);

  constructor(
    @InjectRepository(NotificationEntity)
    private readonly notificationRepository: Repository<NotificationEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(NotificationPreferenceEntity)
    private readonly preferenceRepository: Repository<NotificationPreferenceEntity>,
    private readonly auditService: AuditService,
    private readonly eventPublisher: DomainEventPublisher,
    @InjectQueue(NOTIFICATION_QUEUE)
    private readonly deliveryQueue: Queue,
    private readonly settings: NotificationSettingsService,
    private readonly regionGuard: RegionGuardService,
    private readonly tenancy: NotificationTenancyService,
  ) {}

  /**
   * Who receives an event whose own desk has nobody in it. The platform administrators — the
   * only role guaranteed to exist on a running deployment, and the people who can either act
   * on the work or create the account that should have received it. Like every audience list,
   * this passes through `expandAudience` in `usersInRoles`, so a pure DEVELOPER hears the
   * fallback too.
   */
  private static readonly FALLBACK_ROLES = ['ADMIN'];

  /**
   * Every active user holding any of `roleNames`, unioned with every active user who holds
   * `fallbackPermissions` through a role that name list has never heard of.
   *
   * The permission half mirrors `RolesGuard`'s own fall-through: a role built in Admin -> Roles
   * matches nothing in `roleNames` — that is a closed set of built-in `SystemRole` strings — so
   * without this it was invisible to every notification and digest section however precisely
   * its permissions matched the event. See `usersHoldingPermission` for the exact mirrored
   * semantics (only the unrecognised role's own grants count, so a built-in role already on
   * `roleNames` cannot also sneak in a second, coincidental way).
   *
   * Locked and inactive accounts are excluded from both halves — notifying a suspended user
   * creates an unread count nobody will ever clear, and for the auditor role in
   * particular it would leak operational detail to a disabled account.
   */
  private async usersInRoles(
    roleNames: string[],
    fallbackPermissions: string[] | undefined,
    tenancy: NotificationTenancy,
  ): Promise<UserEntity[]> {
    // Audience expansion before the IN-list: an event addressed to ADMIN also reaches DEVELOPER
    // (see the import note). Applied here, at the single point every audience passes through, so
    // the catalog, the fallback and every caller get the same rule.
    const audienceNames = expandAudience(roleNames);
    const byName = audienceNames.length
      ? await this.userRepository
          .createQueryBuilder('u')
          .innerJoin('u.roles', 'r')
          .where('r.name IN (:...roleNames)', { roleNames: audienceNames })
          .andWhere('u.is_active = true')
          .andWhere('u.status = :status', { status: 'ACTIVE' })
          .getMany()
      : [];

    if (!fallbackPermissions?.length) return this.withinOrganization(byName, tenancy);

    const byPermission = await usersHoldingPermission(this.userRepository, fallbackPermissions);
    const merged = new Map<string, UserEntity>();
    for (const u of [...byName, ...byPermission]) merged.set(u.id, u);
    return this.withinOrganization([...merged.values()], tenancy);
  }

  /**
   * The tenant ceiling on the role/permission audience: an event about organisation A reaches
   * only users of organisation A.
   *
   * Applied to the MERGED list, at the one point every audience passes through, rather than as a
   * predicate in each of the two queries above. The two halves are built by different code — the
   * name half here, the permission half in `permission-audience.ts`, deliberately mirroring
   * `RolesGuard` — and a `WHERE organization_id = …` copied into both is one edit away from
   * covering only one of them. That is the same reasoning `usersInRoles` already gives for
   * applying `expandAudience` here instead of at each call site, and the cost is the same: the
   * list is role holders, not the user table.
   *
   * ## Platform ADMIN and DEVELOPER get no exemption, deliberately
   *
   * `CROSS_TENANT_ROLES` (tenant-context.ts) lets ADMIN and DEVELOPER READ across organisations,
   * and it would have been easy to honour that here too — `TenantScopedRepository` does. It is
   * the wrong call for notifications, because reading across tenants and being pushed across
   * tenants are not the same act. A cross-tenant read is deliberate, one query at a time, by
   * someone who chose to look, and it leaves an audit trail. A notification is unsolicited: it
   * arrives in a bell, on a lock screen and in an inbox, carries a named individual and an
   * amount in its body, and nobody asked for it. On a deployment with N tenants it would also
   * make the platform administrator's bell the union of every tenant's CRITICAL alerts, which
   * trains exactly the "ignore the bell" habit the collapse rules exist to prevent. A platform
   * administrator hears about their own organisation, and reads the others when they mean to.
   *
   * A user with no organisation is in nobody's audience. Legacy null-organisation rows are gone
   * (migration 1796500000000 backfilled all five tenant-owned tables) but the columns are still
   * nullable, so a future insert path that forgets to stamp one would create a user who, under a
   * "null means everyone" reading, would receive every tenant's events. `TenantScopedRepository`
   * refuses unowned rows for the same reason and says so: "unknown owner" resolving to "anyone"
   * is not a defensible default.
   */
  private withinOrganization(users: UserEntity[], tenancy: NotificationTenancy): UserEntity[] {
    if (tenancy.scope === 'PLATFORM') return users;
    return users.filter((u) => !!u.organizationId && u.organizationId === tenancy.organizationId);
  }

  /**
   * Recipients for whom every channel this notification travels on is switched off.
   *
   * Absence of a preference row means opted in — nobody who has never opened the settings screen
   * is muted by omission. Only an explicit `false` counts, and only when it covers every channel
   * the type actually uses: muting push on an in-app-only type changes nothing, and muting in-app
   * on a type that also pushes leaves the push (and the row it is sent from) intact.
   *
   * One query for the whole audience rather than one per recipient: a fan-out to every operations
   * user already resolves N users, and this must not turn that into N round-trips.
   */
  private async fullyMutedRecipients(
    category: string,
    channels: NotificationChannel[],
    userIds: string[],
    assayerIds: string[],
  ): Promise<{ userIds: Set<string>; assayerIds: Set<string> }> {
    const empty = { userIds: new Set<string>(), assayerIds: new Set<string>() };
    if (!userIds.length && !assayerIds.length) return empty;

    const usesInApp = channels.includes(NotificationChannel.IN_APP);
    const usesPush = channels.includes(NotificationChannel.PUSH);
    const usesEmail = channels.includes(NotificationChannel.EMAIL);

    const prefs = await this.preferenceRepository.find({
      where: [
        ...(userIds.length ? [{ userId: In(userIds), category: category as any }] : []),
        ...(assayerIds.length ? [{ assayerId: In(assayerIds), category: category as any }] : []),
      ],
    }).catch((err: any) => {
      // Fail open. A preferences lookup that errors must not silence an escalation; the worst
      // case here is one notification somebody had muted, not a missing one.
      this.logger.warn(`Could not read notification preferences: ${err?.message}`);
      return [] as NotificationPreferenceEntity[];
    });

    const result = { userIds: new Set<string>(), assayerIds: new Set<string>() };
    for (const pref of prefs) {
      // Email only reaches internal users, so for an assayer the email channel can never be
      // the one keeping them audible — treating it as "on" for them would let an EMAIL-carrying
      // type resurrect an assayer who muted in-app and push.
      const emailSilent = pref.userId ? pref.email === false : true;
      const silent =
        (!usesInApp || pref.inApp === false) &&
        (!usesPush || pref.push === false) &&
        (!usesEmail || emailSilent);
      if (!silent) continue;
      if (pref.userId) result.userIds.add(pref.userId);
      if (pref.assayerId) result.assayerIds.add(pref.assayerId);
    }
    return result;
  }

  /**
   * Fold one event into a recipient's still-open notification of the same type, if there is one.
   *
   * "Still open" means unread, not deleted, and created inside the type's collapse window. Unread
   * is the important half: once somebody has read "New assayer onboarded", the next one is news
   * again and deserves its own line — merging into a read row would silently resurrect it.
   *
   * The surviving row keeps the first event's identity (`entityId`, and the payload the summary
   * renders from). Its text becomes the summary, its link the summary link, and its count goes
   * up. Returns true when the event was absorbed.
   *
   * Concurrency: bursts arrive from one bulk request in sequence, and a lost update here costs an
   * extra notification, never a missing one — so this is deliberately a read-then-write rather
   * than a lock. `collapsed_count` is incremented in SQL so parallel merges still add up.
   */
  private async mergeIntoOpenBurst(
    row: Partial<NotificationEntity>,
    def: (typeof NOTIFICATION_CATALOG)[string],
    payload: Record<string, any>,
  ): Promise<boolean> {
    const collapse = def.collapse!;
    const since = new Date(Date.now() - collapse.windowSeconds * 1000);

    try {
      const open = await this.notificationRepository
        .createQueryBuilder('n')
        .where('n.type = :type', { type: row.type })
        .andWhere(row.userId ? 'n.userId = :rid' : 'n.assayerId = :rid', {
          rid: row.userId ?? row.assayerId,
        })
        .andWhere('n.isRead = false')
        .andWhere('n.isActive = true')
        .andWhere('n.createdAt >= :since', { since })
        .orderBy('n.createdAt', 'DESC')
        .getOne();

      if (!open) return false;

      const count = (open.collapsedCount ?? 1) + 1;
      // Rendered from the FIRST event's payload plus the running count: a summary describes the
      // burst, and naming only the latest of 25 would be arbitrary and misleading.
      const summaryPayload = { ...(open.payload ?? {}), ...payload, count };

      await this.notificationRepository
        .createQueryBuilder()
        .update(NotificationEntity)
        .set({
          collapsedCount: () => '"collapsed_count" + 1',
          title: renderTemplate(collapse.title, summaryPayload),
          message: renderTemplate(collapse.body, summaryPayload),
          link: collapse.link
            ? renderTemplate(collapse.link, summaryPayload)
            : open.link,
        })
        .where('id = :id', { id: open.id })
        .execute();

      return true;
    } catch (err: any) {
      // Fail open: an error here must cost a tidier inbox, never the notification itself.
      this.logger.warn(`Could not collapse "${row.type}" into an open burst: ${err?.message}`);
      return false;
    }
  }

  async emit(opts: EmitOptions): Promise<EmitResult> {
    if (!NOTIFICATION_CATALOG[opts.type]) {
      // A typo in an event name must not take down the business action that
      // raised it, but it must not vanish either.
      this.logger.error(`Unknown notification type "${opts.type}" — nothing sent.`);
      return { groupKey: '', created: 0, suppressed: 0, recipients: { userIds: [], assayerIds: [] }, organizationId: null };
    }

    /**
     * The live definition, not the compiled-in one: an operator can switch a type off or
     * re-route its channels from the admin screen, and that has to bite on the very next
     * event. `defFor` returns null for a type somebody has disabled.
     */
    let def: EffectiveNotificationType | null;
    try {
      def = await this.settings.defFor(opts.type);
    } catch (err: any) {
      /**
       * The fallback belongs HERE and nowhere else.
       *
       * `defFor` returns null for a type an operator has switched off — a legitimate answer,
       * not a failure. Written as `defFor(...).catch(() => null) ?? CATALOG[type]` the two
       * cases collapse: the `??` cannot tell "disabled" from "lookup broke", so it resurrected
       * every disabled event from the shipped catalog and the off switch did nothing at all.
       * Only a thrown error means the settings are unreadable, and only then is falling back to
       * the compiled-in default the right answer.
       */
      this.logger.warn(`Notification settings unreadable for "${opts.type}", using the shipped default: ${err?.message}`);
      def = NOTIFICATION_CATALOG[opts.type] as EffectiveNotificationType;
    }

    if (!def) {
      this.logger.debug(`"${opts.type}" is switched off in notification settings — nothing sent.`);
      return { groupKey: '', created: 0, suppressed: 0, recipients: { userIds: [], assayerIds: [] }, organizationId: null };
    }

    const groupKey = `${opts.type}:${opts.entityId ?? 'na'}:${Date.now()}`;
    const dedupeKey = opts.dedupeKey ?? (opts.entityId ? `${opts.type}:${opts.entityId}` : null);

    /**
     * ── Which organisation is this event about? ──────────────────────────
     *
     * Resolved once, before anybody is chosen, because it decides both who may be chosen and
     * what every row is stamped with. `def.scope` comes from the catalog (absent means TENANT —
     * see `NotificationTypeDef.scope`) and is deliberately not overridable by an operator, so a
     * settings change cannot widen the boundary.
     */
    const tenancy = await this.tenancy.resolve(opts, def.scope ?? 'TENANT');

    /**
     * A tenant-scoped event whose tenant nobody can name is delivered to NOBODY by role.
     *
     * The alternative is what this fix removes: an unresolvable organisation falling through to
     * the whole deployment, which is finding F-07 exactly. The failure direction has to be
     * silence, and silence has to be loud — hence `error`, with the identifiers that were tried,
     * so the fix is "teach `ENTITY_ORGANIZATION_SQL` about this entity" rather than a hunt.
     *
     * Reachable today only past the single-organisation shortcut in `NotificationTenancyService`,
     * i.e. only on a deployment that genuinely has more than one tenant. The known offenders when
     * that day comes are the aggregate sweeps — `PAYABLE_AWAITING_APPROVAL` and
     * `ASSIGNMENT_ATTENDED_NOT_CLOSED`, both emitted with `entityId: 'backlog'` — which count
     * across every tenant's records at source and must be assembled per tenant before they can be
     * delivered per tenant. Individually addressed recipients below are unaffected: this refuses
     * a fan-out, not a message to a named person.
     */
    const namesAnAudience = def.roles.length > 0 || (def.fallbackPermissions?.length ?? 0) > 0;
    const audienceResolvable = tenancy.scope === 'PLATFORM' || !!tenancy.organizationId;
    if (namesAnAudience && !audienceResolvable) {
      this.logger.error(
        `"${opts.type}" is tenant-scoped but no organisation could be resolved for it — its ` +
          `${def.roles.join('/')} audience was NOT notified. Tried: ` +
          `${tenancy.attempted.join(', ') || 'no usable identifier on the event'}. Either give the ` +
          'emit an entity this can be derived from, pass organizationId explicitly, or declare the ' +
          "type scope: 'PLATFORM' if it genuinely belongs to no tenant.",
      );
    }

    // ── Resolve recipients ────────────────────────────────────────────────
    const roleUsers = namesAnAudience && audienceResolvable
      ? await this.usersInRoles(def.roles, def.fallbackPermissions, tenancy)
      : [];
    const userIds = new Set(roleUsers.map((u) => u.id));

    /**
     * Region ceiling on the role/permission audience — the same rule the read side enforces
     * (`RegionGuardService.assertRegionAllowed`): a region-assigned account hears only about its
     * own region's events, an unassigned (national) account hears about all of them. Applied
     * before the empty-audience fallback below, so an audience a region filter empties out is
     * treated exactly like one that started empty — routed to an administrator, not silently
     * dropped.
     *
     * `resolveEventRegion` reads `payload.assayerId` among other ids; `assayerId` is commonly a
     * top-level `EmitOptions` field rather than inside `payload` (every workforce/HR sweep is
     * exactly this shape), so it is merged in here rather than requiring every call site to
     * duplicate it into the payload.
     */
    if (userIds.size > 0) {
      const eventRegion = await this.regionGuard.resolveEventRegion({
        ...opts.payload,
        assayerId: opts.payload?.assayerId ?? opts.assayerId,
      });
      const inRegion = await this.regionGuard.filterUsersByRegion([...userIds], eventRegion);
      userIds.clear();
      for (const id of inRegion) userIds.add(id);
    }

    /**
     * A staffed-desk event must never reach nobody.
     *
     * The catalog names the desk that owns each event — VALIDATION_MANAGER, DATA_ENTRY_HEAD,
     * FINANCE_MANAGER and so on. That is right for a fully staffed organisation and wrong for
     * every real one before it gets there: on the live deployment exactly two roles have an
     * active holder (OPERATIONS_MANAGER and SUPER_ADMINISTRATOR), so twelve event types resolved
     * to zero recipients and were dropped with a log line nobody reads. The boot-time check
     * reports the same count and has been reporting it for weeks.
     *
     * Dropping the work is the one unacceptable outcome: these are SLA breaches, overdue desk
     * queues and correction requests — things whose entire purpose is to make a human act. So
     * when a type that *names* roles resolves to none of them, it falls back to whoever
     * administers the platform, who can then act or staff the role.
     *
     * Deliberately narrow. It does not fire for a type whose audience is purely an individual
     * (`roles: []` with `special: ['ASSIGNED_ASSAYER']`) — a missing assayer there is a
     * different fault, and routing every offer to an administrator would be noise. Nor does it
     * override a type that reached somebody, however few.
     *
     * `fallbackPermissions` counts as "names an audience" too, alongside `roles` — a type with
     * an empty `roles` list that named only a permission must not be treated as the
     * individual-audience case above and left to resolve to nobody silently.
     */
    /**
     * The fallback is tenant-scoped too — `usersInRoles` applies the same ceiling, so this
     * reaches the administrators OF THIS ORGANISATION and nobody else. An unstaffed desk in one
     * organisation must not route that organisation's SLA breaches, declines and correction
     * requests — each naming a branch and a person — to another organisation's administrator,
     * who cannot act on them and should never have seen them. Where a tenant has no
     * administrator either, the event is dropped with the warning below saying so; the audit row
     * this method writes at the end still records that it happened, which is where "nobody told
     * me" is answered from.
     */
    if (namesAnAudience && audienceResolvable && userIds.size === 0) {
      const fallback = await this.usersInRoles(NotificationDispatchService.FALLBACK_ROLES, undefined, tenancy);
      for (const u of fallback) userIds.add(u.id);
      if (fallback.length > 0) {
        this.logger.warn(
          `"${opts.type}" reaches nobody holding ${def.roles.join('/')} — routed to ` +
            `${fallback.length} administrator(s) instead. Staff those roles to route it properly.`,
        );
      } else {
        this.logger.warn(
          `"${opts.type}" reaches nobody holding ${def.roles.join('/')} in organisation ` +
            `${tenancy.organizationId}, and that organisation has no active administrator to fall ` +
            'back to — nothing was sent to a role audience. Staff one of those roles.',
        );
      }
    }

    /**
     * Individually addressed recipients are added AFTER the tenant filter, and are not subject
     * to it.
     *
     * `RECORD_OWNER` and `ASSIGNED_ASSAYER` are not a fan-out: the caller read one specific id
     * off the record itself (`assignment.assayerId`, `thread.reporterUserId`) and named that
     * person. Nothing is being discovered by role, so there is nothing here that can widen to a
     * whole organisation — the leak this change closes is structurally impossible on this path.
     * Filtering them by the event's organisation would also break the platform-scoped feedback
     * types, whose reporter is by design a user of some tenant while the desk is not.
     *
     * The row is still stamped with the EVENT's organisation, which means a caller that ever did
     * name someone from another tenant is caught on the read side instead: their bell filters on
     * their own organisation and will not show it. That is the second line the write scoping
     * alone does not provide.
     */
    if (def.special?.includes('RECORD_OWNER') && opts.ownerUserId) {
      userIds.add(opts.ownerUserId);
    }
    if (def.skipActor && opts.actorUserId) {
      userIds.delete(opts.actorUserId);
    }

    const assayerIds: string[] = [];
    if (def.special?.includes('ASSIGNED_ASSAYER') && opts.assayerId) {
      assayerIds.push(opts.assayerId);
    }

    /**
     * Drop anyone who has muted every channel this type travels on.
     *
     * Preferences were half-enforced: the delivery worker honoured `push`, and nothing anywhere
     * honoured `inApp`. So a user who turned a category off — through a confirmation dialog that
     * promises "you will stop seeing these in your notification bell entirely" — kept receiving
     * every one of them. The setting existed, was saved, and did nothing.
     *
     * Only a recipient with NO channel left is dropped here. In-app off but push on still needs
     * the row, because the row is what the push is sent from; that recipient's bell filtering
     * happens on read (NotificationService.findByUser), which is where "don't show me this"
     * belongs.
     */
    const muted = await this.fullyMutedRecipients(def.category, def.channels, [...userIds], assayerIds);
    for (const id of muted.userIds) userIds.delete(id);
    const audienceAssayerIds = assayerIds.filter((id) => !muted.assayerIds.has(id));

    const title = renderTemplate(def.title, opts.payload);
    const message = renderTemplate(def.body, opts.payload);
    const link = def.link ? renderTemplate(def.link, opts.payload) : null;

    /**
     * A row is only born DELIVERED when in-app is the ONLY channel it has — then the row
     * genuinely is the delivery.
     *
     * When it also carries PUSH, it stays PENDING until the queue has sent that push.
     * Marking it DELIVERED up front (because in-app was instant) collided with the delivery
     * worker's terminal-state guard, which refuses to send for a row already DELIVERED — so
     * every notification carrying BOTH channels was silently never pushed. That is almost
     * every assayer-facing type, i.e. exactly the ones whose whole purpose is to reach a
     * phone that is not currently open. Reads are unaffected: `findByUser` filters on
     * isActive/isRead and never on status.
     */
    const inAppOnly = def.channels.includes(NotificationChannel.IN_APP)
      && !def.channels.includes(NotificationChannel.PUSH);
    const initialStatus = inAppOnly ? NotificationStatus.DELIVERED : NotificationStatus.PENDING;

    const base = {
      type: opts.type,
      // Stamped on every row of the fan-out, recipient by recipient, so the organisation a
      // notification belongs to is a fact on the row rather than something re-derived later from
      // whoever happens to be reading it. Null only for a platform-scoped type.
      organizationId: tenancy.organizationId,
      category: def.category,
      priority: def.priority,
      status: initialStatus,
      channels: def.channels,
      title,
      message,
      link,
      entityType: opts.entityType ?? null,
      entityId: opts.entityId ?? null,
      payload: opts.payload ?? null,
      actorUserId: opts.actorUserId ?? null,
      groupKey,
      // Stamped now only when nothing further has to happen for this to count as delivered;
      // otherwise the delivery worker sets it once the push actually goes out.
      deliveredAt: inAppOnly ? new Date() : null,
      isRead: false,
      attempts: 0,
    };

    /**
     * Email bookkeeping is stamped at birth, and only for internal users — assayers have the
     * app; their channels are in-app and push.
     *
     * Whether a mailer is configured is deliberately NOT decided here. This service runs in
     * whichever replica handled the request; the send happens in whichever replica drains the
     * queue, and those are not the same process. An emitter that stamped SUPPRESSED because
     * its own env lacked the credentials would permanently silence a row a properly configured
     * worker could have delivered. The worker settles SUPPRESSED with the reason when it finds
     * no transport, so "why did no email arrive" is still answerable from the row — just
     * answered by the process that actually knows.
     */
    const emailBirth = def.channels.includes(NotificationChannel.EMAIL)
      ? { emailStatus: NotificationStatus.PENDING }
      : { emailStatus: null };

    const rows: Partial<NotificationEntity>[] = [
      ...[...userIds].map((userId) => ({
        ...base,
        ...emailBirth,
        userId,
        assayerId: null,
        // Dedupe is per recipient: one event reaching five people is five rows,
        // but the same event re-fired reaches each of them only once.
        dedupeKey: dedupeKey ? `${dedupeKey}:u:${userId}` : null,
      })),
      ...audienceAssayerIds.map((assayerId) => ({
        ...base,
        emailStatus: null,
        userId: null,
        assayerId,
        dedupeKey: dedupeKey ? `${dedupeKey}:a:${assayerId}` : null,
      })),
    ];

    if (!rows.length) {
      this.logger.warn(`"${opts.type}" resolved to zero recipients — check the catalog roles.`);
      return { groupKey, created: 0, suppressed: 0, recipients: { userIds: [], assayerIds: [] }, organizationId: tenancy.organizationId };
    }

    /**
     * Merge into a recipient's open notification of this type when one is still inside the
     * collapse window, instead of adding another line saying the same thing.
     *
     * Runs before the insert so a merged event never becomes a row at all — which is what keeps
     * the push count down too, since pushes are enqueued from inserted rows.
     */
    let merged = 0;
    if (def.collapse) {
      const remaining: Partial<NotificationEntity>[] = [];
      for (const row of rows) {
        const mergedInto = await this.mergeIntoOpenBurst(row, def, opts.payload);
        if (mergedInto) merged++;
        else remaining.push(row);
      }
      rows.length = 0;
      rows.push(...remaining);

      if (!rows.length) {
        // Everything merged: a real outcome, not a no-op, so it is reported as such.
        return {
          groupKey,
          created: 0,
          suppressed: merged,
          recipients: { userIds: [...userIds], assayerIds: audienceAssayerIds },
          organizationId: tenancy.organizationId,
        };
      }
    }

    // `orIgnore` lets the partial unique index on `dedupe_key` absorb repeats
    // without the caller having to pre-check or catch a constraint violation.
    await this.notificationRepository
      .createQueryBuilder()
      .insert()
      .into(NotificationEntity)
      .values(rows as any)
      .orIgnore()
      .execute();

    // `groupKey` is generated fresh above on every call, so it belongs only to
    // rows this exact call actually wrote — a skipped duplicate keeps whichever
    // groupKey its original insert had. Reading it back this way, rather than
    // trusting positional alignment with the insert result's `identifiers`
    // array, is what caught this: `orIgnore` silently had nothing to conflict
    // on for a long stretch (see NotificationEntity's class comment) and every
    // duplicate call still reported a plausible-looking `created` count the
    // whole time, because the row count and the reported count were computed
    // from two different things that happened to agree only by coincidence.
    const createdRows = await this.notificationRepository.find({ where: { groupKey } });
    const created = createdRows.length;
    const suppressed = rows.length - created;

    // ── Real-time ─────────────────────────────────────────────────────────
    // A suppressed duplicate must not re-notify anyone live — that's the whole
    // point of dedupe — so this only fires for rows genuinely just inserted.
    for (const row of createdRows) {
      try {
        this.eventPublisher.publish('notification:new', {
          id: row.id,
          userId: row.userId,
          assayerId: row.assayerId,
          title: row.title,
          message: row.message,
          category: row.category,
          priority: row.priority,
          link: row.link,
          isRead: false,
          createdAt: row.createdAt?.toISOString?.() ?? new Date().toISOString(),
        });
      } catch (err: any) {
        this.logger.warn(`Could not publish real-time notification ${row.id}: ${err?.message}`);
      }
    }

    // ── Hand push delivery to the queue ───────────────────────────────────
    // In-app is already done — the row is the delivery. Only push needs a job.
    // Enqueue failure is logged, never thrown: the row still exists and the
    // stranded-row sweeper will pick it up, so Redis being down delays a push
    // rather than losing it.
    if (def.channels.includes(NotificationChannel.PUSH) && createdRows.length > 0) {
      // One bulk enqueue rather than a Redis round-trip per recipient — a fan-out to a whole role
      // (e.g. every operations user on a project event) was N sequential `add()` calls.
      try {
        await this.deliveryQueue.addBulk(
          createdRows.map((row) => ({
            name: 'deliver',
            data: { notificationId: row.id },
            opts: {
              attempts: 5,
              backoff: { type: 'exponential', delay: 5000 },
              removeOnComplete: true,
              // Kept bounded (not `false`) so a failed delivery can still be inspected without
              // holding it in Redis forever — see FAILED_JOB_RETENTION.
              removeOnFail: FAILED_JOB_RETENTION,
            },
          })),
        );
      } catch (err: any) {
        // Never thrown: the rows exist, so the stranded-row sweeper still delivers if Redis is down.
        this.logger.warn(`Could not bulk-enqueue push for ${createdRows.length} notification(s): ${err?.message}`);
      }
    }

    // ── Hand email delivery to the queue ──────────────────────────────────
    // Same contract as push: the row is the source of truth, the queue is a cache of pending
    // work, and the sweeper re-queues anything the enqueue missed.
    const emailRows = createdRows.filter((row) => row.emailStatus === NotificationStatus.PENDING);
    if (emailRows.length > 0) {
      try {
        await this.deliveryQueue.addBulk(
          emailRows.map((row) => ({
            name: 'deliver-email',
            data: { notificationId: row.id },
            opts: {
              attempts: 5,
              backoff: { type: 'exponential', delay: 5000 },
              removeOnComplete: true,
              removeOnFail: FAILED_JOB_RETENTION,
            },
          })),
        );
      } catch (err: any) {
        this.logger.warn(`Could not bulk-enqueue email for ${emailRows.length} notification(s): ${err?.message}`);
      }
    }

    // ── Audit ─────────────────────────────────────────────────────────────
    // A notification that was sent is a fact about the business, not just about
    // the mail system: "nobody told me" is answerable from here.
    try {
      await this.auditService.recordEvent({
        category: EventCategory.SYSTEM,
        eventType: `NOTIFICATION_${opts.type}`,
        entityType: opts.entityType ?? 'NOTIFICATION',
        // `groupKey` used to be the fallback, but it is `type:entityId:timestamp` — never a
        // uuid, so any dispatch without an `entityId` (the field is optional) would have had
        // its audit row rejected. It is recorded in `metadata.groupKey` just below regardless.
        entityId: opts.entityId ?? NOT_A_RECORD_ENTITY_ID,
        userId: opts.actorUserId ?? undefined,
        remarks: `Notified ${created} recipient(s)${suppressed ? `, ${suppressed} suppressed as duplicate` : ''}: ${title}`,
        metadata: {
          groupKey,
          notificationType: opts.type,
          userIds: [...userIds],
          assayerIds,
          channels: def.channels,
          created,
          suppressed,
          // The tenant boundary this fan-out was decided under, and how it was arrived at.
          // Without `tenancySource` an audit reader cannot tell an organisation derived from the
          // event's own record apart from one assumed because the deployment has a single
          // tenant — and those two answers stop agreeing the day a second tenant exists.
          organizationId: tenancy.organizationId,
          notificationScope: tenancy.scope,
          tenancySource: tenancy.source,
        },
      });
    } catch (err: any) {
      // Never let the audit write fail the notification.
      this.logger.warn(`Could not audit notification ${groupKey}: ${err?.message}`);
    }

    return { groupKey, created, suppressed, recipients: { userIds: [...userIds], assayerIds }, organizationId: tenancy.organizationId };
  }

  /**
   * Fire-and-forget wrapper for call sites inside a business transaction.
   *
   * Notification failure must never roll back or block the action that caused
   * it — an assayer's acceptance is still valid if the ops team's alert fails.
   */
  emitSafe(opts: EmitOptions): void {
    this.emit(opts).catch((err) =>
      this.logger.error(`Notification "${opts.type}" failed: ${err?.message}`),
    );
  }
}
