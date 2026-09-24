import { OperationsSnapshotService } from './operations-snapshot.service';

/**
 * W2 (2026-09-24): a role whose dashboard does not include "Needs attention" used to receive
 * `attention: []` — which the dashboard reads as "nothing needs attention", a claim about work the
 * viewer is simply not shown. Absent sections are null, like every other section.
 */
describe('operations snapshot — attention for roles without the section', () => {
  const service = new OperationsSnapshotService(
    { query: jest.fn(async () => [{}]) } as any,
    { wrap: jest.fn(async (_k: string, _t: number, fn: () => Promise<unknown>) => fn()) } as any,
  );

  it('is null for a role that is not shown attention', async () => {
    const out = await service.snapshot(['CLIENT_USER'], 'u-1');
    expect(out.sections).not.toContain('attention');
    expect(out.attention).toBeNull();
  });

  it('is a list for a role that is shown attention', async () => {
    const out = await service.snapshot(['OPERATIONS'], 'u-1');
    expect(Array.isArray(out.attention)).toBe(true);
  });
});
