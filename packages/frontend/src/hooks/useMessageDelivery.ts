import { useEffect, useRef, useState } from 'react';
import { isSettledMessageStatus, type OutboundMessageReceipt } from '@fapoms/shared';
import { api } from '../services/api';

/**
 * Follows a queued email until the mail server has taken it or it has failed.
 *
 * Emails used to be sent inside the request that asked for them, so a screen knew at once whether
 * one went — at the cost of the person waiting on Gmail for several seconds (4.95 s measured for one
 * interview invite). The server now queues the email and answers straight away with a receipt; this
 * is how the screen still learns the truth without that wait. It asks quickly at first, because a
 * healthy send settles in a second or two, then backs off, and stops after a few minutes — an email
 * the mail server is still retrying is reported as such rather than polled for ever.
 */
export const DELIVERY_POLL_DELAYS_MS = [800, 1200, 2000, 3000, 5000];
export const DELIVERY_POLL_GIVE_UP_MS = 3 * 60_000;

export function useMessageDelivery(receipt: OutboundMessageReceipt | null | undefined): {
  receipt: OutboundMessageReceipt | null;
  /** True once polling stopped without an answer; the email may still go. */
  stillWaiting: boolean;
} {
  const [current, setCurrent] = useState<OutboundMessageReceipt | null>(receipt ?? null);
  const [stillWaiting, setStillWaiting] = useState(false);
  const receiptId = receipt?.id ?? null;
  const initialStatus = receipt?.status;
  const latest = useRef(receipt);
  latest.current = receipt;

  useEffect(() => {
    setCurrent(latest.current ?? null);
    setStillWaiting(false);
    if (!receiptId || isSettledMessageStatus(initialStatus)) return undefined;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    let attempt = 0;

    const tick = async () => {
      if (cancelled) return;
      try {
        const next = await api.request<OutboundMessageReceipt>(`/outbound-messages/${receiptId}`);
        if (cancelled) return;
        setCurrent(next);
        if (isSettledMessageStatus(next.status)) return;
      } catch {
        // A failed poll is not a failed email. Keep asking until the time runs out.
      }
      if (Date.now() - startedAt >= DELIVERY_POLL_GIVE_UP_MS) {
        setStillWaiting(true);
        return;
      }
      const delay = DELIVERY_POLL_DELAYS_MS[Math.min(attempt, DELIVERY_POLL_DELAYS_MS.length - 1)];
      attempt += 1;
      timer = setTimeout(() => void tick(), delay);
    };

    timer = setTimeout(() => void tick(), DELIVERY_POLL_DELAYS_MS[0]);
    attempt = 1;
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [receiptId, initialStatus]);

  return { receipt: current, stillWaiting };
}

/** Counts for a batch of queued emails — a bulk credential run's, say. */
export interface DeliveryBatchTally {
  total: number;
  sent: number;
  failed: number;
  pending: number;
  /** True once polling stopped with some still unsettled. */
  stillWaiting: boolean;
}

const BATCH_CHUNK = 100;

export function useMessageDeliveries(ids: readonly string[]): DeliveryBatchTally {
  const key = ids.join(',');
  const [tally, setTally] = useState<DeliveryBatchTally>({
    total: ids.length, sent: 0, failed: 0, pending: ids.length, stillWaiting: false,
  });

  useEffect(() => {
    const all = key ? key.split(',') : [];
    setTally({ total: all.length, sent: 0, failed: 0, pending: all.length, stillWaiting: false });
    if (all.length === 0) return undefined;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    const settled = new Map<string, OutboundMessageReceipt['status']>();
    let attempt = 0;

    const tick = async () => {
      if (cancelled) return;
      const open = all.filter((id) => !settled.has(id));
      try {
        for (let i = 0; i < open.length; i += BATCH_CHUNK) {
          const chunk = open.slice(i, i + BATCH_CHUNK);
          const receipts = await api.request<OutboundMessageReceipt[]>(`/outbound-messages?ids=${chunk.join(',')}`);
          for (const r of receipts ?? []) {
            if (r.id && isSettledMessageStatus(r.status)) settled.set(r.id, r.status);
          }
        }
      } catch {
        // Same as the single poll: a failed read says nothing about the emails.
      }
      if (cancelled) return;
      const sent = [...settled.values()].filter((s) => s === 'SENT').length;
      const failed = settled.size - sent;
      const pending = all.length - settled.size;
      const timedOut = Date.now() - startedAt >= DELIVERY_POLL_GIVE_UP_MS;
      setTally({ total: all.length, sent, failed, pending, stillWaiting: pending > 0 && timedOut });
      if (pending === 0 || timedOut) return;
      const delay = DELIVERY_POLL_DELAYS_MS[Math.min(attempt, DELIVERY_POLL_DELAYS_MS.length - 1)] * 2;
      attempt += 1;
      timer = setTimeout(() => void tick(), delay);
    };

    timer = setTimeout(() => void tick(), DELIVERY_POLL_DELAYS_MS[1]);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [key]);

  return tally;
}
