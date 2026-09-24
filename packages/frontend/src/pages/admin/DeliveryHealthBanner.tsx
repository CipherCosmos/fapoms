import { AlertTriangle } from 'lucide-react';

/** One channel's last half hour, as `GET /notification-admin/email/status` reports it under `delivery`. */
export interface ChannelHealth {
  channel: 'EMAIL' | 'SMS';
  sent: number;
  failing: number;
  down: boolean;
}

const NOUN: Record<ChannelHealth['channel'], string> = { EMAIL: 'email', SMS: 'text message' };
const WHERE: Record<ChannelHealth['channel'], string> = {
  EMAIL: 'the Email delivery settings (a changed or revoked mailbox password is the usual cause)',
  SMS: 'the SMS gateway settings (a changed key, or the gateway being down)',
};

/**
 * The sentence for each channel on which every send in the last half hour failed, or none.
 * Messages held back by a broken channel are not lost: they are retried and go out once it works.
 */
export function failingChannelSentences(delivery: ChannelHealth[] | null | undefined): string[] {
  return (delivery ?? [])
    .filter((h) => h.down)
    .map((h) =>
      `Every ${NOUN[h.channel]} in the last 30 minutes failed (${h.failing} waiting or failed, none sent). `
      + `Check ${WHERE[h.channel]}. Held messages are retried and will go once it works.`);
}

/** A banner at the top of Platform Settings while a message channel is down. Nothing otherwise. */
export function DeliveryHealthBanner({ delivery }: { delivery: ChannelHealth[] | null | undefined }) {
  const lines = failingChannelSentences(delivery);
  if (!lines.length) return null;
  return (
    <div
      role="alert"
      className="glass-card"
      style={{
        padding: '10px 14px', display: 'flex', gap: '8px', alignItems: 'flex-start',
        fontSize: 'var(--text-xs)', color: 'var(--danger, #c0392b)',
      }}
    >
      <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
      <div>{lines.map((l) => <div key={l}>{l}</div>)}</div>
    </div>
  );
}
