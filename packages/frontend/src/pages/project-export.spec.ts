import { readFileSync } from 'fs';
import { join } from 'path';
import { fetchAllProjectPages, PROJECT_EXPORT_PAGE_SIZE } from './project-export';

/** The Projects export used to stop at the rows the table had loaded — 50, on page one. */
describe('fetchAllProjectPages', () => {
  const rows = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `p${from + i}` }));

  it('walks every page until the reported total is collected', async () => {
    const request = jest.fn()
      .mockResolvedValueOnce({ data: rows(PROJECT_EXPORT_PAGE_SIZE), meta: { pagination: { total: 450 } } })
      .mockResolvedValueOnce({ data: rows(PROJECT_EXPORT_PAGE_SIZE, 200), meta: { pagination: { total: 450 } } })
      .mockResolvedValueOnce({ data: rows(50, 400), meta: { pagination: { total: 450 } } });
    const all = await fetchAllProjectPages(request, 'region=WEST');
    expect(all).toHaveLength(450);
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      '/projects?page=1&limit=200&region=WEST',
      '/projects?page=2&limit=200&region=WEST',
      '/projects?page=3&limit=200&region=WEST',
    ]);
    expect(request.mock.calls[0][1]).toMatchObject({ withMeta: true });
  });

  it('stops after one short page', async () => {
    const request = jest.fn().mockResolvedValue({ data: rows(3), meta: { pagination: { total: 3 } } });
    expect(await fetchAllProjectPages(request, '')).toHaveLength(3);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('/projects?page=1&limit=200');
  });

  it('Projects.tsx exports through it, not through the loaded rows', () => {
    const src = readFileSync(join(__dirname, 'Projects.tsx'), 'utf8');
    expect(src).toContain('fetchAllProjectPages<ProjectItem>(');
    expect(src).not.toMatch(/projects\.length > 0 \? projects : await api\.request/);
  });
});
