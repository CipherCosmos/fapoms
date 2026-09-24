/**
 * The cache file is one JSON document holding several unrelated keys, rewritten whole on every
 * write. These pin the ordering that keeps concurrent writes — and sign-out's delete — from
 * undoing each other.
 */
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('expo-secure-store', () => ({}));

const disk: { file: string | null } = { file: null };
const tick = () => new Promise((r) => setTimeout(r, 0));

jest.mock('expo-file-system', () => ({
  documentDirectory: 'file:///doc/',
  // Every call yields first, so an unserialised read-modify-write interleaves with the next one.
  getInfoAsync: jest.fn(async () => { await tick(); return { exists: disk.file !== null }; }),
  readAsStringAsync: jest.fn(async () => { await tick(); return disk.file ?? ''; }),
  writeAsStringAsync: jest.fn(async (_p: string, body: string) => { await tick(); disk.file = body; }),
  deleteAsync: jest.fn(async () => { await tick(); disk.file = null; }),
}));

import { clearCache, readCache, writeCache } from './token-store';

beforeEach(() => {
  disk.file = null;
});

describe('cache writes happen one at a time', () => {
  it('two writes in flight together both land', async () => {
    await Promise.all([writeCache('a', 1), writeCache('b', 2)]);
    expect(JSON.parse(disk.file as string)).toEqual({ a: 1, b: 2 });
  });

  /**
   * Sign-out deletes the file while the queues write their empty lists. A write that had read the
   * file before the delete used to put all of it back — the previous person's schedule included.
   */
  it("a delete is not undone by a write that was already under way", async () => {
    await writeCache('assignments', ['someone-elses-schedule']);
    await Promise.all([clearCache(), writeCache('action_queue', [])]);
    expect(JSON.parse(disk.file as string)).toEqual({ action_queue: [] });
    expect(await readCache('assignments')).toBeNull();
  });

  it('a read waits for the write before it', async () => {
    const write = writeCache('owner', 'A');
    const read = readCache('owner');
    await write;
    expect(await read).toBe('A');
  });

  /**
   * A schedule read in flight at sign-out: its write is queued, then sign-out runs. The write must
   * not land afterwards — the guard is asked when the write runs, not when it was requested.
   */
  it('a guarded write whose session ended while it waited does not land', async () => {
    let live = true;
    const pending = writeCache('assignments', ['person-a'], () => live);
    live = false; // signed out before the write got its turn
    await pending;
    expect(disk.file).toBeNull();
    await writeCache('assignments', ['person-b'], () => true);
    expect(JSON.parse(disk.file as string)).toEqual({ assignments: ['person-b'] });
  });
});
