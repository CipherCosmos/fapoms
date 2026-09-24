import { readFileSync } from 'fs';
import { join } from 'path';
import { assayerPopupHtml, branchSlaTooltip, densityPopupHtml } from './planningMapPopups';
import { escapeHtml } from '../utils/html';

/**
 * Leaflet sets a popup/tooltip string as innerHTML, so a record value that reaches one as markup
 * runs in every planner's browser. These render each builder with hostile record text and parse
 * the result the way Leaflet would: no element the record smuggled in may exist, and the text
 * must still read exactly as typed.
 */
const EVIL = `<img src=x onerror="alert(1)">`;
const render = (html: string) => {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
};

describe('escapeHtml', () => {
  it('escapes markup and quotes, and renders null as nothing', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(3)).toBe('3');
  });
});

describe('planning map popups never render record text as markup', () => {
  const base = {
    markerColor: '#10b981',
    displayName: `Ravi ${EVIL}`,
    assayerCode: `AS-01${EVIL}`,
    lifecycleStatus: `ACTIVE${EVIL}`,
    tint: { bg: '#fff', fg: '#000' },
    assignedToday: true,
    openAssignments: 2,
    approxLocation: true,
    empanelments: [{ clientName: `SBI${EVIL}`, status: `ACTIVE${EVIL}`, color: '#123456' }],
  };

  it('assayer popup without a selected branch', () => {
    const div = render(assayerPopupHtml(base));
    expect(div.querySelector('img')).toBeNull();
    expect(div.textContent).toContain(`Ravi ${EVIL}`);
    expect(div.textContent).toContain(`AS-01${EVIL}`);
    expect(div.textContent).toContain(`SBI${EVIL}`);
  });

  it('assayer popup with a selected branch and a blocking reason', () => {
    const div = render(assayerPopupHtml({
      ...base,
      selectedBranch: {
        straightDistanceKm: 12.345, slaRadiusKm: 5, slaCompliant: true, routable: false,
        verdict: { kind: 'blocked', reason: `On leave${EVIL}`, detail: `until${EVIL}` },
      },
    }));
    expect(div.querySelector('img')).toBeNull();
    expect(div.textContent).toContain(`On leave${EVIL}`);
    expect(div.textContent).toContain(`until${EVIL}`);
    expect(div.textContent).toContain('~12.3 km');
  });

  it('ranked verdict keeps rank and score', () => {
    const div = render(assayerPopupHtml({
      ...base,
      selectedBranch: { straightDistanceKm: 1, slaRadiusKm: 5, slaCompliant: null, routable: true, verdict: { kind: 'ranked', rank: 1, score: 87 } },
    }));
    expect(div.textContent).toContain('#1 recommended · score 87');
    expect(div.textContent).toContain('Click to show route');
  });

  it('branch distance tooltip and city density popup', () => {
    expect(render(branchSlaTooltip(`Main ${EVIL}`, 5, true)).querySelector('img')).toBeNull();
    expect(render(branchSlaTooltip(`Main ${EVIL}`, 5, false)).textContent).toContain(`Main ${EVIL}`);
    const d = render(densityPopupHtml(`Pune${EVIL}`, 3, '#ef4444', true));
    expect(d.querySelector('img')).toBeNull();
    expect(d.textContent).toContain(`Pune${EVIL} Audit Density`);
  });

  it('the map builds its popup and tooltip strings only through these builders', () => {
    // Comments stripped so prose describing a template cannot satisfy or trip the check.
    const src = readFileSync(join(__dirname, 'InteractivePlanningMap.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    // A template literal handed straight to Leaflet may interpolate only the map's own numbers.
    const direct = [...src.matchAll(/\.(?:bindPopup|bindTooltip|setPopupContent|setTooltipContent)\(\s*`([^`]*)`/g)];
    for (const m of direct) {
      for (const expr of m[1].matchAll(/\$\{([^}]*)\}/g)) {
        expect(expr[1].trim()).toBe('effectiveSlaRadius');
      }
    }
    expect(src).toContain('buildAssayerPopupHtml(');
    expect(src).toContain('branchSlaTooltip(');
    expect(src).toContain('densityPopupHtml(');
  });
});
