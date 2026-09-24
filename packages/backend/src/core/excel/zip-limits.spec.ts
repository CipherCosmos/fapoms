import { deflateRawSync } from 'zlib';
import * as xlsx from 'xlsx';
import { inspectZip, looksLikeZip } from './zip-limits';

/**
 * A tiny ZIP writer, so a spec can build exactly the archive it needs — including ones that lie.
 * CRCs are left zero: the inspector does not read them, and nothing here is handed to SheetJS.
 */
function zip(
  entries: Array<{ name: string; data: Buffer; declare?: number; method?: 0 | 8 }>,
  patch: { entryCount?: number; cdOffset?: number } = {},
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(method, 8);
    loc.writeUInt32LE(body.length, 18);
    loc.writeUInt32LE(e.declare ?? e.data.length, 22);
    loc.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(e.declare ?? e.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    locals.push(loc, name, body);
    centrals.push(cen, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(patch.entryCount ?? entries.length, 8);
  eocd.writeUInt16LE(patch.entryCount ?? entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(patch.cdOffset ?? offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const LIMITS = { maxUncompressedBytes: 1024 * 1024, maxEntries: 50 };
const zeros = (n: number) => Buffer.alloc(n);

describe('inspectZip — how big the archive really is', () => {
  it('passes an ordinary archive and a real .xlsx', () => {
    expect(inspectZip(zip([{ name: 'a.xml', data: Buffer.from('<a/>') }, { name: 'b', data: zeros(10), method: 0 }]), LIMITS))
      .toEqual({ ok: true, entries: 2, uncompressedBytes: 14 });
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([['Assayer Code'], ['AS-01']]), 'S');
    const real = Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    expect(looksLikeZip(real)).toBe(true);
    expect(inspectZip(real, LIMITS).ok).toBe(true);
  });

  it('refuses an honest bomb by its declared size, before inflating', () => {
    expect(inspectZip(zip([{ name: 'sheet1.xml', data: zeros(2 * 1024 * 1024) }]), LIMITS))
      .toEqual({ ok: false, reason: 'too-large' });
  });

  it('refuses a bomb that under-declares its size, by actually inflating with a ceiling', () => {
    const lying = zip([{ name: 'sheet1.xml', data: zeros(2 * 1024 * 1024), declare: 100 }]);
    expect(inspectZip(lying, LIMITS)).toEqual({ ok: false, reason: 'too-large' });
  });

  it('counts the total across entries, not the largest one', () => {
    const many = zip(Array.from({ length: 5 }, (_, i) => ({ name: `p${i}`, data: zeros(300 * 1024) })));
    expect(inspectZip(many, LIMITS)).toEqual({ ok: false, reason: 'too-large' });
  });

  it('refuses too many entries', () => {
    const many = zip(Array.from({ length: 51 }, (_, i) => ({ name: `p${i}`, data: Buffer.from('x') })));
    expect(inspectZip(many, LIMITS)).toEqual({ ok: false, reason: 'too-many-entries' });
  });

  it('treats ZIP64 markers as over the limit', () => {
    expect(inspectZip(zip([{ name: 'a', data: Buffer.from('x') }], { cdOffset: 0xffffffff }), LIMITS))
      .toEqual({ ok: false, reason: 'too-large' });
    expect(inspectZip(zip([{ name: 'a', data: Buffer.from('x'), declare: 0xffffffff }]), LIMITS))
      .toEqual({ ok: false, reason: 'too-large' });
  });

  it('calls malformed bytes unreadable instead of throwing', () => {
    expect(inspectZip(Buffer.from('PK\x03\x04 not really a zip at all, no directory', 'latin1'), LIMITS))
      .toEqual({ ok: false, reason: 'unreadable' });
    expect(inspectZip(zip([{ name: 'a', data: Buffer.from('x') }], { entryCount: 3 }), LIMITS))
      .toEqual({ ok: false, reason: 'unreadable' });
  });
});
