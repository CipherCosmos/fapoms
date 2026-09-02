import React from 'react';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from './StatusBadge';

/**
 * The first render test in this package.
 *
 * Its subject matters less than its existence: until now `packages/frontend` could not execute a
 * `.tsx` file in a test at all, so 135 components shipped with no way to assert anything about
 * them. This one exercises the rails end to end — JSX compiled by ts-jest, a DOM from jsdom,
 * queries from testing-library, and `@fapoms/shared` resolved through the moduleNameMapper.
 */
describe('StatusBadge', () => {
  it('renders the label it is given', () => {
    render(<StatusBadge color="#fff" bg="#333" label="Scheduled" />);
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
  });

  it('applies the caller-resolved colours rather than choosing its own', () => {
    render(<StatusBadge color="rgb(255, 255, 255)" bg="rgb(51, 51, 51)" label="Due" />);
    const el = screen.getByText('Due');
    expect(el).toHaveStyle({ color: 'rgb(255, 255, 255)' });
  });

  /**
   * A badge is the app's main carrier of state, and colour alone does not survive a colour-blind
   * user or a monochrome print. The text must always be present.
   */
  it('never conveys state by colour alone — the label is always rendered', () => {
    const { container } = render(<StatusBadge color="#0f0" bg="#020" label="Paid" />);
    expect(container.textContent).toContain('Paid');
  });
});
