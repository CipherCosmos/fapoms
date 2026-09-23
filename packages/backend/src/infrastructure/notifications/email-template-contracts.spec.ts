/**
 * FAPOMS — Automated Email Template Contract & Security Test Suite
 *
 * Verifies:
 *   1. Every registered template key has a valid contract definition and sample payload.
 *   2. Every shipped disk template file in templates/emails/*.html passes contract validation:
 *      - Contains all required tokens
 *      - Contains no undeclared/unknown tokens
 *      - Contains no security violations (scripts, iframes, forms, javascript: URIs, event handlers)
 *      - Complies with raw HTML token restrictions
 *   3. Validator blocks malicious inputs and unknown tokens.
 *   4. Safe XML entity escaping on {{token}} vs raw HTML on {{{rawToken}}}.
 *   5. Renderer gracefully cascades to fallback on missing required payload values or corrupt templates.
 *   6. Loader correctly reads disk templates and calculates deterministic checksums.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  EMAIL_TEMPLATE_REGISTRY,
  EmailTemplateKey,
} from './email-template-registry';
import {
  validateTemplateContract,
  extractTokens,
  validateHtmlSecurity,
} from './email-template-validator';
import { EmailTemplateLoader } from './email-template-loader';
import { EmailTemplateRenderer, escapeHtml } from './email-template-renderer';

describe('Email Template Engine & Security Contracts', () => {
  const allKeys: EmailTemplateKey[] = [
    'otp-verification',
    'registration-invite',
    'app-credentials',
    'application-approved',
    'application-rejected',
    'application-info-requested',
    'reference-notice',
    'branch-audit-paperwork',
    'morning-digest',
    'account-setup-link',
    'password-reset-link',
    'mfa-code',
  ];

  describe('1. Registry Contract Definitions', () => {
    it('registers all 12 production templates', () => {
      expect(Object.keys(EMAIL_TEMPLATE_REGISTRY)).toHaveLength(12);
      for (const key of allKeys) {
        expect(EMAIL_TEMPLATE_REGISTRY[key]).toBeDefined();
        expect(EMAIL_TEMPLATE_REGISTRY[key].key).toBe(key);
        expect(EMAIL_TEMPLATE_REGISTRY[key].requiredTokens.length).toBeGreaterThan(0);
        expect(EMAIL_TEMPLATE_REGISTRY[key].sampleData).toBeDefined();
        expect(EMAIL_TEMPLATE_REGISTRY[key].defaultSubjectTemplate).toBeDefined();
      }
    });

    it('sampleData contains all required tokens for every template', () => {
      for (const key of allKeys) {
        const def = EMAIL_TEMPLATE_REGISTRY[key];
        for (const reqToken of def.requiredTokens) {
          expect(def.sampleData[reqToken]).toBeDefined();
          expect(String(def.sampleData[reqToken]).trim().length).toBeGreaterThan(0);
        }
      }
    });

    it('strictly forbids raw HTML tokens on sensitive templates', () => {
      const sensitiveKeys: EmailTemplateKey[] = [
        'otp-verification',
        'registration-invite',
        'app-credentials',
        'application-approved',
        'application-rejected',
        'application-info-requested',
    'reference-notice',
        'branch-audit-paperwork',
        'account-setup-link',
        'password-reset-link',
        'mfa-code',
      ];
      for (const key of sensitiveKeys) {
        const def = EMAIL_TEMPLATE_REGISTRY[key];
        expect(def.allowRawHtmlTokens).toBe(false);
        expect(def.rawTokens || []).toHaveLength(0);
      }
    });

    /**
     * If the administrator's template cannot be loaded, the brief falls back to the registry. That
     * fallback used to ignore the sections and send a generic "please review items" email — the one
     * failure that empties exactly the email whose whole purpose is its contents.
     */
    it('morning-digest\'s built-in fallback still carries every heading, item and link', () => {
      const def = EMAIL_TEMPLATE_REGISTRY['morning-digest'];
      const out = def.fallbackRenderer({
        ...def.sampleData,
        digestSectionsText: 'Desk SLA Breaches (1)\n• Fort Branch report overdue\nhttps://fapoms.example/desk',
      });
      for (const part of ['Desk SLA Breaches (1)', 'Fort Branch report overdue', 'https://fapoms.example/desk']) {
        expect(out.text).toContain(part);
        expect(out.html).toContain(part);
      }
    });

    it('morning-digest explicitly allows and restricts {{{digestSectionsHtml}}}', () => {
      const digestDef = EMAIL_TEMPLATE_REGISTRY['morning-digest'];
      expect(digestDef.allowRawHtmlTokens).toBe(true);
      expect(digestDef.rawTokens).toContain('digestSectionsHtml');
    });
  });

  describe('2. Shipped Disk Templates Validation', () => {
    const loader = new EmailTemplateLoader();
    const templatesDir = loader.getTemplatesDir();

    it('templates directory exists and contains all 10 html files', () => {
      expect(fs.existsSync(templatesDir)).toBe(true);
      for (const key of allKeys) {
        const filePath = path.join(templatesDir, `${key}.html`);
        expect(fs.existsSync(filePath)).toBe(true);
      }
    });

    for (const key of allKeys) {
      it(`validates disk template "${key}.html" against its contract`, () => {
        const def = EMAIL_TEMPLATE_REGISTRY[key];
        const loaded = loader.readFilesystemTemplate(key);
        expect(loaded).not.toBeNull();
        expect(loaded!.html.length).toBeGreaterThan(100);

        const validation = validateTemplateContract(def, loaded!.html, def.defaultSubjectTemplate);

        if (!validation.valid) {
          console.error(`Validation failures for ${key}:`, validation.errors);
        }

        expect(validation.valid).toBe(true);
        expect(validation.errors).toHaveLength(0);
      });

      it(`disk template "${key}.html" contains genuine Sumeru branding`, () => {
        const loaded = loader.readFilesystemTemplate(key);
        expect(loaded!.html.includes('Sumeru Global') || loaded!.html.includes('{{companyName}}')).toBe(true);
      });
    }
  });

  describe('3. Template Security Scanner', () => {
    it('detects and blocks <script> tags', () => {
      const dirty = '<div>Hello <script>alert("hack")</script></div>';
      const violations = validateHtmlSecurity(dirty);
      expect(violations.some((v) => v.includes('<script>'))).toBe(true);
    });

    it('detects and blocks <iframe> tags', () => {
      const dirty = '<div><iframe src="https://evil.com"></iframe></div>';
      const violations = validateHtmlSecurity(dirty);
      expect(violations.some((v) => v.includes('<iframe>'))).toBe(true);
    });

    it('detects and blocks <form> tags', () => {
      const dirty = '<div><form action="https://evil.com"><input type="text"/></form></div>';
      const violations = validateHtmlSecurity(dirty);
      expect(violations.some((v) => v.includes('<form>'))).toBe(true);
    });

    it('detects and blocks javascript: URIs', () => {
      const dirty = '<a href="javascript:void(0)">Click here</a>';
      const violations = validateHtmlSecurity(dirty);
      expect(violations.some((v) => v.includes('javascript:'))).toBe(true);
    });

    it('detects and blocks inline event handlers (e.g. onclick, onload, onerror)', () => {
      const dirty1 = '<img src="x" onerror="alert(1)" />';
      expect(validateHtmlSecurity(dirty1).some((v) => v.includes('onerror'))).toBe(true);

      const dirty2 = '<button onclick="run()">Press</button>';
      expect(validateHtmlSecurity(dirty2).some((v) => v.includes('onclick'))).toBe(true);
    });
  });

  describe('4. Token Extraction and Contract Rules', () => {
    const otpDef = EMAIL_TEMPLATE_REGISTRY['otp-verification'];

    it('fails validation when required tokens are missing', () => {
      const incompleteHtml = '<div>Your code is {{otpCode}}, valid for {{validMinutes}} mins.</div>';
      const val = validateTemplateContract(otpDef, incompleteHtml);
      expect(val.valid).toBe(false);
      expect(val.errors.some((e) => e.includes('logoUrl'))).toBe(true);
      expect(val.errors.some((e) => e.includes('supportEmail'))).toBe(true);
    });

    it('fails validation when unknown tokens are introduced', () => {
      const corruptHtml = `
        <img src="{{logoUrl}}" />
        <div>Your code is {{otpCode}}, valid for {{validMinutes}} mins.</div>
        <p>Support: {{supportEmail}}</p>
        <div>Unknown: {{mysteryToken}} and {{maliciousVariable}}</div>
      `;
      const val = validateTemplateContract(otpDef, corruptHtml);
      expect(val.valid).toBe(false);
      expect(val.errors.some((e) => e.includes('mysteryToken'))).toBe(true);
      expect(val.errors.some((e) => e.includes('maliciousVariable'))).toBe(true);
    });

    it('fails validation when raw tokens {{{token}}} are used in sensitive templates', () => {
      const injectionHtml = `
        <img src="{{logoUrl}}" />
        <div>Your code is {{{otpCode}}}, valid for {{validMinutes}} mins.</div>
        <p>Support: {{supportEmail}}</p>
      `;
      const val = validateTemplateContract(otpDef, injectionHtml);
      expect(val.valid).toBe(false);
      expect(val.errors.some((e) => e.includes('prohibits raw HTML tokens'))).toBe(true);
    });

    it('correctly extracts both standard and raw tokens', () => {
      const html = '<div>{{user}} {{email}} {{{bodyContent}}}</div>';
      const extracted = extractTokens(html);
      expect(extracted.standard).toEqual(['email', 'user']);
      expect(extracted.raw).toEqual(['bodyContent']);
    });
  });

  describe('5. HTML Escaping and Safe Interpolation', () => {
    const loader = new EmailTemplateLoader();
    const renderer = new EmailTemplateRenderer(loader);

    it('escapes XML special characters in standard tokens', () => {
      expect(escapeHtml('<script>alert("xss") & \'test\'</script>')).toBe(
        '&lt;script&gt;alert(&quot;xss&quot;) &amp; &#39;test&#39;&lt;/script&gt;',
      );
    });

    it('escapes user input during interpolation on standard tokens', () => {
      const def = EMAIL_TEMPLATE_REGISTRY['otp-verification'];
      const templateStr = '<div>Code: {{otpCode}}, Email: {{supportEmail}}</div>';
      const payload = {
        otpCode: '<123456>',
        validMinutes: '5',
        logoUrl: 'https://app.sumeruglobal.com/logo.png',
        supportEmail: 'test&support@sumeruglobal.com',
      };

      const result = renderer.interpolate(templateStr, payload, def);
      expect(result).toContain('&lt;123456&gt;');
      expect(result).toContain('test&amp;support@sumeruglobal.com');
      expect(result).not.toContain('<123456>');
    });

    it('allows authorized raw tokens on morning-digest while escaping standard tokens', () => {
      const def = EMAIL_TEMPLATE_REGISTRY['morning-digest'];
      const templateStr = '<h1>{{briefDate}}</h1><div>{{{digestSectionsHtml}}}</div>';
      const payload = {
        briefDate: 'Wednesday <Sep 16>',
        subjectCounts: '1 item',
        portalUrl: 'https://app.sumeruglobal.com',
        logoUrl: 'https://app.sumeruglobal.com/logo.png',
        digestSectionsHtml: '<div class="section">Unassigned: 5</div>',
      };

      const result = renderer.interpolate(templateStr, payload, def);
      expect(result).toContain('Wednesday &lt;Sep 16&gt;');
      expect(result).toContain('<div class="section">Unassigned: 5</div>');
    });

    it('throws error when required token is missing from payload during render', () => {
      const def = EMAIL_TEMPLATE_REGISTRY['otp-verification'];
      const templateStr = '<div>Code: {{otpCode}}</div>';
      expect(() => {
        renderer.interpolate(templateStr, { otpCode: '' }, def);
      }).toThrow(/missing required value for token/);
    });
  });

  describe('6. Full End-to-End Render & Fallback Cascade', () => {
    const loader = new EmailTemplateLoader();
    const renderer = new EmailTemplateRenderer(loader);

    for (const key of allKeys) {
      it(`renders "${key}" successfully with valid sampleData`, async () => {
        const def = EMAIL_TEMPLATE_REGISTRY[key];
        const rendered = await renderer.render(key, def.sampleData);

        expect(rendered.html).toBeDefined();
        expect(rendered.html.length).toBeGreaterThan(100);
        expect(rendered.text).toBeDefined();
        expect(rendered.text.length).toBeGreaterThan(20);
        expect(rendered.subject).toBeDefined();
        expect(rendered.subject.length).toBeGreaterThan(5);
        expect(rendered.metadata.templateKey).toBe(key);
        expect(rendered.metadata.isFallback).toBe(false);
      });
    }

    it('cascades to deterministic fallback renderer if corrupt payload provided', async () => {
      const rendered = await renderer.render('otp-verification', {
        // missing required tokens
        otpCode: '',
      });

      expect(rendered.metadata.isFallback).toBe(true);
      expect(rendered.text).toBeDefined();
      expect(rendered.subject).toBeDefined();
    });
  });

  /**
   * Wording that used to be written a second time at the feature call sites.
   *
   * Each call site built its own `renderEmailHtml` copy and then asked the renderer for the
   * template, so the sentence a recipient read depended on which copy won. The call sites now pass
   * data and nothing else, which makes these the only copies — and a sentence a call site used to
   * add (a resend's "any earlier link has stopped working", HR's note when asking for more) must
   * reach the recipient from here, through the built-in fallback AND the shipped HTML.
   */
  describe('7. Occasion-specific wording lives in the registry', () => {
    const loader = new EmailTemplateLoader();
    const renderer = new EmailTemplateRenderer(loader);
    const RESEND = 'Here is a fresh link to complete your Appraiser registration. Any earlier link has stopped working.';
    const invite = (intro?: string) => ({
      fullName: 'Ramesh Kulkarni',
      inviteUrl: 'https://fapoms.example/register/abc123',
      logoUrl: 'https://fapoms.example/sumeru-logo@2x.png',
      companyName: 'Sumeru Global',
      ...(intro ? { intro } : {}),
    });

    it("the invite's fallback says what this link is for, in both halves", () => {
      const fb = EMAIL_TEMPLATE_REGISTRY['registration-invite'].fallbackRenderer(invite(RESEND));
      expect(fb.text).toContain('Any earlier link has stopped working.');
      expect(fb.html).toContain('Any earlier link has stopped working.');
    });

    it('the invite falls back to the first-invitation sentence when no occasion is given', () => {
      const fb = EMAIL_TEMPLATE_REGISTRY['registration-invite'].fallbackRenderer(invite());
      expect(fb.text).toContain('no app required');
    });

    it("the shipped invite HTML carries the occasion too, including HR's note on its own line", async () => {
      const rendered = await renderer.render('registration-invite', invite(
        'HR needs something more before your application can proceed: Attach the shop entity proof.'
          + '\n\nUse the link below to continue where you left off.',
      ));
      expect(rendered.metadata.source).toBe('filesystem');
      expect(rendered.html).toContain('Attach the shop entity proof.');
      expect(rendered.text).toContain('Attach the shop entity proof.');
    });

    it('the shipped approval HTML greets the person by name', async () => {
      const def = EMAIL_TEMPLATE_REGISTRY['application-approved'];
      const rendered = await renderer.render('application-approved', {
        ...def.sampleData, candidateName: 'Ramesh Kulkarni', fullName: 'Ramesh Kulkarni',
      });
      expect(rendered.metadata.source).toBe('filesystem');
      expect(rendered.html).toContain('Hello Ramesh Kulkarni,');
    });

    it('the staff password link says which of its two jobs it is doing, with the username and expiry', () => {
      const data = {
        displayName: 'Priya', username: 'priya.nair', setupUrl: 'https://fapoms.example/account-setup/t0k',
        expiryHours: '72', logoUrl: 'https://fapoms.example/sumeru-logo@2x.png',
      };
      const setup = EMAIL_TEMPLATE_REGISTRY['account-setup-link'].fallbackRenderer(data);
      const reset = EMAIL_TEMPLATE_REGISTRY['password-reset-link'].fallbackRenderer(data);

      expect(setup.subject).toBe('Set up your FAPOMS account');
      expect(setup.text).toContain('An account has been created for you on FAPOMS.');
      expect(setup.html).toContain('Your username is priya.nair.');
      expect(reset.subject).toBe('Reset your FAPOMS password');
      expect(reset.text).toContain('A password reset was requested for your FAPOMS account.');
      for (const fb of [setup, reset]) {
        expect(fb.text).toContain('https://fapoms.example/account-setup/t0k');
        expect(fb.text).toContain('expires in 72 hours');
      }
    });

    it('the second-factor code says what it is for and when it expires', () => {
      const fb = EMAIL_TEMPLATE_REGISTRY['mfa-code'].fallbackRenderer({
        otpCode: '402913', validMinutes: '5', purpose: 'confirm your second factor', logoUrl: 'x',
      });
      expect(fb.text).toBe(
        'Your FAPOMS verification code is 402913. It expires in 5 minutes. '
        + 'Use it to confirm your second factor. If you did not request this, ignore this message.',
      );
      expect(fb.html).toContain('402913');
    });
  });
});
