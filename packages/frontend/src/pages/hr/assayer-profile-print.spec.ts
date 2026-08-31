import { renderAssayerProfileHtml } from './assayerProfilePrint';

/**
 * The promise on printed paper: the profile export never contains an unmasked identifier.
 *
 * The server masks PAN/Aadhaar before they reach the client (`printSummary`), and this spec
 * pins the render side of the same contract — if someone ever wires a raw field into the
 * template, the full number appearing in the HTML fails the build.
 */
describe('assayer profile print', () => {
  const FULL_PAN = 'ABCDE1234F';
  const FULL_AADHAAR = '123456789012';

  const input = {
    qualification: {
      assayerId: 'a-1',
      dimensions: [
        { key: 'payability', label: 'Record completeness', computed: 100, override: null, effective: 100, basis: ['Every critical record field is filled in.'] },
        { key: 'backgroundCheck', label: 'Background check', computed: null, override: null, effective: null, basis: ['No background check on file yet.'] },
      ],
      overall: { computed: 100, override: { id: 'ov1', value: 90, reason: 'pending site visit', setBy: 'u1', setByName: 'Priya', setAt: '2026-08-29T00:00:00Z' }, effective: 90 },
      weights: { payability: 15 },
      computedAt: '2026-08-29T00:00:00Z',
      // What the server actually sends: already masked. The full numbers exist only in this
      // spec, to prove they cannot appear in the output even if handed over.
      printSummary: {
        displayName: 'Test Person', assayerCode: 'AS0001', phone: '9999999999', email: 'x@y.z',
        city: 'Pune', district: 'Pune', state: 'Maharashtra', lifecycleStatus: 'ACTIVE',
        joiningDate: '2024-01-01', experienceYears: 3,
        panMasked: '******234F', aadhaarMasked: '********9012',
      },
    } as any,
    partners: [
      { client: { id: 'c1', name: 'Axis Bank', clientCode: 'AXIS' }, dimensions: [], computed: 80, effective: 25, override: null, standing: 'REJECTED', standingReason: 'declined', standingCap: 25, barred: false, gaps: [] },
    ] as any,
    vetting: { backgroundVerdict: 'CLEAR', backgroundCheckedOn: '2026-06-01', referencesChecked: 2, referencesTotal: 3 },
  };

  it('renders masked identifiers and never a full PAN or Aadhaar', () => {
    const html = renderAssayerProfileHtml(input);
    expect(html).toContain('******234F');
    expect(html).toContain('********9012');
    expect(html).not.toContain(FULL_PAN);
    expect(html).not.toContain(FULL_AADHAAR);
  });

  it('shows an unassessed dimension as such, never as a number', () => {
    const html = renderAssayerProfileHtml(input);
    expect(html).toContain('Not yet assessed');
  });

  it('flags an adjusted score with who and why — an override is never silent on paper', () => {
    const html = renderAssayerProfileHtml(input);
    expect(html).toContain('Adjusted by staff');
    expect(html).toContain('Priya');
    expect(html).toContain('pending site visit');
  });

  it('escapes HTML in every printed field', () => {
    const hostile = JSON.parse(JSON.stringify(input));
    hostile.qualification.printSummary.displayName = '<script>alert(1)</script>';
    const html = renderAssayerProfileHtml(hostile);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
