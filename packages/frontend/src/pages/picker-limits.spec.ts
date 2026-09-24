import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Pickers must offer the whole list. `GET /projects` answers 50 rows and `GET /clients` 20 unless
 * asked for more, so a picker built on the bare route silently hid every later project or client.
 * Source-level on purpose: these are one-line request URLs on pages too large to mount for it.
 */
const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');

describe('project pickers ask for limit=200', () => {
  it.each(['Documents.tsx', 'CustomerMasterVersions.tsx'])('%s', (file) => {
    const src = read(file);
    expect(src).toMatch(/['`]\/projects\?limit=200/);
    expect(src).not.toMatch(/request<[^>]*>\(\s*['`]\/projects['`$]/);
    expect(src).not.toMatch(/request<[^>]*>\(`\/projects\$\{/);
  });
});

describe('Branches client picker uses the shared client list', () => {
  it('reads useClientOptions and never fetches bare /clients itself', () => {
    const src = read('Branches.tsx');
    expect(src).toContain('useClientOptions()');
    expect(src).not.toMatch(/api\.request<[^>]*>\('\/clients'\)/);
  });
});
