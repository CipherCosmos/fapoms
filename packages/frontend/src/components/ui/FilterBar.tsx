import React from 'react';

/**
 * A consistent container for a page's search + filter controls.
 *
 * Every list page had its filters as a loose row of controls floating on the page background, laid
 * out a little differently each time. Wrapping them in one subtle bar makes "this is where you
 * narrow the list" read as a single unit, aligned the same way on every page. Purely presentational
 * — it changes nothing about the controls it holds.
 */
export const FilterBar: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <div style={{
    display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center',
    padding: '12px 14px', background: 'var(--bg-secondary)',
    border: '1px solid var(--border-hair)', borderRadius: 'var(--radius-md)', ...style,
  }}>
    {children}
  </div>
);

export default FilterBar;
