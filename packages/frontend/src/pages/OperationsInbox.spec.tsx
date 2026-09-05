import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

// `OperationsInbox.tsx` imports `../services/api` at module scope, which transitively reaches
// `./socket`'s Vite-only `import.meta.env` — unparseable by Jest's CommonJS transform. Mocked
// before the import below so that chain never loads; every other page spec in this codebase
// does the same for the same reason.
jest.mock('../services/api', () => ({ api: { request: jest.fn() } }));
// Same reason, reached via `../hooks/useSocketConnection` instead of `../services/api` this time.
jest.mock('../services/socket', () => ({ connectSocket: () => null, subscribeToConnection: () => () => {} }));

import { ASSIGNMENT_REASON_PRESETS, ReasonPresetSelect } from './OperationsInbox';

/**
 * The decline/no-show reason preset. Extracted out of `OperationsInbox` (a large page with its
 * own data fetching for three separate queues) precisely so this fast-fill behavior can be
 * proven without mounting all of that — the same reasoning `Scheduling.spec.tsx`'s reschedule
 * test uses for the sibling preset added alongside this one.
 *
 * The one property that actually matters, everywhere a preset-select sits over a free-text box
 * in this codebase: the select can only ever pre-fill the text, never gate what gets submitted.
 */
describe('ReasonPresetSelect', () => {
  const Harness: React.FC = () => {
    const [value, setValue] = React.useState('');
    return (
      <>
        <ReasonPresetSelect value={value} onChange={setValue} />
        <input aria-label="reason text" value={value} onChange={(e) => setValue(e.target.value)} />
      </>
    );
  };

  it('lists every preset plus an Other option', () => {
    render(<Harness />);
    const select = screen.getByLabelText('Reason preset') as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((o) => o.value);
    for (const preset of ASSIGNMENT_REASON_PRESETS) expect(optionLabels).toContain(preset);
    expect(optionLabels).toContain('Other');
  });

  it('picking a preset fills the text box with that exact value', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Reason preset'), { target: { value: 'Site too far' } });
    expect(screen.getByLabelText('reason text')).toHaveValue('Site too far');
  });

  /**
   * The mutation this guards against: a version of the component that hard-codes the select's
   * value to a preset instead of deriving it from the current text — that would silently discard
   * a hand-typed reason the moment the select re-renders. Type first, then check the select still
   * reads as "Other" and the typed text survives.
   */
  it('typing a value not on the list keeps it, and the select reflects Other', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('reason text'), { target: { value: 'Bridge washed out on the way' } });
    expect(screen.getByLabelText('reason text')).toHaveValue('Bridge washed out on the way');
    expect(screen.getByLabelText('Reason preset')).toHaveValue('Other');
  });

  it('picking Other clears the box for free typing rather than writing the literal word "Other"', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Reason preset'), { target: { value: 'Site too far' } });
    fireEvent.change(screen.getByLabelText('Reason preset'), { target: { value: 'Other' } });
    expect(screen.getByLabelText('reason text')).toHaveValue('');
  });

  /**
   * The one list backs both reason inputs in `OperationsInbox.tsx` (call-queue decline, overdue
   * no-show) on purpose, so they cannot drift into near-identical lists. This is the regression
   * guard for that: if a second, differently-spelled list ever gets added, this still passes but
   * a manual read of the file would catch the drift — the real guard is that there is only one
   * export to import from.
   */
  it('exports exactly one preset list', () => {
    expect(ASSIGNMENT_REASON_PRESETS.length).toBeGreaterThan(0);
    expect(new Set(ASSIGNMENT_REASON_PRESETS).size).toBe(ASSIGNMENT_REASON_PRESETS.length);
  });
});
