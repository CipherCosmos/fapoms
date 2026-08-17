/**
 * Guards the geocoding caches' write behaviour.
 *
 * The bug being fixed was not subtle: `india-geocoder.ts` and `india-autocomplete.helper.ts` each
 * called `fs.writeFileSync(<the entire cache file>)` on every cache miss. That blocks the event
 * loop for the whole write, once per geocode during an import and once per *keystroke* in the
 * place-lookup type-ahead, and the cost grows with the cache because the file is rewritten whole.
 *
 * "It is debounced now" is exactly the kind of claim that quietly stops being true — someone adds
 * a `flush()` inside `set()` to fix a lost-write report and the regression is invisible until an
 * import is slow again. So the debounce is asserted by counting writes, not by inspecting the
 * timer.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { JsonFileCache, resolveGeoCacheDir } from './geo-cache-store';

describe('JsonFileCache', () => {
  let dir: string;
  const originalDir = process.env.GEO_CACHE_DIR;
  const originalWrites = process.env.GEO_CACHE_ALLOW_WRITES_IN_TESTS;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fapoms-geo-cache-'));
    process.env.GEO_CACHE_DIR = dir;
    // The write path is what is under test, so it is opted into explicitly — and pointed at a
    // temporary directory, never at the repository.
    process.env.GEO_CACHE_ALLOW_WRITES_IN_TESTS = 'true';
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (originalDir === undefined) delete process.env.GEO_CACHE_DIR;
    else process.env.GEO_CACHE_DIR = originalDir;
    if (originalWrites === undefined) delete process.env.GEO_CACHE_ALLOW_WRITES_IN_TESTS;
    else process.env.GEO_CACHE_ALLOW_WRITES_IN_TESTS = originalWrites;
    jest.useRealTimers();
  });

  describe('writing', () => {
    /**
     * The regression that mattered. 500 geocoded rows used to mean 500 full-file rewrites on the
     * event loop; they must now cost one.
     */
    it('does not touch the disk once per entry', () => {
      jest.useFakeTimers();
      const cache = new JsonFileCache<{ lat: number }>('debounce.json');

      for (let i = 0; i < 500; i++) cache.set(`key-${i}`, { lat: i });

      // Nothing written yet — the whole point.
      expect(fs.existsSync(path.join(dir, 'debounce.json'))).toBe(false);

      jest.advanceTimersByTime(2000);

      const written = JSON.parse(fs.readFileSync(path.join(dir, 'debounce.json'), 'utf8'));
      expect(Object.keys(written)).toHaveLength(500);
      expect(written['key-499']).toEqual({ lat: 499 });
    });

    it('serves an entry from memory before it has been flushed', () => {
      jest.useFakeTimers();
      const cache = new JsonFileCache<{ lat: number }>('memory.json');

      cache.set('pune', { lat: 18.5 });

      // A cache that only answered from disk would re-geocode everything until the flush landed.
      expect(cache.get('pune')).toEqual({ lat: 18.5 });
      expect(cache.has('pune')).toBe(true);
    });

    it('writes immediately when explicitly flushed', () => {
      const cache = new JsonFileCache<{ lat: number }>('explicit.json');

      cache.set('pune', { lat: 18.5 });
      cache.flush();

      expect(JSON.parse(fs.readFileSync(path.join(dir, 'explicit.json'), 'utf8'))).toEqual({ pune: { lat: 18.5 } });
    });

    it('does not rewrite the file when nothing changed', () => {
      const file = path.join(dir, 'idempotent.json');
      const cache = new JsonFileCache<{ lat: number }>('idempotent.json');
      cache.set('pune', { lat: 18.5 });
      cache.flush();
      const firstWrite = fs.statSync(file).mtimeMs;

      cache.flush();
      cache.flush();

      expect(fs.statSync(file).mtimeMs).toBe(firstWrite);
    });

    /**
     * Written to a temporary file and renamed. A process killed mid-write must leave the previous
     * good cache in place rather than a truncated file the next boot cannot parse — and must not
     * leave the temp file behind either.
     */
    it('leaves no partial or temporary files behind', () => {
      const cache = new JsonFileCache<{ lat: number }>('atomic.json');
      cache.set('pune', { lat: 18.5 });
      cache.flush();

      expect(fs.readdirSync(dir)).toEqual(['atomic.json']);
    });

    it('creates its directory rather than silently dropping the cache', () => {
      process.env.GEO_CACHE_DIR = path.join(dir, 'nested', 'deeper');
      const cache = new JsonFileCache<{ lat: number }>('nested.json');

      cache.set('pune', { lat: 18.5 });
      cache.flush();

      expect(fs.existsSync(path.join(dir, 'nested', 'deeper', 'nested.json'))).toBe(true);
    });
  });

  describe('loading', () => {
    it('reads back what a previous process wrote', () => {
      fs.writeFileSync(path.join(dir, 'warm.json'), JSON.stringify({ pune: { lat: 18.5 } }), 'utf8');

      expect(new JsonFileCache<{ lat: number }>('warm.json').get('pune')).toEqual({ lat: 18.5 });
    });

    /**
     * The caches used to live under `dist/`, which `nest build` never populates and every deploy
     * replaces. Seeding from the old location means the first run after the move inherits
     * whatever was already known instead of re-paying ~1 second per address against providers
     * that ban by IP.
     */
    it('inherits a cache from the location it used to live in', () => {
      const legacy = path.join(dir, 'legacy-location.json');
      fs.writeFileSync(legacy, JSON.stringify({ salem: { lat: 11.66 } }), 'utf8');

      expect(new JsonFileCache<{ lat: number }>('current.json', legacy).get('salem')).toEqual({ lat: 11.66 });
    });

    it('prefers the current location over the legacy one', () => {
      const legacy = path.join(dir, 'legacy-stale.json');
      fs.writeFileSync(legacy, JSON.stringify({ salem: { lat: 0 } }), 'utf8');
      fs.writeFileSync(path.join(dir, 'current2.json'), JSON.stringify({ salem: { lat: 11.66 } }), 'utf8');

      expect(new JsonFileCache<{ lat: number }>('current2.json', legacy).get('salem')).toEqual({ lat: 11.66 });
    });

    /** A cache is an optimisation, not a source of truth — a corrupt one must not stop boot. */
    it('starts empty rather than throwing on a corrupt file', () => {
      fs.writeFileSync(path.join(dir, 'corrupt.json'), '{ this is not json', 'utf8');

      expect(() => new JsonFileCache('corrupt.json')).not.toThrow();
      expect(new JsonFileCache('corrupt.json').size).toBe(0);
    });

    /**
     * A JSON file can legitimately parse to an array or a scalar. Assigning one and then indexing
     * into it produces a cache that answers `undefined` to everything while looking loaded.
     */
    it('rejects a file that parses to something other than an object', () => {
      fs.writeFileSync(path.join(dir, 'array.json'), '[1, 2, 3]', 'utf8');

      expect(new JsonFileCache('array.json').size).toBe(0);
    });
  });

  describe('prune', () => {
    /**
     * For the autocomplete cache: without it, every partial word anyone ever typed is kept and
     * re-serialised on each write, so the file and the flush cost grow without bound even though
     * entries past their TTL can never be served.
     */
    it('drops entries a predicate rejects and keeps the rest', () => {
      const cache = new JsonFileCache<{ time: number }>('prune.json');
      cache.set('fresh', { time: 100 });
      cache.set('stale', { time: 1 });

      cache.prune((entry) => entry.time > 50);

      expect(cache.get('fresh')).toEqual({ time: 100 });
      expect(cache.get('stale')).toBeUndefined();
      expect(cache.size).toBe(1);
    });
  });

  describe('resolveGeoCacheDir', () => {
    it('honours GEO_CACHE_DIR', () => {
      process.env.GEO_CACHE_DIR = '/srv/fapoms/geo';
      expect(resolveGeoCacheDir()).toBe('/srv/fapoms/geo');
    });

    /**
     * The default must be outside the build output. The old path resolved into `dist/`, so the
     * cache was discarded by every deploy — and outside `src/`, because the previous location
     * (`src/infrastructure/database/osm-geocoding-cache.json`) is a tracked file that geocoding
     * was rewriting in place.
     */
    it('defaults somewhere a build and a deploy will not delete', () => {
      delete process.env.GEO_CACHE_DIR;
      const resolved = resolveGeoCacheDir();

      expect(path.isAbsolute(resolved)).toBe(true);
      expect(resolved).not.toContain(`${path.sep}dist${path.sep}`);
      expect(resolved).not.toContain(`${path.sep}src${path.sep}`);
    });
  });

  describe('outside tests', () => {
    /**
     * A spec run must not be able to dirty the repository. This is what stops the geocoders
     * writing into `src/infrastructure/database/` — which is exactly what they did before.
     */
    it('does not persist under test unless a spec opts in', () => {
      delete process.env.GEO_CACHE_ALLOW_WRITES_IN_TESTS;
      const cache = new JsonFileCache<{ lat: number }>('suppressed.json');

      cache.set('pune', { lat: 18.5 });
      cache.flush();

      expect(fs.existsSync(path.join(dir, 'suppressed.json'))).toBe(false);
      // Still readable in memory — only the write-back is suppressed.
      expect(cache.get('pune')).toEqual({ lat: 18.5 });
    });
  });
});
