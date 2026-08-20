import { listPhase } from './list-phase';

/**
 * The rule this encodes: an empty result and a result that has not arrived must not look the
 * same. Every case below was a real state of the branches table, and two of them were wrong.
 */
describe('listPhase', () => {
  it('draws the shape of the list before the first answer arrives', () => {
    expect(listPhase({ loading: true, rowCount: 0 })).toBe('skeleton');
  });

  it('never tells someone their search matched nothing while it is still fetching', () => {
    // The old page did exactly this, for the length of its own debounce, on first open.
    expect(listPhase({ loading: true, rowCount: 0 })).not.toBe('empty');
  });

  it('keeps the rows already on screen while a narrower set is fetched', () => {
    // Not 'skeleton': throwing away a correct answer to show placeholders is the flicker.
    expect(listPhase({ loading: true, rowCount: 50 })).toBe('refreshing');
  });

  it('says empty only once the answer is in', () => {
    expect(listPhase({ loading: false, rowCount: 0 })).toBe('empty');
  });

  it('is ready when there is something to read', () => {
    expect(listPhase({ loading: false, rowCount: 3 })).toBe('ready');
  });

  it('has a phase for every combination — no state falls through', () => {
    for (const loading of [true, false]) {
      for (const rowCount of [0, 1, 50]) {
        expect(['skeleton', 'refreshing', 'empty', 'ready']).toContain(listPhase({ loading, rowCount }));
      }
    }
  });
});
