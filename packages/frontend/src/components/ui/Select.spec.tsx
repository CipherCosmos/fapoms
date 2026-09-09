import React, { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { Select, optionWindow, SelectOption } from './Select';

/**
 * The menu used to commit every filtered option to the DOM. That was fine for the lists it was
 * written against — a dozen rule types, thirty-six states — and ruinous for the one it grew into:
 * `branch-directory.ts` fetches up to 10,000 branches and the scale database holds 20,097, so
 * "Select a branch…" mounted ten thousand rows in one synchronous commit. These tests hold the
 * line at both ends — the short lists still render whole, the long ones render a slice — and pin
 * the part that is easy to get wrong, which is that keyboard navigation indexes into the *whole*
 * filtered list and so keeps reaching rows the scroll window has not arrived at yet.
 */

const branches = (n: number): SelectOption[] =>
  Array.from({ length: n }, (_, i) => ({ value: `b-${i}`, label: `Branch ${i}` }));

/** The component is controlled; tests want to see what it committed, so hold the value for it. */
const Picker: React.FC<{ options: SelectOption[]; initial?: string; onPick?: (v: string) => void }> = ({
  options,
  initial = '',
  onPick,
}) => {
  const [value, setValue] = useState(initial);
  return (
    <Select
      value={value}
      onChange={(v) => { setValue(v); onPick?.(v); }}
      options={options}
      placeholder="Select a branch…"
      aria-label="Branch"
    />
  );
};

const openMenu = () => fireEvent.click(screen.getByRole('combobox'));
/** The menu only. The trigger repeats the chosen option's label, and would double every match. */
const menu = () => within(screen.getByRole('listbox'));
const search = (text: string) =>
  fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: text } });
const arrowDown = (times: number) => {
  for (let i = 0; i < times; i++) fireEvent.keyDown(screen.getByPlaceholderText('Search…'), { key: 'ArrowDown' });
};

describe('optionWindow — which rows are worth rendering', () => {
  const base = { rowHeight: 34, viewportHeight: 300, scrollTop: 0, highlight: 0, follow: true };

  it('accounts for every row it does not render, so the scrollbar still measures the whole list', () => {
    const { start, end, padTop, padBottom } = optionWindow({ ...base, count: 10_000 });

    expect(padTop + (end - start) * 34 + padBottom).toBe(10_000 * 34);
  });

  it('renders a screenful and its overscan, not the ten thousand rows behind them', () => {
    const { start, end } = optionWindow({ ...base, count: 10_000 });

    expect(start).toBe(0);
    expect(end).toBeLessThan(30);
  });

  it('follows the scrollbar down the list', () => {
    const { start, end } = optionWindow({ ...base, count: 10_000, scrollTop: 34_000, follow: false });

    expect(start).toBeLessThanOrEqual(1000);
    expect(end).toBeGreaterThan(1000);
  });

  /**
   * Wheel-scrolling a directory leaves the highlight wherever the last arrow key put it. Pulling
   * the window back to it would mean the list could not be scrolled by hand at all.
   */
  it('leaves the highlight behind once the pointer is the one scrolling', () => {
    const { start, end } = optionWindow({ ...base, count: 10_000, scrollTop: 34_000, highlight: 0, follow: false });

    expect(start).toBeGreaterThan(900);
    expect(end).toBeGreaterThan(1000);
  });

  /**
   * The one the whole exercise turns on. Arrow keys walk the filtered array, not the rendered
   * slice, so the highlight routinely lands outside the window the scroll position implies — and
   * a row that was never rendered cannot be highlighted, announced, or committed by Enter.
   */
  it('re-anchors on a highlight the scroll position has not reached', () => {
    const { start, end } = optionWindow({ ...base, count: 10_000, scrollTop: 0, highlight: 7_000 });

    expect(start).toBeLessThanOrEqual(7_000);
    expect(end).toBeGreaterThan(7_000);
    expect(end - start).toBeLessThan(30);
  });

  it('moves the highlight only to the nearest edge, the same minimal scroll the menu makes', () => {
    // Row 20 is one past a 300px screenful of 34px rows; the window should end just after it
    // rather than jumping to centre on it and disagreeing with where the scrollbar lands.
    const { end } = optionWindow({ ...base, count: 10_000, highlight: 20 });

    expect(end).toBeLessThan(30);
  });

  it('never runs off either end of the list', () => {
    const { start, end, padTop, padBottom } = optionWindow({ ...base, count: 5, scrollTop: 9_999, highlight: 4 });

    expect(start).toBe(0);
    expect(end).toBe(5);
    expect(padTop).toBe(0);
    expect(padBottom).toBe(0);
  });
});

describe('Select — a menu long enough to hurt', () => {
  it('mounts a slice of a ten-thousand-branch directory rather than all of it', () => {
    render(<Picker options={branches(10_000)} />);

    openMenu();

    expect(screen.getAllByRole('option').length).toBeLessThan(50);
    expect(menu().getByText('Branch 0')).toBeInTheDocument();
    expect(menu().queryByText('Branch 4000')).not.toBeInTheDocument();
  });

  it('leaves the lists that were never the problem exactly as they were', () => {
    render(<Picker options={branches(200)} />);

    openMenu();

    expect(screen.getAllByRole('option')).toHaveLength(200);
    expect(menu().getByText('Branch 199')).toBeInTheDocument();
    // Nothing is standing in for absent rows, so nothing needs to declare the list's real size.
    expect(screen.getAllByRole('option')[0]).not.toHaveAttribute('aria-setsize');
  });

  it('tells assistive tech how long the list really is once it stops rendering all of it', () => {
    render(<Picker options={branches(201)} />);

    openMenu();

    const [first] = screen.getAllByRole('option');
    expect(first).toHaveAttribute('aria-setsize', '201');
    expect(first).toHaveAttribute('aria-posinset', '1');
  });

  it('opens onto the branch already chosen, however deep in the directory it sits', () => {
    render(<Picker options={branches(10_000)} initial="b-7000" />);

    openMenu();

    expect(menu().getByText('Branch 7000')).toBeInTheDocument();
    expect(menu().queryByText('Branch 0')).not.toBeInTheDocument();
  });
});

describe('Select — reaching a row the window has not rendered yet', () => {
  it('walks the arrow keys past the edge of the window and commits what they land on', () => {
    const picked = jest.fn();
    render(<Picker options={branches(1_000)} onPick={picked} />);
    openMenu();
    // Comfortably past the ~15 rows a 300px menu of 34px rows starts out holding.
    expect(menu().queryByText('Branch 40')).not.toBeInTheDocument();

    arrowDown(40);

    expect(menu().getByText('Branch 40')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByPlaceholderText('Search…'), { key: 'Enter' });
    expect(picked).toHaveBeenCalledWith('b-40');
  });

  it('still narrows to a branch that no window would ever have reached', () => {
    const picked = jest.fn();
    render(<Picker options={branches(10_000)} onPick={picked} />);
    openMenu();

    search('Branch 9999');

    fireEvent.click(menu().getByText('Branch 9999'));
    expect(picked).toHaveBeenCalledWith('b-9999');
  });

  it('starts a new search at the top of its results rather than where the last one left off', () => {
    render(<Picker options={branches(10_000)} onPick={jest.fn()} />);
    openMenu();
    arrowDown(40);

    search('Branch 1');

    // 'Branch 1' matches over a thousand branches; the first of them is what Enter should take.
    expect(menu().getByText('Branch 1')).toBeInTheDocument();
  });

  it('says so plainly when nothing matches, instead of a menu of empty spacers', () => {
    render(<Picker options={branches(10_000)} />);
    openMenu();

    search('Nowhere');

    expect(screen.getByText('No matches')).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });
});
