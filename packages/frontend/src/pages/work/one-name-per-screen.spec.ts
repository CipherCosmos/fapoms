import { readFileSync } from 'fs';
import { join } from 'path';
import { WORK_TABS, workTabHint, workTabLabel } from './workTabs';

/**
 * A screen is called one thing.
 *
 * `/assignments` was "Audit Work" in the sidebar, "Audit Work" in the breadcrumb, "Field work" on
 * the tab, and "Field Execution Workspace" in the page heading directly beneath the tab — four
 * names inside about 120 vertical pixels, two of them invented by the page itself. `/inbox` said
 * "Operations Inbox" and `/scheduling` said "Scheduling Workspace" for the same reason: each of
 * these used to be a destination of its own, and each kept its old title when they were merged.
 *
 * Two names for one place is not a cosmetic problem. It is what makes somebody ask whether the
 * "Field work" tab and the "Field Execution Workspace" they landed on are the same thing.
 */

const SRC = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

/** The page that draws each tab's own heading. Planning draws none — the tab strip IS its header. */
const HEADINGS: Array<[path: string, file: string]> = [
  ['/inbox', 'pages/OperationsInbox.tsx'],
  ['/scheduling', 'pages/Scheduling.tsx'],
  ['/assignments', 'pages/assignments/AssignmentQueueHeader.tsx'],
];

describe('one name per Audit Work tab', () => {
  it.each(HEADINGS)('%s takes its heading from the tab, not from a title of its own', (path, file) => {
    const source = read(file);
    expect(source).toContain(`workTabLabel('${path}')`);
    /*
      And nowhere in the page's own heading. A literal here is how the two drifted apart before,
      and it has to be read out of the `<PageHeader …>` block itself: the same file legitimately
      carries `title="Download"` on an icon button and `title="Reschedule Audit Date"` on a modal,
      neither of which is the name of the screen.
    */
    const heading = source.match(/<PageHeader[\s\S]*?\/>/);
    expect(heading).not.toBeNull();
    expect(heading![0]).not.toMatch(/(?<![a-zA-Z])title="/);
  });

  it('and the names themselves have not grown a "Workspace" back', () => {
    // "Workspace" said nothing that "Scheduling" did not: three of the four tabs had it, so it
    // could not even distinguish them from each other.
    for (const tab of WORK_TABS) {
      expect(tab.label).not.toMatch(/workspace/i);
      expect(tab.label.length).toBeLessThan(20);
    }
  });

  it('answers for every tab, so a new one cannot arrive unnamed', () => {
    for (const tab of WORK_TABS) {
      expect(workTabLabel(tab.path)).toBe(tab.label);
      expect(workTabHint(tab.path)).toBe(tab.hint);
      expect(workTabHint(tab.path).length).toBeGreaterThan(10);
    }
  });

  it('gives the sidebar and the breadcrumb the destination, not one of its tabs', () => {
    // The tab strip is on screen; the two places above it name where you are, once.
    expect(read('components/Sidebar.tsx')).toContain("name: 'Audit Work'");
    const header = read('components/Header.tsx');
    for (const tab of WORK_TABS) {
      expect(header).toContain(`{ prefix: '${tab.path}', category: 'Operations', label: 'Audit Work' }`);
    }
  });
});
