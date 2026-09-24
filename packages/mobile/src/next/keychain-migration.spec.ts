import { moveToNewKeychainClass, type KeychainStore } from './keychain-migration';

function fakeStore(initial: Record<string, string>, failWriteOnce?: string) {
  const items = new Map(Object.entries(initial));
  const log: string[] = [];
  let failed = false;
  const store: KeychainStore = {
    read: async (k) => items.get(k) ?? null,
    remove: async (k) => {
      log.push(`remove ${k}`);
      items.delete(k);
    },
    write: async (k, v) => {
      if (k === failWriteOnce && !failed) {
        failed = true;
        throw new Error('keychain busy');
      }
      log.push(`write ${k}`);
      items.set(k, v);
    },
  };
  return { store, items, log };
}

describe('moveToNewKeychainClass', () => {
  it('deletes then re-adds every stored item (an overwrite would keep the old class)', async () => {
    const { store, items, log } = fakeStore({ token: 't', refresh: 'r' });
    await expect(moveToNewKeychainClass(['token', 'refresh', 'missing'], store)).resolves.toBe(2);
    expect(log).toEqual(['remove token', 'write token', 'remove refresh', 'write refresh']);
    expect(Object.fromEntries(items)).toEqual({ token: 't', refresh: 'r' });
  });

  it('never loses a login when the re-add fails once', async () => {
    const { store, items } = fakeStore({ token: 't' }, 'token');
    await expect(moveToNewKeychainClass(['token'], store)).resolves.toBe(0);
    expect(items.get('token')).toBe('t');
  });

  it('skips an item it cannot read and carries on', async () => {
    const { store, log } = fakeStore({ b: '2' });
    const reading: KeychainStore = { ...store, read: async (k) => (k === 'a' ? Promise.reject(new Error('locked')) : store.read(k)) };
    await expect(moveToNewKeychainClass(['a', 'b'], reading)).resolves.toBe(1);
    expect(log).toEqual(['remove b', 'write b']);
  });
});
