import { stampVisual } from './email-template-authorship';

/**
 * THE EMAIL ITSELF, WHICH IS NOT A SCREEN.
 *
 * Everything in this file builds a document that leaves the product: it is rendered by Gmail,
 * Outlook, Apple Mail and a dozen Android clients, none of which has this app's stylesheet, its
 * `:root`, or its type scale. So the sizes here are literal pixels on purpose, and this file is
 * listed in `type-scale.spec.ts` as off-scale by design — the same exemption the two print windows
 * carry, and for the same reason: a `var(--text-xs)` in an email resolves to nothing at all.
 *
 * It lives apart from `EmailTemplatesSection` so that the exemption covers only the email, and the
 * admin screen around it stays on the scale like every other screen.
 */

export interface VisualTemplateData {
  subject: string;
  headline: string;
  greeting: string;
  leadMessage: string;
  buttonLabel?: string;
  footerNotice: string;
  // Brand Theme & Styling Customization
  primaryColor?: string; // e.g. '#ED6714'
  accentBg?: string; // e.g. '#FFF7ED'
  headerStyle?: 'gradient-banner' | 'accent-line' | 'framed-card';
  companyName?: string; // e.g. 'Sumeru Global'
  logoUrl?: string; // e.g. '/sumeru-logo@2x.png'
  supportEmail?: string; // e.g. 'support@sumeruglobal.com'
}

export function shadeColor(color: string, percent: number): string {
  try {
    const raw = color.replace('#', '');
    const num = parseInt(raw.length === 3 ? raw.split('').map(c => c + c).join('') : raw, 16);
    const amt = Math.round(2.55 * percent);
    const R = (num >> 16) + amt;
    const B = ((num >> 8) & 0x00ff) + amt;
    const G = (num & 0x0000ff) + amt;
    return (
      '#' +
      (
        0x1000000 +
        (R < 255 ? (R < 1 ? 0 : R) : 255) * 0x10000 +
        (B < 255 ? (B < 1 ? 0 : B) : 255) * 0x100 +
        (G < 255 ? (G < 1 ? 0 : G) : 255)
      )
        .toString(16)
        .slice(1)
    );
  } catch {
    return color;
  }
}

/**
 * The simple editor's form, compiled into a whole email — and SIGNED, so that reopening it later
 * can restore these exact fields instead of guessing at defaults. See `email-template-authorship`
 * for what the signature protects: compiling replaces the entire body, and without a way to tell
 * "the form wrote this" from "a person wrote this", one keystroke in the form silently destroyed
 * hand-written HTML.
 */
export function compileVisualToHtml(key: string, data: VisualTemplateData): string {
  return stampVisual(compileVisualBody(key, data), data);
}

function compileVisualBody(key: string, data: VisualTemplateData): string {
  const primary = data.primaryColor || '#ED6714';
  const accent = data.accentBg || '#FFF7ED';
  const company = data.companyName || 'Sumeru Global';
  const headerStyle = data.headerStyle || 'gradient-banner';
  const darkerPrimary = shadeColor(primary, -18);

  let dynamicBody = '';

  if (key === 'otp-verification') {
    dynamicBody = `
      <div style="background:${accent};border:1.5px dashed ${primary};border-radius:8px;padding:22px;text-align:center;margin:24px 0;">
        <div style="font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${primary};margin-bottom:8px;">Your 6-Digit One-Time Code</div>
        <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:36px;font-weight:800;letter-spacing:10px;color:${primary};">{{otpCode}}</div>
        <div style="font-size:12px;color:${primary};opacity:0.85;margin-top:8px;">Valid for {{validMinutes}} minutes &bull; Strictly confidential</div>
      </div>`;
  } else if (key === 'registration-invite') {
    dynamicBody = `
      <div style="margin:26px 0;text-align:center;">
        <a href="{{inviteUrl}}" style="display:inline-block;background:${primary};color:#FFFFFF;font-weight:700;font-size:14px;padding:14px 28px;border-radius:6px;text-decoration:none;box-shadow:0 3px 6px ${primary}40;">
          ${data.buttonLabel || 'Complete Registration'} &rarr;
        </a>
      </div>
      <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:16px;margin:20px 0;font-size:13px;color:#475569;">
        <div style="font-weight:700;color:#1E293B;margin-bottom:8px;">Documents you will need:</div>
        <div style="line-height:1.6;">&bull; PAN & Aadhaar Cards<br/>&bull; Bank Account Details & Cancelled Cheque<br/>&bull; Appraisal & Technical Experience Certificates</div>
      </div>`;
  } else if (key === 'app-credentials') {
    dynamicBody = `
      <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:18px;margin:20px 0;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <tr>
            <td style="padding:6px 0;color:#64748B;width:120px;">Username:</td>
            <td style="padding:6px 0;font-weight:700;color:#1E293B;font-family:monospace;">{{username}}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#64748B;">Temp Password:</td>
            <td style="padding:6px 0;font-weight:700;color:${primary};font-family:monospace;background:${accent};padding-left:6px;border-radius:4px;">{{temporaryPassword}}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#64748B;">Validity:</td>
            <td style="padding:6px 0;color:#1E293B;">{{validDays}} days</td>
          </tr>
        </table>
      </div>
      <div style="margin:24px 0;text-align:center;">
        <a href="{{loginUrl}}" style="display:inline-block;background:${primary};color:#FFFFFF;font-weight:700;font-size:14px;padding:14px 28px;border-radius:6px;text-decoration:none;box-shadow:0 3px 6px ${primary}40;">
          ${data.buttonLabel || 'Sign In to FAPOMS Portal'} &rarr;
        </a>
      </div>`;
  } else if (key === 'application-approved') {
    dynamicBody = `
      <div style="background:#ECFDF5;border:1.5px solid #A7F3D0;border-radius:8px;padding:18px;margin:20px 0;text-align:center;">
        <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#065F46;margin-bottom:4px;">Official Assayer Code</div>
        <div style="font-family:monospace;font-size:28px;font-weight:800;color:#047857;letter-spacing:3px;">{{assayerCode}}</div>
        <div style="font-size:12px;color:#065F46;margin-top:6px;">Effective Date: <strong>{{effectiveDate}}</strong></div>
      </div>
      <div style="margin:24px 0;text-align:center;">
        <a href="{{loginUrl}}" style="display:inline-block;background:${primary};color:#FFFFFF;font-weight:700;font-size:14px;padding:14px 28px;border-radius:6px;text-decoration:none;box-shadow:0 3px 6px ${primary}40;">
          ${data.buttonLabel || 'Access Appraiser Portal'} &rarr;
        </a>
      </div>`;
  } else if (key === 'application-rejected') {
    dynamicBody = `
      <div style="background:#FEF2F2;border-left:4px solid #EF4444;border-radius:4px;padding:16px;margin:20px 0;">
        <div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#991B1B;margin-bottom:6px;">Review Committee Notes</div>
        <div style="font-size:13px;color:#7F1D1D;line-height:1.6;">{{reviewNotes}}</div>
      </div>`;
  } else if (key === 'branch-audit-paperwork') {
    dynamicBody = `
      <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:16px;margin:20px 0;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <tr><td style="padding:5px 0;color:#64748B;width:120px;">Bank / Branch:</td><td style="padding:5px 0;font-weight:600;color:#1E293B;">{{bankName}} — {{branchName}}</td></tr>
          <tr><td style="padding:5px 0;color:#64748B;">Document:</td><td style="padding:5px 0;font-weight:600;color:#1E293B;">{{documentType}}</td></tr>
          <tr><td style="padding:5px 0;color:#64748B;">Filename:</td><td style="padding:5px 0;font-family:monospace;color:#1E293B;">{{fileName}}</td></tr>
        </table>
      </div>
      <div style="margin:24px 0;text-align:center;">
        <a href="{{downloadUrl}}" style="display:inline-block;background:${primary};color:#FFFFFF;font-weight:700;font-size:14px;padding:14px 28px;border-radius:6px;text-decoration:none;box-shadow:0 3px 6px ${primary}40;">
          ${data.buttonLabel || 'Download Audit Paperwork'} &darr;
        </a>
      </div>`;
  } else if (key === 'morning-digest') {
    dynamicBody = `
      <div style="background:${accent};border:1px solid ${primary}40;border-radius:8px;padding:14px 18px;margin:20px 0;display:flex;justify-content:space-between;align-items:center;">
        <div style="font-size:13px;font-weight:700;color:${primary};">Date: {{briefDate}}</div>
        <div style="font-size:12px;font-weight:700;background:${primary};color:#FFFFFF;padding:4px 8px;border-radius:4px;">{{subjectCounts}}</div>
      </div>
      <div style="margin:20px 0;">
        {{{digestSectionsHtml}}}
      </div>
      <div style="margin:24px 0;text-align:center;">
        <a href="{{portalUrl}}" style="display:inline-block;background:${primary};color:#FFFFFF;font-weight:700;font-size:14px;padding:14px 28px;border-radius:6px;text-decoration:none;box-shadow:0 3px 6px ${primary}40;">
          ${data.buttonLabel || 'Open Operations Inbox'} &rarr;
        </a>
      </div>`;
  }

  let headerHtml = '';
  if (headerStyle === 'gradient-banner') {
    headerHtml = `
      <tr>
        <td style="padding:26px 20px 22px;background:linear-gradient(135deg, ${primary} 0%, ${darkerPrimary} 100%);text-align:center;border-radius:9px 9px 0 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
            <tr>
              <td align="center" style="background:#FFFFFF;border-radius:8px;padding:8px 14px;box-shadow:0 2px 6px rgba(0,0,0,0.15);">
                <img src="{{logoUrl}}" alt="${company}" width="65" height="50" style="display:block;margin:0 auto;height:50px;width:auto;border:0;outline:none;" />
              </td>
            </tr>
          </table>
          <div style="color:#FFFFFF;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-top:12px;opacity:0.95;">${company}</div>
          <div style="color:#FFFFFF;font-size:11px;opacity:0.8;margin-top:3px;">Field Audit & Verification Platform</div>
        </td>
      </tr>`;
  } else if (headerStyle === 'framed-card') {
    headerHtml = `
      <tr>
        <td style="height:5px;background-color:${primary};font-size:0;line-height:0;">&nbsp;</td>
      </tr>
      <tr>
        <td style="padding:24px 32px 18px;background:${accent};border-bottom:1.5px solid ${primary}33;text-align:center;">
          <img src="{{logoUrl}}" alt="${company}" width="65" height="50" style="display:block;margin:0 auto;height:50px;width:auto;border:0;outline:none;" />
          <div style="display:inline-block;margin-top:10px;padding:3px 12px;background:${primary};color:#FFFFFF;font-size:10.5px;font-weight:700;letter-spacing:1px;text-transform:uppercase;border-radius:12px;">${company} Official Notice</div>
        </td>
      </tr>`;
  } else {
    // 'accent-line'
    headerHtml = `
      <tr>
        <td style="height:5px;background-color:${primary};font-size:0;line-height:0;">&nbsp;</td>
      </tr>
      <tr>
        <td style="padding:28px 32px 18px;text-align:center;border-bottom:1px solid #F3F4F6;">
          <img src="{{logoUrl}}" alt="${company}" width="65" height="50" style="display:block;margin:0 auto;height:50px;width:auto;border:0;outline:none;" />
        </td>
      </tr>`;
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${data.headline}</title>
</head>
<body style="margin:0;padding:0;background-color:#F8FAFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1E293B;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color:#F8FAFC;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width:560px;background-color:#FFFFFF;border:1px solid #E2E8F0;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
          ${headerHtml}
          <!-- Main Content -->
          <tr>
            <td style="padding:24px 36px 36px;">
              <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#1E293B;text-align:center;">${data.headline}</h1>
              <p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#334155;">${data.greeting}</p>
              <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#475569;">${data.leadMessage}</p>
              ${dynamicBody}
              <div style="border-top:1px solid #E2E8F0;padding-top:18px;margin-top:28px;font-size:12px;color:#94A3B8;text-align:center;line-height:1.5;">
                <div>${data.footerNotice}</div>
                <div style="margin-top:8px;font-size:11px;color:#CBD5E1;">&copy; ${company} &bull; Field Assayer & Portfolio Operations Management System</div>
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}


/**
 * The block added by "add the missing details for me".
 *
 * A template is invalid without the tokens its contract requires — the support address, the code,
 * the link — and telling somebody who does not write HTML to "add {{supportEmail}}" is telling
 * them nothing. This builds a small, plain block carrying whichever ones are absent, in the same
 * literal-pixel style as the rest of the email.
 */
export function missingTokenBlock(missingRequiredTokens: string[]): string {
  let injectionBlock = '\n<!-- Sumeru Verification Details (Auto-Injected) -->\n';
  injectionBlock += '<div style="margin-top:24px;padding:14px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;font-size:12px;color:#64748B;line-height:1.5;">\n';

  missingRequiredTokens.forEach((tok) => {
    if (tok === 'logoUrl') {
      injectionBlock += '  <div style="display:none;"><img src="{{logoUrl}}" alt="Sumeru Global" /></div>\n';
    } else if (tok === 'supportEmail') {
      injectionBlock += '  <div>Support Desk: <a href="mailto:{{supportEmail}}" style="color:#ED6714;">{{supportEmail}}</a></div>\n';
    } else if (tok === 'validMinutes') {
      injectionBlock += '  <div>Security Notice: Valid for {{validMinutes}} minutes.</div>\n';
    } else if (tok === 'validDays') {
      injectionBlock += '  <div>Validity: Active for {{validDays}} days.</div>\n';
    } else if (tok === 'otpCode') {
      injectionBlock += '  <div style="margin-top:6px;font-weight:700;color:#9A3412;">Verification Code: <span style="font-family:monospace;font-size:16px;">{{otpCode}}</span></div>\n';
    } else if (tok === 'loginUrl' || tok === 'inviteUrl' || tok === 'downloadUrl' || tok === 'portalUrl') {
      injectionBlock += `  <div style="margin-top:6px;"><a href="{{${tok}}}" style="color:#ED6714;font-weight:600;">Access Link (Click Here)</a></div>\n`;
    } else if (tok === 'digestSectionsHtml') {
      injectionBlock += '  <div>{{{digestSectionsHtml}}}</div>\n';
    } else {
      injectionBlock += `  <div>{{${tok}}}</div>\n`;
    }
  });
  injectionBlock += '</div>\n';
  return injectionBlock;
}
