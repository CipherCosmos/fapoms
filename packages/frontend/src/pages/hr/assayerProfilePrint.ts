/**
 * The printable assayer profile — the page that leaves the building.
 *
 * Same mechanics as billing/invoicePrint.ts: a self-contained HTML document opened in a new
 * tab with a Print/Save-as-PDF toolbar; no PDF library, the browser is the renderer.
 *
 * PII rule: this file NEVER receives a full PAN or Aadhaar. The server masks them into
 * `printSummary` (`maskTail`, last-4 only) before they reach the client, and this page prints
 * only what it is given — the receiving partner can match a document they were handed
 * separately, and no more. `assayer-profile-print.spec.ts` pins that no unmasked identifier
 * can slip through.
 */
import type { AssayerQualificationView, PartnerQualificationView } from '@fapoms/shared';

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const score = (n: number | null | undefined): string => (n == null ? '—' : String(n));

export interface ProfilePrintInput {
  qualification: AssayerQualificationView & { printSummary: Record<string, unknown> };
  partners: PartnerQualificationView[];
  /** From the dossier, already on the record page: verdict/date of the current check etc. */
  vetting?: {
    backgroundVerdict?: string | null;
    backgroundCheckedOn?: string | null;
    cibilBand?: string | null;
    referencesChecked?: number;
    referencesTotal?: number;
    certifications?: Array<{ name: string; expiryDate?: string | null }>;
  };
}

export function renderAssayerProfileHtml(input: ProfilePrintInput): string {
  const q = input.qualification;
  const p = q.printSummary as Record<string, any>;
  const v = input.vetting ?? {};
  const printedOn = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  const dimensionRows = q.dimensions.map((d) => `
    <tr>
      <td>${esc(d.label)}</td>
      <td class="num">${score(d.effective)}${d.override ? ' *' : ''}</td>
      <td class="basis">${d.effective == null ? 'Not yet assessed' : esc(d.basis.join(' · '))}</td>
    </tr>`).join('');

  const overrideNotes = [
    ...(q.overall.override ? [`Overall: adjusted to ${q.overall.override.value} by ${esc(q.overall.override.setByName ?? 'staff')} — ${esc(q.overall.override.reason)}`] : []),
    ...q.dimensions.filter((d) => d.override).map((d) =>
      `${esc(d.label)}: adjusted to ${d.override!.value} by ${esc(d.override!.setByName ?? 'staff')} — ${esc(d.override!.reason)}`),
  ];

  const partnerRows = input.partners
    .filter((pt) => pt.standing !== null || (pt.effective ?? 0) > 0)
    .map((pt) => `
    <tr>
      <td>${esc(pt.client.name)}</td>
      <td class="num">${pt.barred ? 'Barred' : score(pt.effective)}</td>
      <td>${esc(pt.standing ? pt.standing.replace(/_/g, ' ').toLowerCase() : 'no standing yet')}</td>
    </tr>`).join('');

  const certRows = (v.certifications ?? []).map((c) =>
    `<li>${esc(c.name)}${c.expiryDate ? ` — valid till ${esc(c.expiryDate)}` : ''}</li>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Assayer profile — ${esc(p.displayName)} (${esc(p.assayerCode)})</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 12px; color: #111; background: #f3f4f6; }
  .toolbar { display: flex; gap: 8px; padding: 10px 16px; background: #fff; border-bottom: 1px solid #e5e7eb; position: sticky; top: 0; }
  .toolbar button { padding: 7px 14px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; cursor: pointer; font-size: 12px; }
  .toolbar button.primary { background: #111827; color: #fff; border-color: #111827; }
  .sheet { max-width: 820px; margin: 18px auto; background: #fff; padding: 34px 40px; border: 1px solid #e5e7eb; }
  h1 { font-size: 20px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .07em; color: #6b7280; margin: 20px 0 8px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; }
  .overall { text-align: right; }
  .overall .big { font-size: 34px; font-weight: 800; line-height: 1; }
  .overall .cap { font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: .06em; }
  .kv { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px 22px; margin-top: 10px; }
  .kv div { font-size: 11.5px; } .kv b { display: block; font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: .05em; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  td, th { padding: 6px 8px; border-bottom: 1px solid #eef0f2; text-align: left; vertical-align: top; }
  th { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: #6b7280; }
  .num { font-weight: 700; width: 60px; text-align: right; }
  .basis { color: #4b5563; font-size: 11px; }
  ul { margin: 4px 0 0 18px; }
  .note { margin-top: 10px; font-size: 10.5px; color: #6b7280; }
  .adjust { margin-top: 8px; border: 1px solid #f59e0b; background: #fffbeb; color: #92400e; padding: 8px 10px; border-radius: 6px; font-size: 11px; }
  .foot { margin-top: 22px; border-top: 1px solid #e5e7eb; padding-top: 8px; font-size: 10.5px; color: #6b7280; display: flex; justify-content: space-between; }
  @media print { body { background: #fff; } .sheet { margin: 0; padding: 0; max-width: none; border: none; } .toolbar { display: none; } }
</style>
</head>
<body>
  <div class="toolbar">
    <button class="primary" onclick="window.print()">Print / Save as PDF</button>
    <button onclick="window.close()">Close</button>
  </div>
  <div class="sheet">
    <div class="head">
      <div>
        <h1>${esc(p.displayName)}</h1>
        <div style="color:#6b7280; margin-top:2px;">${esc(p.assayerCode)} · ${esc([p.city, p.district, p.state].filter(Boolean).join(', '))}</div>
      </div>
      <div class="overall">
        <div class="big">${score(q.overall.effective)}</div>
        <div class="cap">Overall qualification / 100</div>
      </div>
    </div>

    <h2>Identity</h2>
    <div class="kv">
      <div><b>Phone</b>${esc(p.phone || '—')}</div>
      <div><b>Email</b>${esc(p.email || '—')}</div>
      <div><b>Standing</b>${esc(String(p.lifecycleStatus ?? '—').replace(/_/g, ' ').toLowerCase())}</div>
      <div><b>PAN</b>${esc(p.panMasked || 'not on file')}</div>
      <div><b>Aadhaar</b>${esc(p.aadhaarMasked || 'not on file')}</div>
      <div><b>Experience</b>${p.experienceYears != null ? `${esc(p.experienceYears)} years` : '—'}</div>
    </div>

    <h2>Qualification scores</h2>
    <table>
      <thead><tr><th>Dimension</th><th class="num">Score</th><th>Basis</th></tr></thead>
      <tbody>${dimensionRows}</tbody>
    </table>
    ${overrideNotes.length ? `<div class="adjust"><b>* Adjusted by staff:</b><br/>${overrideNotes.join('<br/>')}</div>` : ''}

    <h2>Verification</h2>
    <div class="kv">
      <div><b>Background check</b>${esc(v.backgroundVerdict ? String(v.backgroundVerdict).replace(/_/g, ' ').toLowerCase() : 'not on file')}</div>
      <div><b>Checked on</b>${esc(v.backgroundCheckedOn || '—')}</div>
      <div><b>References checked</b>${v.referencesTotal ? `${v.referencesChecked ?? 0} of ${v.referencesTotal}` : 'none on file'}</div>
    </div>
    ${certRows ? `<h2>Certifications</h2><ul>${certRows}</ul>` : ''}

    ${partnerRows ? `<h2>Partner standings</h2>
    <table>
      <thead><tr><th>Partner</th><th class="num">Score</th><th>Standing</th></tr></thead>
      <tbody>${partnerRows}</tbody>
    </table>` : ''}

    <div class="note">Scores are computed from verified records (identity paperwork, background checks, references, credentials and work history) and are current as of the print date. A dash means that aspect has not been assessed yet. Identity numbers are deliberately shown masked.</div>
    <div class="foot"><span>Printed ${esc(printedOn)}</span><span>Generated by FAPOMS</span></div>
  </div>
</body>
</html>`;
}

/** Open the printable profile in a new tab; throws when the browser blocks the pop-up. */
export function openAssayerProfilePrintWindow(input: ProfilePrintInput): void {
  const win = window.open('', '_blank');
  if (!win) {
    throw new Error('Your browser blocked the profile tab. Allow pop-ups for this site and try again.');
  }
  win.document.open();
  win.document.write(renderAssayerProfileHtml(input));
  win.document.close();
}
