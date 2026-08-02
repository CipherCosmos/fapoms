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
}) => {
  return (
    <div className="table-container" style={{ overflow: 'auto' }}>
      <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                onClick={c.sortValue && onSort ? () => onSort(c.key) : undefined}
                style={{
                  textAlign: c.align ?? 'left',
                  cursor: c.sortValue && onSort ? 'pointer' : 'default',
                  userSelect: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {c.header}
                  {c.sortValue && onSort && sortKey === c.key && (
                    <span style={{ fontSize: 10, color: 'var(--accent-primary)' }}>
                      {sortOrder === 'asc' ? '▲' : '▼'}
                    </span>
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={columns.length} style={{ textAlign: 'center', padding: '28px' }}>
                <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</span>
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} style={{ textAlign: 'center', padding: '32px' }}>
                {emptyState ?? <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{emptyMessage}</span>}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                style={{ cursor: onRowClick ? 'pointer' : 'default' }}
              >
                {columns.map((c) => (
                  <td key={c.key} style={{ textAlign: c.align ?? 'left', whiteSpace: 'nowrap' }}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
};
