import { pageOf } from './list-paging';

const rows = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe('pageOf', () => {
  it('shows everything, with nothing more to offer, when the list is short', () => {
    expect(pageOf(rows(5), 8, 8)).toEqual({ visible: rows(5), remaining: 0, nextStep: 0 });
    expect(pageOf(rows(8), 8, 8)).toEqual({ visible: rows(8), remaining: 0, nextStep: 0 });
  });

  /** The defect: row 9 onward simply did not exist on screen, with no hint that it was there. */
  it('says how many are hidden instead of silently cutting the list', () => {
    const page = pageOf(rows(20), 8, 8);
    expect(page.visible).toEqual(rows(8));
    expect(page.remaining).toBe(12);
    expect(page.nextStep).toBe(8);
  });

  it('each press reaches further, and the last press shows only what is left', () => {
    expect(pageOf(rows(20), 16, 8)).toMatchObject({ remaining: 4, nextStep: 4 });
    expect(pageOf(rows(20), 24, 8)).toEqual({ visible: rows(20), remaining: 0, nextStep: 0 });
  });

  it('never changes the rows themselves or their order', () => {
    const items = [{ id: 'b' }, { id: 'a' }, { id: 'c' }];
    expect(pageOf(items, 2, 2).visible).toEqual([{ id: 'b' }, { id: 'a' }]);
  });
});
