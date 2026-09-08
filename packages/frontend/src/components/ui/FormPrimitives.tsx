import React, { useState } from 'react';
import { CheckCircle2, Clock, XCircle, Lock, ChevronDown, ChevronUp } from 'lucide-react';

export type FieldVerificationState = 'verified' | 'pending' | 'rejected' | 'read-only';

export interface FormFieldProps {
  label: string;
  required?: boolean;
  helpText?: React.ReactNode;
  error?: string | null;
  state?: FieldVerificationState;
  stateLabel?: string;
  style?: React.CSSProperties;
  className?: string;
  children: React.ReactNode;
}

/**
 * FormField — Canonical field wrapper with integrated label, required indicator,
 * domain verification state badge, help text, and accessible error message.
 */
export const FormField: React.FC<FormFieldProps> = ({
  label,
  required,
  helpText,
  error,
  state,
  stateLabel,
  style,
  className,
  children,
}) => {
  return (
    <div
      className={`form-field ${className || ''}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        ...style,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <label
          style={{
            fontSize: 'var(--text-xs, 12px)',
            fontWeight: 600,
            color: 'var(--text-secondary)',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
          }}
        >
          <span>{label}</span>
          {required && (
            <span style={{ color: 'var(--status-danger-fg)', fontWeight: 700 }} title="Required field">
              *
            </span>
          )}
        </label>

        {state && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '3px',
              fontSize: '11px',
              fontWeight: 600,
              padding: '1px 6px',
              borderRadius: 'var(--radius-full)',
              background:
                state === 'verified'
                  ? 'var(--status-active-bg)'
                  : state === 'rejected'
                  ? 'var(--status-danger-bg)'
                  : state === 'pending'
                  ? 'var(--status-pending-bg)'
                  : 'var(--bg-surface-2)',
              color:
                state === 'verified'
                  ? 'var(--status-active-fg)'
                  : state === 'rejected'
                  ? 'var(--status-danger-fg)'
                  : state === 'pending'
                  ? 'var(--status-pending-fg)'
                  : 'var(--text-muted)',
            }}
          >
            {state === 'verified' && <CheckCircle2 size={10} />}
            {state === 'rejected' && <XCircle size={10} />}
            {state === 'pending' && <Clock size={10} />}
            {state === 'read-only' && <Lock size={10} />}
            <span>{stateLabel ?? (state === 'read-only' ? 'Read-only' : state)}</span>
          </span>
        )}
      </div>

      {children}

      {error ? (
        <span
          role="alert"
          style={{
            fontSize: '11.5px',
            color: 'var(--status-danger-fg)',
            fontWeight: 500,
            marginTop: '2px',
          }}
        >
          {error}
        </span>
      ) : helpText ? (
        <span
          style={{
            fontSize: '11.5px',
            color: 'var(--text-muted)',
            marginTop: '2px',
          }}
        >
          {helpText}
        </span>
      ) : null}
    </div>
  );
};

export interface FormSectionProps {
  title: string;
  description?: string;
  badge?: React.ReactNode;
  columns?: 1 | 2 | 3 | 4;
  collapsible?: boolean;
  defaultExpanded?: boolean;
  children: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}

/**
 * FormSection — Structured form section supporting progressive disclosure,
 * responsive grid layouts, and section description notes.
 */
export const FormSection: React.FC<FormSectionProps> = ({
  title,
  description,
  badge,
  columns = 2,
  collapsible = false,
  defaultExpanded = true,
  children,
  style,
  className,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <section
      className={`form-section ${className || ''}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3, 12px)',
        padding: 'var(--space-4, 16px)',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-hair)',
        borderRadius: 'var(--radius-md, 10px)',
        ...style,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          cursor: collapsible ? 'pointer' : 'default',
        }}
        onClick={collapsible ? () => setExpanded((e) => !e) : undefined}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <h3
              style={{
                fontSize: 'var(--text-base, 14px)',
                fontWeight: 700,
                margin: 0,
                color: 'var(--text-primary)',
              }}
            >
              {title}
            </h3>
            {badge}
          </div>
          {description && (
            <p
              style={{
                fontSize: 'var(--text-xs, 12px)',
                color: 'var(--text-muted)',
                margin: '3px 0 0',
                lineHeight: 1.4,
              }}
            >
              {description}
            </p>
          )}
        </div>

        {collapsible && (
          <button
            type="button"
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              padding: '4px',
            }}
          >
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        )}
      </div>

      {(!collapsible || expanded) && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns:
              columns === 1
                ? '1fr'
                : columns === 2
                ? 'repeat(auto-fit, minmax(220px, 1fr))'
                : columns === 3
                ? 'repeat(auto-fit, minmax(180px, 1fr))'
                : 'repeat(auto-fit, minmax(140px, 1fr))',
            gap: 'var(--space-3-5, 14px)',
            marginTop: 'var(--space-1, 4px)',
          }}
        >
          {children}
        </div>
      )}
    </section>
  );
};
