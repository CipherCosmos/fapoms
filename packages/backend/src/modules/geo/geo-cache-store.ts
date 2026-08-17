/**
 * FAPOMS — the geocoders' on-disk JSON caches, written without stalling the process.
 *
 * ## The two faults this file exists to fix
 *
 * **1. A whole-file synchronous rewrite on every cache miss.** `india-geocoder.ts` and
 * `india-autocomplete.helper.ts` each ended their miss path with
 * `fs.writeFileSync(<the entire cache>, ...)`. `writeFileSync` blocks the event loop for the
 * whole serialise-and-write, so every geocode during a branch import — and every *keystroke* in
 * the place-lookup type-ahead, which misses until the 10-minute TTL warms — froze the API for
 * every other request in flight. The cost also grows with the cache, because the file is
 * rewritten in full: the thousandth entry pays to re-serialise the preceding 999. A 2,000-branch
 * import therefore did ~2,000 full-file rewrites, each one longer than the last, on the same
 * thread serving the rest of the platform.
 *
 * `osm-geocoder.ts` had already solved this for its own cache by marking the data dirty and
 * flushing on a debounce. This generalises that one implementation rather than leaving three
 * copies of the same decision in three files.
 *
 * **2. The cache lived inside `dist/`.** All three files resolved their path from `__dirname`
 * as `../../infrastructure/database/*.json`, which under a compiled build is
 * `dist/infrastructure/database/`. `nest build` does not copy JSON assets into `dist`, so a
 * freshly built container did not have the file at all: every deploy started from a cold cache
 * and re-paid roughly one second per distinct address against providers that enforce their rate
 * limits with IP bans. Anything the container then wrote went into a directory that the next
 * image replaces, so the cache could never accumulate across deploys.
 *
 * The directory is now `GEO_CACHE_DIR`, defaulting to `<cwd>/var/geo-cache` — outside the build
 * output, so it survives a process restart, and a single path to mount as a volume so it can
 * survive a deploy.
 *
 * ## Where this still falls short
 *
 * A file cache is per-container. With more than one backend replica each keeps its own copy, so
 * the same address is looked up once per replica, and neither replica's rate limiter knows about
 * the other's calls (see `politely()` in osm-geocoder.ts). The correct end state is a shared
 * store — a `geocode_cache` table keyed the same way, or Redis, both of which are already in this
 * deployment — which would also let the provider rate limit be enforced globally instead of
 * per-process. That needs a migration or DI plumbing into what are currently plain module-level
 * functions, so it is deliberately not attempted here; this change is confined to making the
 * existing cache stop blocking the event loop and stop being thrown away on every deploy.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Where the caches live.
 *
 * `GEO_CACHE_DIR` wins when set, which is how a deployment points them at a mounted volume.
 * The default is `<cwd>/var/geo-cache`: not inside `dist/`, so a rebuild does not delete it, and
 * not inside `src/`, so a test or a dev run cannot dirty a tracked file the way the old path
 * could (the previous location, `src/infrastructure/database/osm-geocoding-cache.json`, is
 * checked into this repository and was being rewritten in place by any code path that geocoded).
 */
export function resolveGeoCacheDir(): string {
  const configured = process.env.GEO_CACHE_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(process.cwd(), 'var', 'geo-cache');
}

/**
 * Whether a cache may write to disk at all.
 *
 * Off under test on purpose. Specs that create a branch or an assayer run through the geocoders,
 * so with persistence on, `npx jest` mutated a *tracked* file in `src/infrastructure/database/`
 * as a side effect — a spec run showed up as a source diff. Reads stay enabled, so a warm cache
 * still makes tests faster; only the write-back is suppressed.
 *
 * `GEO_CACHE_ALLOW_WRITES_IN_TESTS` re-enables it for the specs that exercise the write path
 * itself, which must point `GEO_CACHE_DIR` at a temporary directory. Same shape as
 * `GEOCODER_ALLOW_NETWORK_IN_TESTS` in osm-geocoder.ts: opt in explicitly, never by default.
 */
function persistenceEnabled(): boolean {
  if (process.env.NODE_ENV !== 'test') return true;
  return process.env.GEO_CACHE_ALLOW_WRITES_IN_TESTS === 'true';
}

/** Every live cache, so a single `beforeExit` hook can settle all of them. */
const openCaches = new Set<JsonFileCache<unknown>>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // `beforeExit` only — deliberately not SIGTERM/SIGINT, which belong to the application's own
  // shutdown sequence in main.ts and must not be claimed by a caching helper. The window this
  // leaves open is at most one debounce interval of newly-cached entries, which costs a repeat
  // lookup and nothing else.
  process.once('beforeExit', () => {
    for (const cache of openCaches) cache.flush();
  });
}

/**
 * A string-keyed JSON cache backed by one file, flushed on a debounce.
 *
 * Deliberately not a Nest provider: the geocoders are plain functions imported directly by
 * services, workers and scripts (including the standalone seed), and making them injectable
 * would ripple through all of those for no benefit at this layer.
 */
export class JsonFileCache<T> {
  private data: Record<string, T> = {};
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly filePath: string;

  /**
   * @param fileName    Base name of the cache file, e.g. `geocoding-cache.json`.
   * @param legacyPath  Optional path this cache used to live at. Read once, at construction, if
   *                    the new location has nothing yet — so the first run after this change
   *                    inherits a warm cache instead of re-geocoding everything already known.
   *                    Never written back to.
   * @param flushDelayMs Debounce window. 2s matches what osm-geocoder.ts already used.
   */
  constructor(fileName: string, legacyPath?: string, private readonly flushDelayMs = 2000) {
    this.filePath = path.join(resolveGeoCacheDir(), fileName);
    this.load(legacyPath);
    openCaches.add(this as JsonFileCache<unknown>);
    installExitHook();
  }

  private load(legacyPath?: string): void {
    for (const candidate of [this.filePath, legacyPath].filter((p): p is string => !!p)) {
      try {
        if (!fs.existsSync(candidate)) continue;
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        // A JSON file can legitimately parse to an array or a scalar; only an object is a cache.
        // Anything else is treated as corrupt rather than assigned and then indexed into.
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          this.data = parsed as Record<string, T>;
          return;
        }
      } catch {
        // A corrupt or unreadable cache must never stop the application booting — it is an
        // optimisation, not a source of truth. Fall through to the next candidate, then to empty.
      }
    }
  }

  get(key: string): T | undefined {
    return this.data[key];
  }

  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.data, key);
  }

  /** Records a value and schedules a flush. Never writes synchronously. */
  set(key: string, value: T): void {
    this.data[key] = value;
    this.dirty = true;
    if (!persistenceEnabled()) return;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.flushDelayMs);
      // Unref'd so a pending cache write cannot hold the process open — which would keep both
      // the API's shutdown and a jest run hanging for the length of the debounce.
      this.flushTimer.unref?.();
    }
  }

  /** Writes the cache out now, if anything changed. Safe to call at any time. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty || !persistenceEnabled()) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      // Written via a temporary file and renamed, so a process killed mid-write leaves the
      // previous good cache in place rather than a truncated file the next boot cannot parse.
      // `rename` is atomic within a filesystem, which the temp file shares by construction.
      const temp = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(temp, this.filePath);
      this.dirty = false;
    } catch {
      /* non-fatal: the cache is an optimisation, not a source of truth */
    }
  }

  /** Entry count — for logging and for the specs that check eviction behaviour. */
  get size(): number {
    return Object.keys(this.data).length;
  }

  /**
   * Drops every entry a predicate rejects, then schedules a flush.
   *
   * Exists for the TTL'd autocomplete cache: without it, every query string a user ever typed is
   * kept and re-serialised forever, so the file (and the flush cost) grows without bound even
   * though entries older than the TTL can never be served again.
   */
  prune(keep: (value: T) => boolean): void {
    let removed = 0;
    for (const [key, value] of Object.entries(this.data)) {
      if (!keep(value)) {
        delete this.data[key];
        removed++;
      }
    }
    if (removed > 0) this.dirty = true;
  }
}
