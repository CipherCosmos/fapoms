import React from 'react';
import { AlertTriangle, Ban } from 'lucide-react';
import type { PayoutDestinationCheck } from '@fapoms/shared';

/**
 * What the person approving, finally approving or paying must know about where the money goes
 * (2026-09-24 audit F2/F3), in the server's own sentences:
 *
 *  - on another assayer's record — the approval WILL be refused (danger tone);
 *  - not verified by a passbook or an identity document — allowed, but said;
 *  - changed since the payout was approved — it is still paid to the frozen account.
 *
 * Grouped by sentence so twelve payouts to one unverified account read as one line naming twelve
 * payouts, not twelve identical lines. Renders nothing when there is nothing to say.
 */
export const DestinationWarnings: React.FC<{
  checks: PayoutDestinationCheck[] | undefined;
  /** Plain sentences from elsewhere (the HOD queue carries them on the item). */
  warnings?: string[];
  compact?: boolean;
}> = ({ checks, warnings, compact }) => {
  const groups = new Map<string, { blocking: boolean; who: string[] }>();
  // Advisory, so a malformed answer (an older server, an error body) shows nothing rather than
  // taking the approve or pay dialog down with it.
  for (const c of Array.isArray(checks) ? checks : []) {
    for (const w of Array.isArray(c?.warnings) ? c.warnings : []) {
      const g = groups.get(w) ?? { blocking: false, who: [] };
      g.blocking = g.blocking || (c.blocking !== null && w === c.blocking);
      const label = c.assayerName ? `${c.payableNumber} (${c.assayerName})` : c.payableNumber;
      if (!g.who.includes(label)) g.who.push(label);
      groups.set(w, g);
    }
  }
  for (const w of warnings ?? []) if (!groups.has(w)) groups.set(w, { blocking: /another assayer's record/i.test(w), who: [] });
  if (!groups.size) return null;
  return (
    <div role="alert" data-testid="destination-warnings" style={{ display: 'flex', flexDirection: 'column', gap: compact ? 3 : 6 }}>
      {[...groups.entries()].map(([sentence, g]) => (
        <div key={sentence} style={{
          display: 'flex', gap: 6, alignItems: 'flex-start',
          fontSize: compact ? 'var(--text-3xs, var(--text-2xs))' : 'var(--text-xs)',
          color: g.blocking ? 'var(--danger)' : 'var(--warning)',
          padding: compact ? 0 : '6px 10px',
          border: compact ? 'none' : `1px solid ${g.blocking ? 'var(--danger)' : 'var(--warning)'}`,
          borderRadius: 'var(--radius-sm)',
        }}>
          {g.blocking ? <Ban size={compact ? 11 : 13} style={{ flexShrink: 0, marginTop: 1 }} /> : <AlertTriangle size={compact ? 11 : 13} style={{ flexShrink: 0, marginTop: 1 }} />}
          <span>
            {sentence}
            {g.who.length > 0 && <span style={{ color: 'var(--text-muted)' }}> — {g.who.slice(0, 6).join(', ')}{g.who.length > 6 ? ` and ${g.who.length - 6} more` : ''}</span>}
          </span>
        </div>
      ))}
    </div>
  );
};
