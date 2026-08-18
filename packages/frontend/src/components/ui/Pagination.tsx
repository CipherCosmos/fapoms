import React from 'react';
import { Select } from './Select';

export const Pagination: React.FC<{
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
}> = ({ page, totalPages, total, pageSize, onPageChange, onPageSizeChange }) => {
  if (total === 0) return null;

  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  const btn: React.CSSProperties = {
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border-color)',
    color: 'var(--text-primary)',
    borderRadius: 'var(--radius-sm)',
    width: 30,
    height: 30,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 13,
  };
  const disabled: React.CSSProperties = { opacity: 0.35, cursor: 'not-allowed' };

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button disabled={page <= 1} style={{ ...btn, ...(page <= 1 ? disabled : {}) }} onClick={() => page > 1 && onPageChange(page - 1)} aria-label="Previous page">
          ‹
        </button>
        <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
          Page <b style={{ color: 'var(--text-primary)' }}>{page}</b> of{' '}
          <b style={{ color: 'var(--text-primary)' }}>{Math.max(1, totalPages)}</b>
        </span>
        <button disabled={page >= totalPages} style={{ ...btn, ...(page >= totalPages ? disabled : {}) }} onClick={() => page < totalPages && onPageChange(page + 1)} aria-label="Next page">
          ›
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
          {from}–{to} of {total}
        </span>
        {onPageSizeChange && (
          <Select
            value={String(pageSize)}
            onChange={(v) => onPageSizeChange(Number(v))}
            options={[10, 25, 50, 100].map((s) => ({ value: String(s), label: `${s} / page` }))}
            compact
          />
        )}
      </div>
    </div>
  );
};
