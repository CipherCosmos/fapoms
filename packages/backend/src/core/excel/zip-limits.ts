/**
 * How big a ZIP really is once opened — checked before `xlsx.read` is allowed near it.
 *
 * An .xlsx is a ZIP. A 50 MB upload (the cap) can inflate to many gigabytes: XML of repeated cells
 * compresses better than 1000:1, and SheetJS inflates every part into memory before it parses a
 * single row. One such file would take the API down for everyone. So the archive is opened here
 * first, without SheetJS: the central directory is read for the entry count and the sizes the
 * archive declares, and then every entry is actually inflated with a hard output ceiling, because
 * a declared size is only what the file claims.
 *
 * Pure Node (`zlib`); no ZIP library is a dependency of the backend and this needs very little of one.
 */
import { inflateRawSync } from 'zlib';

export interface ZipLimits {
  /** Total uncompressed bytes across all entries. */
  maxUncompressedBytes: number;
  maxEntries: number;
}

export type ZipVerdict =
  | { ok: true; entries: number; uncompressedBytes: number }
  | { ok: false; reason: 'too-large' | 'too-many-entries' | 'unreadable' };

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
/** ZIP64 puts its real numbers elsewhere and leaves these markers in the classic fields. */
const ZIP64_U32 = 0xffffffff;
const ZIP64_U16 = 0xffff;

/** Does this buffer start like a ZIP (local header or empty-archive EOCD)? */
export function looksLikeZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b &&
    ((buf[2] === 0x03 && buf[3] === 0x04) || (buf[2] === 0x05 && buf[3] === 0x06));
}

function findEocd(buf: Buffer): number {
  // The EOCD is 22 bytes plus a comment of at most 65535 — search backwards within that window.
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Inspect a ZIP against the limits. Never throws: anything malformed, ZIP64, encrypted or using a
 * compression method other than stored/deflate comes back `unreadable` (ZIP64 as `too-large`,
 * since a ZIP64 archive exists only to exceed the classic 4 GB / 65535-entry fields).
 */
export function inspectZip(buf: Buffer, limits: ZipLimits): ZipVerdict {
  if (buf.length < 22) return { ok: false, reason: 'unreadable' };
  const eocd = findEocd(buf);
  if (eocd < 0) return { ok: false, reason: 'unreadable' };

  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (totalEntries === ZIP64_U16 || cdSize === ZIP64_U32 || cdOffset === ZIP64_U32) {
    return { ok: false, reason: 'too-large' };
  }
  if (totalEntries > limits.maxEntries) return { ok: false, reason: 'too-many-entries' };
  if (cdOffset + cdSize > eocd) return { ok: false, reason: 'unreadable' };

  // Pass 1: the sizes the archive declares. Cheap, and refuses the honest bomb without inflating.
  const entries: Array<{ method: number; flags: number; compressed: number; uncompressed: number; local: number }> = [];
  let declaredTotal = 0;
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== CEN_SIG) return { ok: false, reason: 'unreadable' };
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const uncompressed = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    if (compressed === ZIP64_U32 || uncompressed === ZIP64_U32 || local === ZIP64_U32) {
      return { ok: false, reason: 'too-large' };
    }
    declaredTotal += uncompressed;
    if (declaredTotal > limits.maxUncompressedBytes) return { ok: false, reason: 'too-large' };
    entries.push({ method, flags, compressed, uncompressed, local });
    p += 46 + nameLen + extraLen + commentLen;
  }

  // Pass 2: what the entries really inflate to, never allowed past the remaining budget. A bomb
  // that under-declares its sizes stops here, at the ceiling, instead of inside SheetJS.
  let actualTotal = 0;
  for (const e of entries) {
    if (e.flags & 0x1) return { ok: false, reason: 'unreadable' }; // encrypted
    const l = e.local;
    if (l + 30 > buf.length || buf.readUInt32LE(l) !== LOC_SIG) return { ok: false, reason: 'unreadable' };
    const start = l + 30 + buf.readUInt16LE(l + 26) + buf.readUInt16LE(l + 28);
    const end = start + e.compressed;
    if (end > buf.length) return { ok: false, reason: 'unreadable' };
    const budget = limits.maxUncompressedBytes - actualTotal;
    if (e.method === 0) {
      actualTotal += e.compressed;
    } else if (e.method === 8) {
      try {
        actualTotal += inflateRawSync(buf.subarray(start, end), { maxOutputLength: Math.max(1, budget) }).length;
      } catch (err) {
        return (err as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE'
          ? { ok: false, reason: 'too-large' }
          : { ok: false, reason: 'unreadable' };
      }
    } else {
      return { ok: false, reason: 'unreadable' };
    }
    if (actualTotal > limits.maxUncompressedBytes) return { ok: false, reason: 'too-large' };
  }
  return { ok: true, entries: entries.length, uncompressedBytes: actualTotal };
}
