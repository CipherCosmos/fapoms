import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PushNotificationService } from './push-notification.service';

/**
 * THE SILENT "YOUR JOBS CHANGED" PUSH.
 *
 * Owner decision 2026-09-24: every change to an assayer's job — offered, accepted or declined by
 * the desk, rescheduled, edited, reopened, cancelled, reassigned, escalated — also sends the
 * assayer's phone a data-only message, so the field app refreshes that job in the background
 * instead of showing yesterday's state until somebody pulls to refresh. It is sent in addition to
 * any visible notification, never instead of one, and shows nothing itself:
 *
 *   { type: 'refresh', scope: 'assignments', assignmentId? }
 *
 * Coalesced per assayer. One save routinely touches a job through several paths (an acceptance
 * that also books the schedule; a bulk assign offering forty branches), so the first change opens
 * a short window and everything for that assayer inside it goes out as ONE message: naming the job
 * when exactly one changed, and naming none ("refresh the list") when several did. The window is
 * not extended by later changes, so a steady trickle still reaches the phone within it.
 *
 * In memory, per process, on purpose: a lost refresh (a restart inside the window) costs one stale
 * screen until the next change or pull-to-refresh, and the visible notification — which is durable
 * — is unaffected. Never throws; a refresh that cannot be sent is logged and dropped.
 */
export const REFRESH_COALESCE_MS = 2_000;

@Injectable()
export class AssignmentRefreshPushService implements OnModuleDestroy {
  private readonly logger = new Logger(AssignmentRefreshPushService.name);
  private readonly pending = new Map<string, { assignmentIds: Set<string>; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly push: PushNotificationService) {}

  /**
   * Note that an assayer's job changed. Cheap and synchronous for the caller; the send happens
   * after the coalescing window. A missing assayer id is ignored (an unassigned job has no phone).
   */
  assignmentChanged(assayerId: string | null | undefined, assignmentId?: string | null): void {
    if (!assayerId) return;
    const open = this.pending.get(assayerId);
    if (open) {
      if (assignmentId) open.assignmentIds.add(assignmentId);
      return;
    }
    const entry = {
      assignmentIds: new Set<string>(assignmentId ? [assignmentId] : []),
      timer: setTimeout(() => void this.flush(assayerId), REFRESH_COALESCE_MS),
    };
    // Never hold the process open for a refresh.
    (entry.timer as any)?.unref?.();
    this.pending.set(assayerId, entry);
  }

  /** Send what has gathered for one assayer. Public for tests and shutdown. */
  async flush(assayerId: string): Promise<void> {
    const entry = this.pending.get(assayerId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(assayerId);
    const data: Record<string, string> = { type: 'refresh', scope: 'assignments' };
    if (entry.assignmentIds.size === 1) data.assignmentId = [...entry.assignmentIds][0];
    try {
      await this.push.sendDataToUser(assayerId, data);
    } catch (err: any) {
      this.logger.warn(`Refresh push to assayer ${assayerId} was not sent: ${err?.message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.pending.keys()].map((id) => this.flush(id)));
  }
}
