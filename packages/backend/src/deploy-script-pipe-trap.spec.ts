import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * The deploy scripts run under `set -euo pipefail`, and there `producer | grep -q …` is a coin toss:
 * grep exits on its first match, the producer is still writing, it dies of SIGPIPE, and pipefail
 * turns a found match into "not found".
 *
 * On the homeserver (2026-09-25) that dropped `db-migrate` from the list of images to rebuild in
 * 3 runs out of 8. Two releases shipped an API against a database missing their migrations while
 * every container reported healthy. Match against a here-string (`grep -q … <<< "$X"`) instead.
 */
describe('deploy scripts', () => {
  const dir = join(__dirname, '..', '..', '..', 'deploy');
  const scripts = readdirSync(dir).filter((f) => f.endsWith('.sh'));

  it('finds the scripts it guards', () => {
    expect(scripts).toContain('auto-deploy.sh');
  });

  it.each(scripts)('%s never pipes into grep -q', (file) => {
    const offending = readFileSync(join(dir, file), 'utf8')
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line.trim() }))
      .filter(({ text }) => !text.startsWith('#') && /\|\s*grep\s+-[A-Za-z]*q/.test(text));
    expect(offending).toEqual([]);
  });
});
