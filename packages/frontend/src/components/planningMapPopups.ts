import { escapeHtml } from '../utils/html';

/**
 * The HTML strings the planning map hands to Leaflet popups and tooltips.
 *
 * Leaflet sets a string popup/tooltip as `innerHTML`, and everything shown here — an assayer's
 * name and code, a bank name, a branch name, a city, a blocking reason — is text somebody typed
 * into a record. Building it here, with every such value through `escapeHtml`, keeps the one
 * rule in one place: a value from a record never reaches the map as markup. Colours and numbers
 * are computed by the map, not read from a record, and are the only things interpolated raw.
 */

export interface PopupEmpanelment {
  clientName?: string | null;
  status?: string | null;
  /** Computed by the map from the client id — never record text. */
  color: string;
}

/** What the engine said about this assayer for the selected branch, if a branch is selected. */
export type PopupVerdict =
  | { kind: 'blocked'; reason: string; detail?: string | null }
  | { kind: 'breach' }
  | { kind: 'ranked'; rank: number; score?: number | null }
  | null;

export interface AssayerPopupInput {
  markerColor: string;
  displayName: string;
  assayerCode: string;
  lifecycleStatus?: string | null;
  tint: { bg: string; fg: string };
  assignedToday: boolean;
  openAssignments: number;
  approxLocation?: boolean;
  empanelments: PopupEmpanelment[];
  /** Present only while a branch is selected. */
  selectedBranch?: {
    straightDistanceKm: number;
    slaRadiusKm: number;
    /** `null` when the distance rule is not in play. */
    slaCompliant: boolean | null;
    verdict: PopupVerdict;
    /** Blocked or in breach — no route to offer. */
    routable: boolean;
  } | null;
}

const num = (n: number) => escapeHtml(Number.isFinite(n) ? n : '');

export function assayerPopupHtml(a: AssayerPopupInput): string {
  const lifecycleChip = `<span style="display:inline-block;padding:1px 6px;border-radius:8px;background:${a.tint.bg};color:${a.tint.fg};font-size:var(--text-3xs);font-weight:700;">${escapeHtml(a.lifecycleStatus ?? '—')}</span>`;
  const open = Number(a.openAssignments) || 0;
  const availabilityLine = a.assignedToday
    ? `<div style="margin-top:3px;color:#b45309;font-weight:600;">📌 Assigned today${open > 1 ? ` · ${num(open)} open` : ''}</div>`
    : `<div style="margin-top:3px;color:#047857;font-weight:600;">✅ Free today${open > 0 ? ` · ${num(open)} open elsewhere` : ''}</div>`;
  const approxLine = a.approxLocation
    ? `<div style="margin-top:3px;font-size:var(--text-3xs);color:#92400e;">📍 Approximate area — the exact address is still being located</div>`
    : '';
  const emps = a.empanelments ?? [];
  const bankRows = emps.slice(0, 4).map((e) =>
    `<div style="display:flex;align-items:center;gap:5px;font-size:var(--text-2xs);">`
    + `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${e.color};"></span>`
    + `<span>${escapeHtml(e.clientName)}</span><span style="color:#666;">— ${escapeHtml(e.status)}</span></div>`,
  ).join('');
  const banksBlock = emps.length
    ? `<div style="margin-top:4px;border-top:1px solid #e2e8f0;padding-top:3px;">${bankRows}`
      + (emps.length > 4 ? `<div style="font-size:var(--text-3xs);color:#666;">+${num(emps.length - 4)} more</div>` : '')
      + `</div>`
    : `<div style="margin-top:4px;font-size:var(--text-3xs);color:#94a3b8;">No bank empanelments</div>`;

  const sel = a.selectedBranch;
  if (sel) {
    const radius = num(sel.slaRadiusKm);
    const slaStatus = sel.slaCompliant === null ? '' : sel.slaCompliant
      ? `<div style="color:#10b981;font-weight:600;margin-top:2px;">✅ More than ${radius} km away — minimum distance met</div>`
      : `<div style="color:#ef4444;font-weight:600;margin-top:2px;">❌ Too close to branch — within ${radius} km</div>`;
    const v = sel.verdict;
    const verdict = v?.kind === 'blocked'
      ? `<div style="margin-top:3px;color:#b45309;font-weight:600;">🚫 Not assignable — ${escapeHtml(v.reason)}</div>` +
        (v.detail ? `<div style="font-size:var(--text-3xs);color:#92400e;">└─ ${escapeHtml(v.detail)}</div>` : '')
      : v?.kind === 'breach'
      ? `<div style="margin-top:3px;color:#b45309;font-weight:600;">🚫 Not assignable — within the ${radius}km restricted zone</div>`
      : v?.kind === 'ranked'
      ? `<div style="margin-top:3px;color:#047857;font-weight:600;">#${num(v.rank)} recommended · score ${v.score == null ? '—' : num(v.score)}</div>`
      : '';
    return `
              <div style="color:#000;font-family:sans-serif;font-size:var(--text-xs);min-width:180px;">
                <b style="color:${a.markerColor};display:block;margin-bottom:2px;">${escapeHtml(a.displayName)} ${lifecycleChip}</b>
                <div>Code: <b>${escapeHtml(a.assayerCode)}</b></div>
                <div>Distance: <b>~${escapeHtml(Number(sel.straightDistanceKm).toFixed(1))} km</b> <span style="color:#666;">straight line</span></div>
                ${verdict}
                ${slaStatus}
                ${availabilityLine}
                ${approxLine}
                ${banksBlock}
                ${sel.routable ? '<div style="margin-top:4px;font-size:var(--text-3xs);color:#666;">Click to show route</div>' : ''}
              </div>
            `;
  }
  return `
              <div style="color:#000; font-family:sans-serif; font-size:var(--text-xs); min-width: 170px;">
                <b style="color:${a.markerColor}; display:block; margin-bottom: 4px;">${escapeHtml(a.displayName)} ${lifecycleChip}</b>
                <div>Code: <b>${escapeHtml(a.assayerCode)}</b></div>
                ${availabilityLine}
                ${approxLine}
                ${banksBlock}
              </div>
            `;
}

/** The hover label on a branch's minimum-distance ring. */
export function branchSlaTooltip(branchName: string, radiusKm: number, minimumMet: boolean): string {
  return minimumMet
    ? `🛡️ Minimum distance met: more than ${num(radiusKm)} km away\nCurrent branch: ${escapeHtml(branchName)}`
    : `⚠️ Too close to branch — inside the ${num(radiusKm)} km minimum distance: ${escapeHtml(branchName)}`;
}

/** The popup on a city's audit-density circle. */
export function densityPopupHtml(city: string, count: number, color: string, isHigh: boolean): string {
  return `
          <div style="color:#000; font-size:var(--text-2xs); font-family:sans-serif; min-width: 120px;">
            <b style="display:block; margin-bottom: 4px;">${escapeHtml(city)} Audit Density</b>
            <div>Audit sites: <b>${num(count)}</b></div>
            <div style="margin-top: 4px; font-weight:600; color:${color}">${isHigh ? '🔥 High Volume' : 'Standard Volume'}</div>
          </div>
        `;
}
