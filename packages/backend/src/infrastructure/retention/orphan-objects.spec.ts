import * as fs from 'fs';
import * as path from 'path';
import {
  STORAGE_KEY_SOURCES, NOT_STORAGE_KEYS, referencedKeys, findOrphanObjects,
} from './orphan-objects';

/**
 * A registry of columns is a rule written down as the instances that existed the day it was
 * written — and this codebase has been bitten by that before. The audit's whole safety argument
 * rests on the reference set being COMPLETE: a column that can hold a storage key and is missing
 * from the registry turns live documents into "orphans".
 *
 * So the list is re-derived here from the entity sources on every run. A new `@Column` whose name
 * suggests a file must be classified — either as a place keys live, or explicitly as something
 * else, with the reason — before this passes.
 */
describe('the registry of places a storage key can live', () => {
  const SRC = path.join(__dirname, '../../');

  /** Every `@Column({ name: 'x' })` in the codebase whose name looks like it could hold a file. */
  const suspiciousColumns = (): Array<{ table: string; column: string; file: string }> => {
    const found: Array<{ table: string; column: string; file: string }> = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.entity.ts')) continue;

        const source = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
        const table = source.match(/@Entity\(\s*'([^']+)'/)?.[1];
        if (!table) continue;
        for (const m of source.matchAll(/@Column\(\{[^}]*name:\s*'([^']+)'/g)) {
          const column = m[1];
          if (/file|photo|object|document|attachment|scan|image|upload/i.test(column)) {
            found.push({ table, column, file: entry.name });
          }
        }
      }
    };
    walk(SRC);
    return found;
  };

  it('classifies every column that could hold a file — none left undecided', () => {
    const declared = new Set([
      ...STORAGE_KEY_SOURCES.map((s) => `${s.table}.${s.column}`),
      ...NOT_STORAGE_KEYS.map((s) => `${s.table}.${s.column}`),
    ]);
    const undecided = suspiciousColumns()
      .map((c) => `${c.table}.${c.column}`)
      .filter((key) => !declared.has(key));

    expect(undecided).toEqual([]);
  });

  it('gives a reason for every column it decided is NOT a storage key', () => {
    for (const entry of NOT_STORAGE_KEYS) {
      expect(entry.why.length).toBeGreaterThan(10);
    }
  });

  it('never lists the same column as both a key source and not one', () => {
    const sources = new Set(STORAGE_KEY_SOURCES.map((s) => `${s.table}.${s.column}`));
    for (const entry of NOT_STORAGE_KEYS) {
      expect(sources.has(`${entry.table}.${entry.column}`)).toBe(false);
    }
  });
});

describe('finding what nothing points at', () => {
  const dataSource = { query: jest.fn() } as never;
  const storage = { listObjects: jest.fn() } as never;

  beforeEach(() => {
    jest.clearAllMocks();
    (dataSource as any).query.mockResolvedValue([{ k: 'live/kept.pdf' }]);
  });

  const page = (objects: Array<{ key: string; days: number }>, cursor: string | null = null) => ({
    objects: objects.map((o) => ({
      key: o.key, size: 10,
      lastModified: new Date(Date.now() - o.days * 24 * 60 * 60 * 1000),
    })),
    cursor,
  });

  it('names only the objects no row points at', async () => {
    (storage as any).listObjects.mockResolvedValue(page([
      { key: 'live/kept.pdf', days: 30 },
      { key: 'lost/nobody.pdf', days: 30 },
    ]));

    const report = await findOrphanObjects(dataSource, storage);

    expect(report.orphans.map((o) => o.key)).toEqual(['lost/nobody.pdf']);
    expect(report.scanned).toBe(2);
  });

  /** An upload that wrote its object but not yet its row looks exactly like an orphan. */
  it('will not call a fresh object an orphan', async () => {
    (storage as any).listObjects.mockResolvedValue(page([{ key: 'just/uploaded.pdf', days: 0 }]));

    const report = await findOrphanObjects(dataSource, storage);

    expect(report.orphans).toEqual([]);
    expect(report.tooRecent).toBe(1);
  });

  it('walks every page, not just the first', async () => {
    (storage as any).listObjects
      .mockResolvedValueOnce(page([{ key: 'a/one.pdf', days: 30 }], 'next'))
      .mockResolvedValueOnce(page([{ key: 'b/two.pdf', days: 30 }]));

    const report = await findOrphanObjects(dataSource, storage);

    expect(report.orphans.map((o) => o.key)).toEqual(['a/one.pdf', 'b/two.pdf']);
  });

  /**
   * The dangerous failure: one unreadable table means the reference set is short, and every
   * document it would have vouched for looks like an orphan. Refusing is the only safe answer.
   */
  it('refuses to answer at all when it could not read one of the tables', async () => {
    // Persistent, not `…Once`: the first assertion would otherwise consume the only rejection and
    // the second call would quietly succeed — the exact failure this test exists to rule out.
    (dataSource as any).query.mockRejectedValue(new Error('relation does not exist'));

    await expect(referencedKeys(dataSource)).rejects.toThrow(/reference set is incomplete/);
    await expect(findOrphanObjects(dataSource, storage)).rejects.toThrow(/reference set is incomplete/);
  });

  it('reads a jsonb column of objects by the field that holds the key', async () => {
    const asked: string[] = [];
    (dataSource as any).query.mockImplementation(async (sql: string) => { asked.push(sql); return []; });

    await referencedKeys(dataSource);

    expect(asked.some((sql) => sql.includes("->> 'storageKey'"))).toBe(true);
    expect(asked.some((sql) => sql.includes("->> 's3Key'"))).toBe(true);
    // One bad row must not take out the whole reference set.
    for (const sql of asked.filter((q) => q.includes('jsonb_array_elements'))) {
      expect(sql).toContain("jsonb_typeof");
    }
  });

  it('says so when the driver cannot list at all, rather than reporting no orphans', async () => {
    await expect(findOrphanObjects(dataSource, {} as never)).rejects.toThrow(/cannot enumerate/);
  });
});
