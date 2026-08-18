import React from 'react';

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  render: (row: T) => React.ReactNode;
  sortValue?: (row: T) => string | number;
  align?: 'left' | 'right' | 'center';
  width?: number | string;
}

export const DataTable = <T,>({
  columns,
  rows,
  rowKey,
  onRowClick,
  loading,
  emptyMessage = 'No records found.',
  emptyState,
  sortKey,
  sortOrder,
  onSort,
  selectable,
  selected,
  onToggleSelect,
  onSelectAll,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  emptyMessage?: string;
  emptyState?: React.ReactNode;
  sortKey?: string;
  sortOrder?: 'asc' | 'desc';
  onSort?: (key: string) => void;
  selectable?: boolean;
  selected?: Set<string>;
  onToggleSelect?: (id: string) => void;
  onSelectAll?: (checked: boolean) => void;
}) => {
  const colSpan = columns.length + (selectable ? 1 : 0);
  const allSelected = selectable && rows.length > 0 && rows.every((r) => selected?.has(rowKey(r)));
  return (
    <div className="table-container" style={{ overflow: 'auto' }}>
      <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
        <thead>
          <tr>
            {selectable && (
              <th style={{ width: 32, whiteSpace: 'nowrap' }}>
                <input type="checkbox" checked={allSelected} onChange={(e) => onSelectAll?.(e.target.checked)} style={{ cursor: 'pointer' }} />
              </th>
            )}
            {columns.map((c) => {
              const sortable = !!(c.sortValue && onSort);
              const isSorted = sortable && sortKey === c.key;
              return (
                <th
                  key={c.key}
                  aria-sort={isSorted ? (sortOrder === 'asc' ? 'ascending' : 'descending') : sortable ? 'none' : undefined}
                  style={{ textAlign: c.align ?? 'left', whiteSpace: 'nowrap' }}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => onSort!(c.key)}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', userSelect: 'none', background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'inherit' }}
                    >
                      {c.header}
                      {isSorted && (
                        <span style={{ fontSize: 10, color: 'var(--accent-primary)' }}>
                          {sortOrder === 'asc' ? '▲' : '▼'}
                        </span>
                      )}
                    </button>
                  ) : (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>{c.header}</span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={colSpan} style={{ textAlign: 'center', padding: '28px' }}>
                <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</span>
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={colSpan} style={{ textAlign: 'center', padding: '32px' }}>
                {emptyState ?? <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{emptyMessage}</span>}
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const id = rowKey(row);
              const isSel = selected?.has(id) ?? false;
              return (
                <tr
                  key={id}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  {...(onRowClick ? {
                    role: 'button' as const,
                    tabIndex: 0,
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(row); }
                    },
                  } : {})}
                  style={{ cursor: onRowClick ? 'pointer' : 'default', background: isSel ? 'var(--status-pending-bg)' : undefined }}
                >
                  {selectable && (
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={isSel} onChange={() => onToggleSelect?.(id)} style={{ cursor: 'pointer' }} />
                    </td>
                  )}
                  {columns.map((c) => (
                    <td key={c.key} style={{ textAlign: c.align ?? 'left', whiteSpace: 'nowrap' }}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
};
