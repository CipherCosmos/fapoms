import React from 'react';
import { SkeletonRows } from './Loading';

/**
 * THE table. There is one.
 *
 * There were three. This component, a positional `Table` in `pages/hr/hr-ui.tsx` taking
 * `head: string[]` and `rows: ReactNode[][]`, and hand-written `<table>` markup in the roster and
 * on the pay page. Between them they disagreed about cell padding, header case, what an empty list
 * looks like, and whether a sortable header is a button — so the same kind of list read as a
 * different product depending on which HR screen you were on.
 *
 * The positional one was not merely a duplicate, it was the worse shape. Its callers wrote
 * `head={canManage ? ['Client', 'Standing', ''] : ['Client', 'Standing']}` and then pushed a
 * matching cell onto an array by hand further down the function: the header and the cell that
 * belongs under it were twenty lines apart with nothing but care holding them in the same order.
 * A column here is one object carrying both, so a conditional column is one `.filter()` and
 * cannot half-happen.
 *
 * `density` exists because the two families of screen genuinely differ and neither was wrong.
 * Clients and Expenses are comfortable full-page tables; the HR panels put five tables in one
 * scroll and were designed dense. One component, two densities, is one implementation — two
 * components with two densities is what this replaced.
 */

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  render: (row: T) => React.ReactNode;
  /**
   * Turn this column's header into a sort button.
   *
   * DATATABLE DOES NOT SORT. It reports the click through `onSort` and draws the arrow from
   * `sortKey`/`sortOrder`; the ordering is the caller's, because the caller is usually asking the
   * server for it.
   */
  sortable?: boolean;
  /**
   * The older way of saying `sortable: true`, still honoured for the three pages that predate the
   * flag. It was never called — its presence was the flag — which reads as though the table sorts
   * by it and is why the flag exists. Do not add new uses.
   */
  sortValue?: (row: T) => string | number;
  align?: 'left' | 'right' | 'center';
  width?: number | string;
  /**
   * Let this column's cells wrap onto more than one line.
   *
   * Off by default, because a table whose rows are different heights is much harder to read
   * across. On for the columns that hold a sentence rather than a value — a background check's
   * findings, the reason a client rejected somebody — which otherwise force the whole table into
   * horizontal scroll to accommodate one long cell.
   */
  wrap?: boolean;
}

const DENSITY = {
  comfortable: { cellPad: undefined, headPad: undefined, fontSize: undefined },
  compact: { cellPad: '9px 10px', headPad: '8px 10px', fontSize: '12.5px' },
} as const;

export const DataTable = <T,>({
  columns,
  rows,
  rowKey,
  onRowClick,
  loading,
  loadingRows,
  emptyMessage = 'Nothing to show here yet.',
  emptyState,
  sortKey,
  sortOrder,
  onSort,
  selectable,
  selected,
  onToggleSelect,
  onSelectAll,
  density = 'comfortable',
  minWidth = 640,
  rowStyle,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  /**
   * Draw this many placeholder rows while loading, instead of the word "Loading…".
   *
   * A one-line string where a table is about to be holds none of the page's shape, so arriving at
   * a list went blank → one line → two hundred rows, and everything below it jumped as they
   * landed. Opt-in rather than the default only because the three pages that predate it were
   * written against the string and should not change under them silently.
   */
  loadingRows?: number;
  emptyMessage?: string;
  emptyState?: React.ReactNode;
  sortKey?: string;
  sortOrder?: 'asc' | 'desc';
  onSort?: (key: string) => void;
  selectable?: boolean;
  selected?: Set<string>;
  onToggleSelect?: (id: string) => void;
  onSelectAll?: (checked: boolean) => void;
  /** `compact` is the HR panels' density: 12.5px cells in tables that sit several to a screen. */
  density?: 'comfortable' | 'compact';
  /**
   * The width below which the table scrolls sideways rather than squashing. `false` for a small
   * table inside a card, where 640px of enforced width produces a scrollbar under four columns
   * that would have fitted.
   */
  minWidth?: number | false;
  /** Per-row styling the caller owns — the roster tints a selected row with its own accent. */
  rowStyle?: (row: T) => React.CSSProperties | undefined;
}) => {
  const colSpan = columns.length + (selectable ? 1 : 0);
  const allSelected = selectable && rows.length > 0 && rows.every((r) => selected?.has(rowKey(r)));
  const d = DENSITY[density];
  return (
    <div className="table-container" style={{ overflow: 'auto' }}>
      <table
        className="data-table"
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          ...(minWidth === false ? {} : { minWidth }),
        }}
      >
        <thead>
          <tr>
            {selectable && (
              <th style={{ width: 32, whiteSpace: 'nowrap', padding: d.headPad }}>
                {/* Says what it does. This box ticks the rows of the LOADED PAGE, not everything
                    matching the current filter — the rest of the result set was never fetched, so
                    it could not tick it even if it wanted to. It was previously an unlabelled
                    checkbox, which read as "select everything" and quietly meant something else. */}
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) => onSelectAll?.(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                  title={allSelected ? `Clear the ${rows.length} on this page` : `Select all ${rows.length} on this page`}
                  aria-label={allSelected ? `Clear the ${rows.length} selected rows on this page` : `Select all ${rows.length} rows on this page`}
                />
              </th>
            )}
            {columns.map((c) => {
              const sortable = !!((c.sortable ?? !!c.sortValue) && onSort);
              const isSorted = sortable && sortKey === c.key;
              return (
                <th
                  key={c.key}
                  aria-sort={isSorted ? (sortOrder === 'asc' ? 'ascending' : 'descending') : sortable ? 'none' : undefined}
                  style={{ textAlign: c.align ?? 'left', whiteSpace: 'nowrap', padding: d.headPad, width: c.width }}
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
            loadingRows ? (
              <SkeletonRows rows={loadingRows} columns={colSpan} />
            ) : (
              <tr>
                <td colSpan={colSpan} style={{ textAlign: 'center', padding: '28px' }}>
                  <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</span>
                </td>
              </tr>
            )
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
                  style={{
                    cursor: onRowClick ? 'pointer' : 'default',
                    background: isSel ? 'var(--status-pending-bg)' : undefined,
                    ...rowStyle?.(row),
                  }}
                >
                  {selectable && (
                    <td onClick={(e) => e.stopPropagation()} style={{ padding: d.cellPad }}>
                      <input type="checkbox" checked={isSel} onChange={() => onToggleSelect?.(id)} style={{ cursor: 'pointer' }} />
                    </td>
                  )}
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      style={{
                        textAlign: c.align ?? 'left',
                        whiteSpace: c.wrap ? 'normal' : 'nowrap',
                        padding: d.cellPad,
                        // On the td, not the table: `.data-table td` in index.css sets 14px and
                        // beats anything inherited from an ancestor.
                        fontSize: d.fontSize,
                      }}
                    >
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
