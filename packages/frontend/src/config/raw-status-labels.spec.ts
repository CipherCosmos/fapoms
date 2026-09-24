import * as fs from 'fs';
import * as path from 'path';
import { complianceLabel, INCIDENT_CATEGORIES, INCIDENT_SEVERITIES, RIGHTS_REQUEST_TYPES, RIGHTS_REQUEST_STATUSES } from '../services/compliance';
import { stageWords } from '../pages/documents/vocabulary';

jest.mock('../services/api', () => ({ api: { request: jest.fn() } }));

/**
 * NO STORED CODE REACHES THE SCREEN AS-IS.
 *
 * Four surfaces printed the raw enum: the Command Center branch drawer ("CANDIDATE_SEARCH"), a
 * superseded document in a branch's history ("ARCHIVED"), the onboarding drawer's advance button
 * tooltip ("Move to: FINAL_APPROVAL") and the compliance register ("IN_PROGRESS · UNAUTHORISED_ACCESS").
 */

const SCREAMING = /^[A-Z0-9]+(_[A-Z0-9]+)+$|^[A-Z]{2,}$/;

// Every code the backend compliance services can hand back (security-incident.service.ts,
// data-rights-request.service.ts).
const INCIDENT_STATUSES = ['OPEN', 'CONTAINED', 'RESOLVED', 'CLOSED'];

describe('compliance register words', () => {
  it.each([
    ...INCIDENT_STATUSES, ...RIGHTS_REQUEST_STATUSES, ...INCIDENT_CATEGORIES,
    ...INCIDENT_SEVERITIES, ...RIGHTS_REQUEST_TYPES,
  ])('%s is shown as a word', (code) => {
    const label = complianceLabel(code);
    expect(label).not.toBe(code);
    expect(label).not.toMatch(SCREAMING);
  });

  it('an unknown future code still reads as sentence case', () => {
    expect(complianceLabel('ESCALATED_TO_BOARD')).toBe('Escalated to board');
  });
});

describe('document stage words', () => {
  it('an archived file reads "Archived", not the code', () => {
    expect(stageWords('ARCHIVED')?.label).toBe('Archived');
  });
});

/** Source must not print the raw value in these two spots — comments stripped so prose can't satisfy it. */
function code(rel: string): string {
  const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('raw status leaks in page source', () => {
  it('Command Center branch drawer labels the branch status', () => {
    const src = code('pages/ExecutiveMap.tsx');
    expect(src).not.toMatch(/value=\{selected\.status\}/);
    expect(src).toMatch(/branchStatusLabel\(selected\.status\)/);
    // A branch in no project carries no status: named, not blank.
    expect(src).toMatch(/selected\.status \? branchStatusLabel\(selected\.status\) : 'Not in a project'/);
  });

  it('onboarding advance tooltip names the stage in words', () => {
    const src = code('pages/hr/OnboardingVerificationDrawer.tsx');
    expect(src).not.toMatch(/Move to: \$\{plan\.next\}/);
    expect(src).toMatch(/Move to: \$\{assayerLifecycleLabel\(plan\.next\)\}/);
  });

  it('compliance panel never prints a status/category/type code bare', () => {
    const src = code('pages/admin/CompliancePanel.tsx');
    expect(src).not.toMatch(/\{(inc|r)\.(status|severity|requestType)\}/);
    expect(src).not.toMatch(/inc\.category\.replace/);
  });
});
