import React from 'react';
import { FeedbackCategory, FeedbackSeverity, FeedbackStatus } from '@fapoms/shared';

import { FEEDBACK_CATEGORY_LABELS, FEEDBACK_STATUS_LABELS } from '@fapoms/shared';
/**
 * Shared vocabulary for the feedback UI: how each category, severity and status
 * reads and colours, plus a couple of small format helpers. Colours are drawn as
 * translucent fills over token backgrounds so they hold in every theme.
 */

// Re-exported (fmtDay under its existing name here) so this module's call sites don't need
// touching — the one definition now lives in utils/dates.ts, same as hr-ui.tsx's fmtDate/fmtWhen.
export { fmtWhen, fmtDate as fmtDay } from '../../utils/dates';

type Chip = { label: string; bg: string; fg: string };

/**
 * Colours are a web concern and live here; the WORDING comes from shared.
 *
 * The words used to live here too, and the mobile app had its own set — the desk said
 * "Acknowledged" and "Enhancement" where the phone said "Seen" and "Idea", about the same thread.
 */
export const CATEGORY: Record<FeedbackCategory, Chip> = {
  [FeedbackCategory.BUG]: { label: FEEDBACK_CATEGORY_LABELS[FeedbackCategory.BUG], bg: 'rgba(239,68,68,0.15)', fg: '#ef4444' },
  [FeedbackCategory.ENHANCEMENT]: { label: FEEDBACK_CATEGORY_LABELS[FeedbackCategory.ENHANCEMENT], bg: 'rgba(59,130,246,0.15)', fg: '#3b82f6' },
  [FeedbackCategory.PROCESS]: { label: FEEDBACK_CATEGORY_LABELS[FeedbackCategory.PROCESS], bg: 'rgba(168,85,247,0.15)', fg: '#a855f7' },
  [FeedbackCategory.QUESTION]: { label: FEEDBACK_CATEGORY_LABELS[FeedbackCategory.QUESTION], bg: 'rgba(20,184,166,0.15)', fg: '#14b8a6' },
  [FeedbackCategory.OTHER]: { label: FEEDBACK_CATEGORY_LABELS[FeedbackCategory.OTHER], bg: 'rgba(148,163,184,0.15)', fg: '#94a3b8' },
};

export const SEVERITY: Record<FeedbackSeverity, Chip> = {
  [FeedbackSeverity.LOW]: { label: 'Low', bg: 'rgba(148,163,184,0.15)', fg: '#94a3b8' },
  [FeedbackSeverity.MEDIUM]: { label: 'Medium', bg: 'rgba(234,179,8,0.15)', fg: '#eab308' },
  [FeedbackSeverity.HIGH]: { label: 'High', bg: 'rgba(249,115,22,0.15)', fg: '#f97316' },
  [FeedbackSeverity.CRITICAL]: { label: 'Critical', bg: 'rgba(239,68,68,0.18)', fg: '#ef4444' },
};

export const STATUS: Record<FeedbackStatus, Chip> = {
  [FeedbackStatus.OPEN]: { label: FEEDBACK_STATUS_LABELS[FeedbackStatus.OPEN], bg: 'rgba(234,179,8,0.15)', fg: '#eab308' },
  [FeedbackStatus.ACKNOWLEDGED]: { label: FEEDBACK_STATUS_LABELS[FeedbackStatus.ACKNOWLEDGED], bg: 'rgba(59,130,246,0.15)', fg: '#3b82f6' },
  [FeedbackStatus.IN_PROGRESS]: { label: FEEDBACK_STATUS_LABELS[FeedbackStatus.IN_PROGRESS], bg: 'rgba(168,85,247,0.15)', fg: '#a855f7' },
  [FeedbackStatus.RESOLVED]: { label: FEEDBACK_STATUS_LABELS[FeedbackStatus.RESOLVED], bg: 'rgba(34,197,94,0.15)', fg: '#22c55e' },
  [FeedbackStatus.CLOSED]: { label: FEEDBACK_STATUS_LABELS[FeedbackStatus.CLOSED], bg: 'rgba(148,163,184,0.15)', fg: '#94a3b8' },
};

export const Badge: React.FC<{ chip: Chip; title?: string }> = ({ chip, title }) => (
  <span
    title={title}
    style={{
      display: 'inline-flex', alignItems: 'center', gap: '4px',
      padding: '2px 8px', borderRadius: '999px', fontSize: '10.5px', fontWeight: 700,
      textTransform: 'uppercase', letterSpacing: '0.03em',
      background: chip.bg, color: chip.fg, whiteSpace: 'nowrap',
    }}
  >
    {chip.label}
  </span>
);

export const card: React.CSSProperties = {
  background: 'var(--bg-surface)',
  border: '1px solid var(--border-color)',
  borderRadius: '12px',
  padding: '16px',
};

export const label: React.CSSProperties = {
  fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.05em', color: 'var(--text-muted)',
};

/** The page/module the reporter was on, in words, for the launcher's "area" field. */
export const areaFromPath = (path: string): string => {
  const seg = path.split('/').filter(Boolean)[0] ?? 'dashboard';
  return seg;
};
