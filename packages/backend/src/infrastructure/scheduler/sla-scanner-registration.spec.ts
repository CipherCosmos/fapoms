import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { SLA_SCANNER_QUEUE_SETTINGS } from './sla-scanner.constants';

/**
 * The SLA scanner's queue is registered once, and a stalled job on it is never re-run (the morning
 * digest re-mailed everyone when a stalled run was redelivered).
 */
describe('sla-scanner queue registration', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) files.push(p);
    }
  };
  walk(join(__dirname, '..', '..'));

  it('is registered in exactly one place', () => {
    const sites = files.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return /registerQueue\(\{\s*name:\s*(SLA_SCANNER_QUEUE|'sla-scanner')/.test(src);
    });
    expect(sites.map((f) => f.split('/src/')[1])).toEqual(['modules/notifications/notifications.module.ts']);
  });

  it('fails a stalled job instead of re-running it', () => {
    expect(SLA_SCANNER_QUEUE_SETTINGS.maxStalledCount).toBe(0);
  });
});
