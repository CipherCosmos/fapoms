import {
  renderEmailLayout,
  trustedEmailHtml,
  type EmailHeaderStyle,
  type EmailLayoutOptions,
} from '@fapoms/shared';
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
 *
 * The shell — header, code box, table, callout, button, footer, escaping — is not drawn here. It is
 * `renderEmailLayout` in `@fapoms/shared`, the same function the server's built-in emails go
 * through, so what an administrator composes in the form and what the platform sends when no
 * template is published are one design. This file only decides, per template, which blocks carry
 * which `{{tokens}}`.
 */

export { shadeColor } from '@fapoms/shared';

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
  headerStyle?: EmailHeaderStyle;
  companyName?: string; // e.g. 'Sumeru Global'
  logoUrl?: string; // e.g. '/sumeru-logo@2x.png'
  supportEmail?: string; // e.g. 'support@sumeruglobal.com'
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

type TemplateBlocks = Pick<EmailLayoutOptions, 'codeBox' | 'kvTable' | 'callout' | 'blocks' | 'button'>;

/**
 * What each template adds between the greeting and the footer, and which tokens it carries.
 *
 * The tokens are passed as ordinary text: the layout escapes `& < > " '`, never braces, so
 * `{{otpCode}}` reaches the stored template literally and the server's renderer fills (and escapes)
 * it at send time. The one raw token, `{{{digestSectionsHtml}}}`, is trusted markup on purpose — it
 * is the digest the server builds, and the registry allows it for that template alone.
 *
 * A template not listed here — a key added to the registry after this form was written — gets the
 * form's own fields (headline, greeting, message, footer) in the standard shell, which is a real
 * email rather than an empty one; its specific details can be added from the HTML editor.
 */
const TEMPLATE_BLOCKS: Record<string, (buttonLabel: string | undefined) => TemplateBlocks> = {
  'otp-verification': () => ({
    codeBox: {
      label: 'Your 6-Digit One-Time Code',
      code: '{{otpCode}}',
      note: 'Valid for {{validMinutes}} minutes • Strictly confidential',
    },
  }),
  'registration-invite': (buttonLabel) => ({
    callout: {
      tone: 'slate',
      title: 'Documents you will need:',
      text: trustedEmailHtml(
        '&bull; PAN &amp; Aadhaar Cards<br/>&bull; Bank Account Details &amp; Cancelled Cheque<br/>&bull; Appraisal &amp; Technical Experience Certificates',
      ),
    },
    button: { href: '{{inviteUrl}}', label: `${buttonLabel || 'Complete Registration'} →` },
  }),
  'app-credentials': (buttonLabel) => ({
    kvTable: [
      { label: 'Username', value: '{{username}}' },
      { label: 'Temp Password', value: '{{temporaryPassword}}', highlight: true },
      { label: 'Validity', value: '{{validDays}} days' },
    ],
    button: { href: '{{loginUrl}}', label: `${buttonLabel || 'Sign In to FAPOMS Portal'} →` },
  }),
  'application-approved': (buttonLabel) => ({
    codeBox: {
      tone: 'emerald',
      label: 'Official Assayer Code',
      code: '{{assayerCode}}',
      note: trustedEmailHtml('Effective Date: <strong>{{effectiveDate}}</strong>'),
    },
    // The app, not the web portal: an appraiser has no surface on the web app, and at the moment
    // this letter is sent they hold a code but not yet the password that follows separately.
    button: { href: '{{appDownloadUrl}}', label: `${buttonLabel || 'Get the appraiser app'} →` },
  }),
  'application-rejected': () => ({
    callout: { tone: 'crimson', title: 'Review Committee Notes', text: '{{reviewNotes}}' },
  }),
  'branch-audit-paperwork': (buttonLabel) => ({
    kvTable: [
      { label: 'Bank / Branch', value: '{{bankName}} — {{branchName}}' },
      { label: 'Document', value: '{{documentType}}' },
      { label: 'Filename', value: '{{fileName}}' },
    ],
    button: { href: '{{downloadUrl}}', label: `${buttonLabel || 'Download Audit Paperwork'} ↓` },
  }),
  'morning-digest': (buttonLabel) => ({
    kvTable: [
      { label: 'Date', value: '{{briefDate}}' },
      { label: 'Summary', value: '{{subjectCounts}}' },
    ],
    blocks: [trustedEmailHtml('<div style="margin:20px 0;">{{{digestSectionsHtml}}}</div>')],
    button: { href: '{{portalUrl}}', label: `${buttonLabel || 'Open Operations Inbox'} →` },
  }),
};

function compileVisualBody(key: string, data: VisualTemplateData): string {
  const blocks = TEMPLATE_BLOCKS[key]?.(data.buttonLabel) ?? {};
  return renderEmailLayout({
    brand: {
      primaryColor: data.primaryColor,
      accentColor: data.accentBg,
      // A form saved before the header choice existed was drawn with the banner.
      headerStyle: data.headerStyle || 'gradient-banner',
      companyName: data.companyName,
      // The server fills the logo address at send time, like every other token.
      logoUrl: '{{logoUrl}}',
    },
    title: data.headline,
    bodyLines: [data.greeting, data.leadMessage],
    ...blocks,
    footer: data.footerNotice,
  });
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
