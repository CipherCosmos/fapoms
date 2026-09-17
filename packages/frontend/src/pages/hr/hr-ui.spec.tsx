import React from 'react';
import { render, screen } from '@testing-library/react';
import { RowActions } from './hr-ui';

/**
 * The action cell on every table in the HR section. "Add number · Verify · Send back · Scan ·
 * Choose file" on one line that could not break was what pushed the identity table past the
 * onboarding drawer's edge; wrapping is the whole fix, and one change here makes it everywhere.
 */
describe('a row of actions on an HR table', () => {
  it('wraps onto another line rather than widening the row', () => {
    render(<RowActions><button type="button">One</button><button type="button">Two</button></RowActions>);
    const row = screen.getByText('One').parentElement as HTMLElement;
    expect(row.style.display).toBe('flex');
    expect(row.style.flexWrap).toBe('wrap');
  });
});
