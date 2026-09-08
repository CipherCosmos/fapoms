import React from 'react';
import {
  CheckCircle2,
  Clock,
  AlertTriangle,
  XCircle,
  ShieldCheck,
  ShieldAlert,
  ShieldOff,
  UserX,
  Archive,
  Mail,
  FileCheck,
  BookOpen,
  CalendarOff,
  MinusCircle,
  PauseCircle,
  Inbox,
  Map,
  Users,
  Phone,
  CheckCheck,
  Calendar,
  FileText,
  Lock,
  AlertCircle,
  Ban,
  MapPin,
  PlayCircle,
  History,
  FileEdit,
  KeyRound,
  Check,
} from 'lucide-react';
import {
  getStatusDescriptor,
  getSemanticTokens,
  type StatusDomain,
  type SemanticCategory,
  type StatusIconKey,
} from '../../config/status-registry';

const ICON_COMPONENTS: Record<StatusIconKey, React.ComponentType<{ size?: number; className?: string }>> = {
  'check-circle': CheckCircle2,
  'mail': Mail,
  'file-check': FileCheck,
  'shield-check': ShieldCheck,
  'book-open': BookOpen,
  'calendar-off': CalendarOff,
  'pause-circle': PauseCircle,
  'shield-alert': ShieldAlert,
  'user-x': UserX,
  'x-circle': XCircle,
  'archive': Archive,
  'check': Check,
  'minus-circle': MinusCircle,
  'inbox': Inbox,
  'map': Map,
  'users': Users,
  'phone': Phone,
  'check-check': CheckCheck,
  'calendar': Calendar,
  'file-text': FileText,
  'lock': Lock,
  'alert-circle': AlertCircle,
  'ban': Ban,
  'clock': Clock,
  'map-pin': MapPin,
  'play-circle': PlayCircle,
  'alert-triangle': AlertTriangle,
  'shield-off': ShieldOff,
  'key-round': KeyRound,
  'history': History,
  'file-edit': FileEdit,
};

export interface StatusBadgeProps {
  /** Strongly typed domain descriptor (Recommended). */
  domain?: StatusDomain;
  status?: string | null;
  /** Direct semantic category styling. */
  category?: SemanticCategory;

  /** Explicit color overrides (for backwards compatibility). */
  color?: string;
  bg?: string;
  label?: React.ReactNode;
  icon?: React.ReactNode;
  variant?: 'pill' | 'tag';
  size?: 'sm' | 'md';
  className?: string;
  title?: string;
  border?: boolean;
  style?: React.CSSProperties;
  /**
   * Set to true ONLY if this badge represents an active, changing state that should
   * announce updates to assistive technologies (ARIA live region).
   * Static badges in tables/lists leave this false (default) to prevent announcement floods.
   */
  live?: boolean;
  /** Explicit ARIA role override if needed (e.g. 'status'). */
  role?: string;
}

/**
 * Canonical domain-aware status badge.
 *
 * Supports domain-driven resolution (e.g. `<StatusBadge domain="assayerLifecycle" status={status} />`)
 * with semantic foreground/background tokens and contextual icon so state is NEVER conveyed
 * by color alone. Retains full backwards compatibility for custom caller-supplied colors.
 */
export const StatusBadge: React.FC<StatusBadgeProps> = ({
  domain,
  status,
  category,
  color,
  bg,
  label,
  icon,
  variant = 'pill',
  size = 'sm',
  className,
  title,
  border = false,
  style,
  live = false,
  role,
}) => {
  const isTag = variant === 'tag';
  const isSmall = size === 'sm';
  const iconSize = isSmall ? 11 : 13;

  let resolvedLabel: React.ReactNode = label;
  let resolvedColor = color;
  let resolvedBg = bg;
  let resolvedBorder = border;
  let resolvedIcon = icon;
  let resolvedTitle = title;

  if (domain && status !== undefined) {
    const descriptor = getStatusDescriptor(domain, status);
    resolvedLabel = label ?? descriptor.label;
    resolvedColor = color ?? descriptor.fgToken;
    resolvedBg = bg ?? descriptor.bgToken;
    resolvedTitle = title ?? descriptor.description;
    resolvedBorder = border !== false;

    if (icon !== undefined) {
      resolvedIcon = icon;
    } else if (descriptor.icon) {
      const IconComponent = ICON_COMPONENTS[descriptor.icon];
      resolvedIcon = IconComponent ? <IconComponent size={iconSize} /> : null;
    }
  } else if (category) {
    const tokens = getSemanticTokens(category);
    resolvedColor = color ?? tokens.fgToken;
    resolvedBg = bg ?? tokens.bgToken;
    resolvedBorder = border !== false;
  }

  const roleAttr = role !== undefined ? role : (live ? 'status' : undefined);
  const ariaLiveAttr = live ? ('polite' as const) : undefined;

  return (
    <span
      role={roleAttr}
      aria-live={ariaLiveAttr}
      title={resolvedTitle}
      className={className}
      style={{
        padding: isTag
          ? isSmall
            ? '3px 8px'
            : '5px 12px'
          : isSmall
          ? '4px 10px'
          : '6px 14px',
        borderRadius: isTag ? 'var(--radius-sm, 6px)' : 'var(--radius-full, 9999px)',
        fontSize: isTag ? (isSmall ? '11px' : '12px') : isSmall ? '11.5px' : '12.5px',
        fontWeight: 600,
        lineHeight: 1.2,
        minHeight: isSmall ? '22px' : '28px',
        background: resolvedBg || 'var(--status-inactive-bg)',
        color: resolvedColor || 'var(--status-inactive-fg)',
        border: resolvedBorder
          ? `1px solid ${resolvedColor || 'var(--border-color)'}35`
          : '1px solid rgba(0,0,0,0.06)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '5px',
        whiteSpace: 'nowrap',
        boxShadow: 'var(--shadow-xs, 0 1px 2px rgba(0,0,0,0.04))',
        letterSpacing: '0.01em',
        fontVariantNumeric: 'tabular-nums',
        ...style,
      }}
    >
      {resolvedIcon && (
        <span
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          {resolvedIcon}
        </span>
      )}
      <span>{resolvedLabel}</span>
    </span>
  );
};
