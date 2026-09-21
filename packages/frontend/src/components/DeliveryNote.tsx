import React from 'react';
import type { MessageChannel, OutboundMessageReceipt } from '@fapoms/shared';
import { AlertBanner } from './ui';
import { useMessageDelivery, useMessageDeliveries } from '../hooks/useMessageDelivery';

/** The words that differ between an email and a text; everything else about the line is shared. */
const CHANNEL_WORDS: Record<MessageChannel, {
  noun: string; sentVerb: string; server: string; destination: string; setting: string;
}> = {
  EMAIL: { noun: 'email', sentVerb: 'emailed', server: 'mail server', destination: 'email address', setting: 'email delivery' },
  SMS: { noun: 'text', sentVerb: 'texted', server: 'SMS gateway', destination: 'mobile number', setting: 'SMS delivery' },
};

/**
 * One line that says what happened to an email or a text, and keeps saying it truthfully as it changes.
 *
 * Replaces the per-screen `emailed ? 'sent' : 'did not go'` banners. Those could only be right
 * because the send used to happen inside the request, which is what made recording an interview or
 * inviting a colleague take several seconds. Now the screen gets a receipt at once and this line
 * moves from "Sending…" to "Emailed" or to "did not go — use the link", on its own.
 *
 * `lead` is the part that is already true whatever the email does ("Ramesh passed."); `what` names
 * the thing being emailed ("their form", "a link to set their password").
 */
export const DeliveryNote: React.FC<{
  receipt: OutboundMessageReceipt | null | undefined;
  lead?: string;
  what: string;
  /** Said instead when there was no address to send to. */
  noAddress?: string;
  /** Said after a failure: what to do instead. */
  fallback?: string;
  onClose?: () => void;
  /** Shown in every state — e.g. a link the desk may always want to hand over. */
  children?: React.ReactNode;
  /**
   * Shown only while the email has NOT been delivered and may never be: no address, failed, not
   * queued, or the mail server never confirmed it. For something that should not be on screen once
   * the email went — a working password-setup link, say.
   */
  whenUndelivered?: React.ReactNode;
  /**
   * Which channel, when there is no receipt to say so (nothing was sent because there was nowhere to
   * send it). A receipt's own `channel` wins.
   */
  channel?: MessageChannel;
}> = ({ receipt, lead, what, noAddress, fallback = 'Send them the link below instead.', onClose, children, whenUndelivered, channel }) => {
  const { receipt: current, stillWaiting } = useMessageDelivery(receipt);
  const prefix = lead ? `${lead} ` : '';
  const words = CHANNEL_WORDS[current?.channel ?? channel ?? 'EMAIL'];

  if (!current) {
    return (
      <AlertBanner type="error" onClose={onClose}>
        <span data-testid="email-delivery" data-status="NO_ADDRESS">
          {prefix}{noAddress ?? `There is no ${words.destination} to send ${what} to. ${fallback}`}
        </span>
        {children}
        {whenUndelivered}
      </AlertBanner>
    );
  }

  if (current.status === 'SENT') {
    return (
      <AlertBanner type="success" onClose={onClose}>
        <span data-testid="email-delivery" data-status="SENT">{prefix}{capitalise(what)} was {words.sentVerb} to {current.to}.</span>
        {children}
      </AlertBanner>
    );
  }

  if (current.status === 'FAILED' || current.status === 'NOT_QUEUED') {
    return (
      <AlertBanner type="error" onClose={onClose}>
        <span data-testid="email-delivery" data-status={current.status}>
          {prefix}The {words.noun} with {what} to {current.to} did not go
          {current.error ? ` — ${current.error.replace(/\.$/, '')}` : ''}. {fallback}
        </span>
        {children}
        {whenUndelivered}
      </AlertBanner>
    );
  }

  // QUEUED or SENDING: neither a success nor a problem yet, so neither banner colour.
  return (
    <div
      role="status"
      style={{
        display: 'flex', flexDirection: 'column', gap: '6px', padding: '8px 16px',
        fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', background: 'var(--bg-secondary)',
        border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)',
      }}
    >
      <span data-testid="email-delivery" data-status={current.status}>
        {prefix}
        {stillWaiting
          ? `The ${words.server} has not confirmed ${what} to ${current.to} yet. It may still arrive — ${fallback.charAt(0).toLowerCase()}${fallback.slice(1)}`
          : `Sending ${what} to ${current.to}…`}
      </span>
      {children}
      {stillWaiting && whenUndelivered}
    </div>
  );
};

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The same honesty for a batch: how many of a bulk run's queued emails have gone, failed, or are
 * still on their way. Renders nothing for an empty batch.
 */
export const DeliveryBatchNote: React.FC<{ ids: readonly string[]; what: string; channel?: MessageChannel }> = ({ ids, what, channel = 'EMAIL' }) => {
  const tally = useMessageDeliveries(ids);
  if (tally.total === 0) return null;
  const words = CHANNEL_WORDS[channel];

  const parts = [`${tally.sent} of ${tally.total} ${what} ${words.sentVerb}`];
  if (tally.failed) parts.push(`${tally.failed} did not go`);
  if (tally.pending) parts.push(tally.stillWaiting ? `${tally.pending} not confirmed yet` : `${tally.pending} still sending…`);

  return (
    <div
      role="status"
      data-testid="email-batch"
      style={{
        padding: '6px 16px', fontSize: 'var(--text-xs)', borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--border-color)', background: 'var(--bg-secondary)',
        color: tally.failed ? 'var(--danger)' : 'var(--text-secondary)',
      }}
    >
      {parts.join(' · ')}
      {tally.failed > 0 && ` — check ${words.setting} in Platform Settings, and reach those people another way.`}
    </div>
  );
};
