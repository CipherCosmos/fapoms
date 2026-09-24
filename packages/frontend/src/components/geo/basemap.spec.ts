import * as fs from 'fs';
import * as path from 'path';
import { STREET_TILE_URL, STREET_ATTRIBUTION } from './basemap';

/**
 * Every map draws India from our own India map (see basemap.ts). Three components each had their
 * own OpenStreetMap tile URL; a fourth written the same way would quietly bring the wrong India
 * border back. Tile templates live in basemap.ts and nowhere else.
 */
const SRC = path.join(__dirname, '..', '..');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) sources(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.spec\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe('the India map', () => {
  it('is served by our own tile route, with the OpenStreetMap credit its licence requires', () => {
    expect(STREET_TILE_URL).toBe('/api/v1/geo/tiles/{z}/{x}/{y}');
    expect(STREET_ATTRIBUTION).toMatch(/OpenStreetMap/);
  });

  it('is the only tile source any map uses — no component writes its own tile URL', () => {
    const offenders = sources(SRC)
      .filter((f) => !f.endsWith(path.join('geo', 'basemap.ts')))
      .filter((f) => /\{z\}\/\{x\}\/\{y\}|\{z\}\/\{y\}\/\{x\}|tile\.openstreetmap\.org/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
