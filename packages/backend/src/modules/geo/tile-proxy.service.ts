import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { resolveGeoCacheDir } from './geo-cache-store';

/**
 * FAPOMS — raster map tiles, fetched once by us and served from our own cache.
 *
 * ## Why this exists
 *
 * The in-app map picker (packages/mobile/src/components/ui/MapPicker.tsx) originally pointed its
 * `<Image>` grid straight at `tile.openstreetmap.org`. On real assayer handsets that started
 * returning **HTTP 403** — and not because of the User-Agent: curl from a dev machine gets 200
 * with any UA, so the block is at the network/IP level. OSM's tile servers are donated
 * infrastructure whose usage policy effectively rules out apps hitting them directly from a
 * large, changing pool of mobile IPs. MapPicker's own header comment predicted this and said the
 * tile URL should move behind the backend once usage grew. It grew.
 *
 * Proxying fixes three things at once: the device talks only to a host it is already
 * authenticated against, upstream sees one identified server instead of thousands of phones, and
 * the cache below means the same tile is fetched from OSM at most once per TTL no matter how many
 * assayers pan over the same town.
 *
 * ## Why an on-disk cache and not CacheService
 *
 * `CacheService` is a *JSON* cache over Redis — every value goes through `JSON.stringify`. Tiles
 * are binary PNGs, so storing them there means base64 (a third larger) inside the same Redis the
 * platform uses for sessions, locks and dashboard aggregates, held for 30 days. That is the wrong
 * store for the payload and the wrong pressure on a shared instance. Tiles are immutable blobs
 * addressed by a path, which is exactly what a filesystem is for — and the geo module already
 * keeps a persistent, volume-mountable cache directory (`resolveGeoCacheDir()`), so this reuses
 * that location rather than inventing a second one.
 *
 * The cache is **bounded by total bytes** (`TILE_CACHE_MAX_BYTES`), with oldest-first eviction. An
 * unbounded tile cache is a slow disk-full outage: a handful of users panning at zoom 18 can pull
 * tens of thousands of tiles, and nothing would ever remove them.
 */

/**
 * The upstream tile source. Single named constant on purpose: repointing this at a paid provider
 * or a self-hosted renderer (Thunderforest, MapTiler, a local tileserver-gl) is the entire change
 * needed — nothing else in the backend or the app knows where tiles come from.
 */
const UPSTREAM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/**
 * OSM's policy requires a real, identifying User-Agent naming the application and a way to reach
 * its operator. A generic or absent UA is grounds for being blocked outright.
 */
const TILE_USER_AGENT = 'FAPOMS-Orbit/1.0 (+it@sumeruglobal.in)';

/** Matches MapPicker's exported MIN_ZOOM/MAX_ZOOM. Anything outside is a malformed request. */
const MIN_ZOOM = 3;
const MAX_ZOOM = 18;

/** Map tiles are effectively immutable; a month between re-fetches is conservative. */
const TILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** ~256 MB of tiles (a tile averages 10–20 KB, so roughly 15–25k tiles). */
const TILE_CACHE_MAX_BYTES = 256 * 1024 * 1024;

/** Evict down to this fraction of the cap, so eviction runs rarely instead of on every write. */
const TILE_CACHE_EVICT_TO = 0.8;

/** Same 8s budget the geocoders in this module use for upstream calls. */
const TILE_FETCH_TIMEOUT_MS = 8000;

export interface TileRequest {
  z: number;
  x: number;
  y: number;
}

/** Thrown for a request that is not a valid tile address; the controller turns it into a 400. */
export class InvalidTileError extends Error {}

/**
 * Parse and validate `z/x/y` strictly.
 *
 * This is the security boundary, not a nicety. Without it the endpoint is a general-purpose fetch
 * proxy: anything that survives into the URL template lets a caller aim our server at a host of
 * their choosing. Only integers in range ever reach `fetch`.
 */
export function parseTileCoords(z: string, x: string, y: string): TileRequest {
  const nz = Number(z);
  const nx = Number(x);
  const ny = Number(y);
  for (const n of [nz, nx, ny]) {
    if (!Number.isInteger(n)) throw new InvalidTileError('Tile coordinates must be integers.');
  }
  if (nz < MIN_ZOOM || nz > MAX_ZOOM) {
    throw new InvalidTileError(`Zoom must be between ${MIN_ZOOM} and ${MAX_ZOOM}.`);
  }
  const limit = Math.pow(2, nz);
  if (nx < 0 || nx >= limit || ny < 0 || ny >= limit) {
    throw new InvalidTileError(`Tile x/y must be within [0, ${limit}) at zoom ${nz}.`);
  }
  return { z: nz, x: nx, y: ny };
}

@Injectable()
export class TileProxyService {
  private readonly logger = new Logger(TileProxyService.name);
  private readonly dir = path.join(resolveGeoCacheDir(), 'tiles');

  /**
   * Bytes currently on disk, counted once on first use. Kept in memory so the common path (a hit,
   * or a write well under the cap) never has to walk the directory tree.
   */
  private bytes = 0;
  private sized = false;

  /**
   * In-flight upstream fetches, keyed by tile. A pan makes the whole grid appear at once and
   * several devices look at the same town, so without this the same tile is fetched N times
   * concurrently — precisely the "heavy automated use" the policy prohibits.
   */
  private readonly inFlight = new Map<string, Promise<Buffer>>();

  /** Returns the PNG bytes for a validated tile, from disk if we already have it. */
  async getTile(tile: TileRequest): Promise<Buffer> {
    const file = this.pathFor(tile);
    const cached = this.readFresh(file);
    if (cached) return cached;

    const key = `${tile.z}/${tile.x}/${tile.y}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const pending = this.fetchUpstream(tile)
      .then((buf) => {
        this.write(file, buf);
        return buf;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    return pending;
  }

  private pathFor(tile: TileRequest): string {
    return path.join(this.dir, String(tile.z), String(tile.x), `${tile.y}.png`);
  }

  /** A cached tile, or null if absent, expired or unreadable. Cache faults are never fatal. */
  private readFresh(file: string): Buffer | null {
    try {
      const stat = fs.statSync(file);
      if (Date.now() - stat.mtimeMs > TILE_TTL_MS) return null;
      return fs.readFileSync(file);
    } catch {
      return null;
    }
  }

  private async fetchUpstream(tile: TileRequest): Promise<Buffer> {
    const url = UPSTREAM_TILE_URL
      .replace('{z}', String(tile.z))
      .replace('{x}', String(tile.x))
      .replace('{y}', String(tile.y));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TILE_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': TILE_USER_AGENT, Accept: 'image/png,image/*;q=0.8' },
      });
      if (!res.ok) throw new Error(`upstream ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Write-through, best effort. A read-only or full disk must degrade to "uncached", not 500. */
  private write(file: string, buf: Buffer): void {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
      this.ensureSized();
      this.bytes += buf.length;
      if (this.bytes > TILE_CACHE_MAX_BYTES) this.evict();
    } catch (err) {
      this.logger.warn(`tile cache write failed: ${(err as Error).message}`);
    }
  }

  private ensureSized(): void {
    if (this.sized) return;
    this.sized = true;
    this.bytes = this.walk().reduce((sum, e) => sum + e.size, 0);
  }

  private walk(): { file: string; size: number; mtimeMs: number }[] {
    const out: { file: string; size: number; mtimeMs: number }[] = [];
    const visit = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (entry.isFile()) {
          try {
            const stat = fs.statSync(full);
            out.push({ file: full, size: stat.size, mtimeMs: stat.mtimeMs });
          } catch {
            /* raced with an eviction; ignore */
          }
        }
      }
    };
    visit(this.dir);
    return out;
  }

  /**
   * Oldest-first eviction down to `TILE_CACHE_EVICT_TO` of the cap. Approximate LRU by mtime,
   * which is good enough here: tiles are interchangeable and the cost of evicting a hot one is a
   * single re-fetch, whereas tracking true access order would mean writing on every read.
   */
  private evict(): void {
    const target = TILE_CACHE_MAX_BYTES * TILE_CACHE_EVICT_TO;
    const entries = this.walk().sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    for (const entry of entries) {
      if (total <= target) break;
      try {
        fs.unlinkSync(entry.file);
        total -= entry.size;
      } catch {
        /* already gone */
      }
    }
    this.bytes = total;
    this.logger.log(`tile cache evicted to ${(total / 1024 / 1024).toFixed(1)} MB`);
  }
}
