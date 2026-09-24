import type { MessageChannel } from '@fapoms/shared';

/**
 * Is a message channel working? Read from the `outbound_messages` ledger, so every process — the
 * worker that sends, the API that answers `/health/ready` and the settings screen — gets the same
 * answer without sharing memory.
 *
 * A channel is DOWN when, in the last half hour, something failed and nothing was sent. "Failed"
 * counts a message settled FAILED and one waiting on a retry after an error (QUEUED with a
 * `last_error`), but not a message refused because the channel is switched off on purpose ("not set
 * up") — an administrator who turned SMS off is not having an outage.
 */
export const CHANNEL_HEALTH_WINDOW_MS = 30 * 60_000;

/** The ledger wordings of "this channel is switched off" — deliberately not a failure. */
export const NOT_SET_UP_REASONS = [
  'Email is not set up on this system, so it was not sent.',
  'SMS is not set up on this system, so no text was sent.',
];

export const MESSAGE_CHANNELS: MessageChannel[] = ['EMAIL', 'SMS'];

export interface ChannelHealth {
  channel: MessageChannel;
  /** Sent in the window. */
  sent: number;
  /** Failed, or waiting on a retry after an error, in the window. */
  failing: number;
  /** Failures and not one success: every send is failing. */
  down: boolean;
}

export type RawQuery = (sql: string, params: unknown[]) => Promise<any[]>;

export async function readChannelHealth(query: RawQuery, now = Date.now()): Promise<ChannelHealth[]> {
  const since = new Date(now - CHANNEL_HEALTH_WINDOW_MS);
  const rows: Array<{ channel: MessageChannel; sent: string | number; failing: string | number }> = await query(
    `SELECT "channel",
            COUNT(*) FILTER (WHERE "status" = 'SENT' AND "sent_at" >= $1) AS "sent",
            COUNT(*) FILTER (
              WHERE ("status" = 'FAILED' AND "failed_at" >= $1 AND NOT ("last_error" = ANY($2)))
                 OR ("status" IN ('QUEUED', 'SENDING') AND "last_error" IS NOT NULL AND "updated_at" >= $1)
            ) AS "failing"
       FROM "outbound_messages"
      WHERE "updated_at" >= $1 OR "sent_at" >= $1 OR "failed_at" >= $1
      GROUP BY "channel"`,
    [since, NOT_SET_UP_REASONS],
  );
  return MESSAGE_CHANNELS.map((channel) => {
    const row = rows.find((r) => r.channel === channel);
    const sent = Number(row?.sent ?? 0);
    const failing = Number(row?.failing ?? 0);
    return { channel, sent, failing, down: failing > 0 && sent === 0 };
  });
}

/** `degraded` when any channel is down — what `/health/ready` reports under `messaging`. */
export function messagingStatus(health: ChannelHealth[]): 'ok' | 'degraded' {
  return health.some((h) => h.down) ? 'degraded' : 'ok';
}
