import React from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';

export interface BreadcrumbItem {
  label: string;
  to?: string;
}

export interface PageHeaderProps {
  /** Main heading text or custom element. */
  title: React.ReactNode;
  /** Optional subtitle or context explanation. */
  subtitle?: React.ReactNode;
  /** Optional icon displayed in a subtle container beside the title. */
  icon?: React.ReactNode;
  /** Optional status badge or pill rendered beside the title. */
  status?: React.ReactNode;
  /** Optional breadcrumb hierarchy. */
  breadcrumbs?: BreadcrumbItem[];
  /** Single prominent primary call-to-action. */
  primaryAction?: React.ReactNode;
  /** Secondary or auxiliary actions. */
  secondaryActions?: React.ReactNode;
  /** Legacy action cluster (retained for backwards compatibility). */
  actions?: React.ReactNode;
  /** Contextual metadata items (e.g. record ID, last updated). */
  metadata?: React.ReactNode;
  /** Optional filter or search row rendered directly within the header block. */
  filters?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

/**
 * Composable, operator-first PageHeader primitive.
 *
 * Supports optional breadcrumbs, contextual status, metadata, primary/secondary action hierarchy,
 * and inline filter rows. Pages only render the elements relevant to their specific workflow.
 */
export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  subtitle,
  icon,
  status,
  breadcrumbs,
  primaryAction,
  secondaryActions,
  actions,
  metadata,
  filters,
  className,
  style,
  children,
}) => {
  const hasActions = Boolean(primaryAction || secondaryActions || actions);

  return (
    <header
      className={`page-header ${className || ''}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3, 12px)',
        marginBottom: 'var(--space-4, 16px)',
        ...style,
      }}
    >
      {/* Breadcrumb row if provided */}
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav
          aria-label="Breadcrumb"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: 'var(--text-xs, 12px)',
            color: 'var(--text-muted)',
          }}
        >
          {breadcrumbs.map((b, i) => {
            const isLast = i === breadcrumbs.length - 1;
            return (
              <React.Fragment key={i}>
                {i > 0 && <ChevronRight size={12} style={{ opacity: 0.6 }} />}
                {b.to && !isLast ? (
                  <Link
                    to={b.to}
                    style={{
                      color: 'var(--text-secondary)',
                      textDecoration: 'none',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
                    onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
                  >
                    {b.label}
                  </Link>
                ) : (
                  <span style={{ color: isLast ? 'var(--text-primary)' : 'inherit', fontWeight: isLast ? 600 : 400 }}>
                    {b.label}
                  </span>
                )}
              </React.Fragment>
            );
          })}
        </nav>
      )}

      {/* Main Title + Actions row */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: 'var(--space-3, 12px)',
        }}
      >
        {/* Title area */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3, 12px)', minWidth: 0 }}>
          {icon && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '38px',
                height: '38px',
                borderRadius: 'var(--radius-md, 10px)',
                color: 'var(--accent-primary)',
                background: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)',
                flexShrink: 0,
              }}
            >
              {icon}
            </span>
          )}
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <h1
                style={{
                  fontSize: 'var(--text-xl, 20px)',
                  fontWeight: 700,
                  margin: 0,
                  fontFamily: 'var(--font-sans)',
                  lineHeight: 1.25,
                  letterSpacing: 'var(--tracking-tight, -0.015em)',
                  color: 'var(--text-primary)',
                }}
              >
                {title}
              </h1>
              {status && <div style={{ flexShrink: 0 }}>{status}</div>}
            </div>

            {subtitle && (
              <p
                style={{
                  color: 'var(--text-secondary)',
                  fontSize: 'var(--text-sm, 13px)',
                  margin: '4px 0 0',
                  lineHeight: 1.45,
                }}
              >
                {subtitle}
              </p>
            )}

            {metadata && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  marginTop: '6px',
                  fontSize: 'var(--text-xs, 12px)',
                  color: 'var(--text-muted)',
                }}
              >
                {metadata}
              </div>
            )}
          </div>
        </div>

        {/* Action cluster: secondary on left, primary prominent on right */}
        {hasActions && (
          <div
            style={{
              display: 'flex',
              gap: 'var(--space-2, 8px)',
              flexWrap: 'wrap',
              alignItems: 'center',
            }}
          >
            {secondaryActions}
            {actions}
            {primaryAction}
          </div>
        )}
      </div>

      {/* Embedded filters row if provided */}
      {filters && (
        <div style={{ marginTop: 'var(--space-1, 4px)' }}>
          {filters}
        </div>
      )}

      {children}
    </header>
  );
};

export default PageHeader;
