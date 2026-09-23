/**
 * FAPOMS — Email Template Registry
 *
 * Strongly-typed contracts for all transactional and operational email templates in the platform.
 * Defines required tokens, optional tokens, permitted raw tokens, sample payloads for preview,
 * and deterministic fallback renderers.
 */

import { appPublicUrl, renderEmailHtml } from './email-provider';

export type EmailTemplateKey =
  | 'otp-verification'
  | 'registration-invite'
  | 'app-credentials'
  | 'application-approved'
  | 'application-rejected'
  | 'application-info-requested'
  | 'reference-notice'
  | 'branch-audit-paperwork'
  | 'morning-digest'
  | 'account-setup-link'
  | 'password-reset-link'
  | 'mfa-code';

export interface EmailTemplateDefinition<T = Record<string, any>> {
  key: EmailTemplateKey;
  name: string;
  category?: string;
  description: string;
  defaultSubjectTemplate: string;
  requiredTokens: readonly string[];
  optionalTokens?: readonly string[];
  rawTokens?: readonly string[];
  allowRawHtmlTokens?: boolean;
  sampleData: T;
  fallbackRenderer: (data: T) => { html: string; text: string; subject: string };
}

/**
 * What a first invitation says above its button. The registration invite's `intro` token carries
 * a different sentence on the other occasions a link is sent (a resend, a request for more
 * information), so the caller passes this one explicitly for a first invite — the shipped HTML has
 * no way to fall back to it on its own.
 */
export const REGISTRATION_INVITE_INTRO = 'Use the link below to complete your Appraiser '
  + 'registration — from your phone or any computer, no app required.';

/**
 * The staff password link, in its two variants. Two templates rather than one with a switch,
 * because an administrator editing "the reset email" should not be able to change the new-account
 * one by accident — but one builder, so the two cannot drift in the parts they share.
 */
function passwordLinkEmail(
  variant: 'NEW_ACCOUNT' | 'RESET',
  data: Record<string, any>,
): { html: string; text: string; subject: string } {
  const newAccount = variant === 'NEW_ACCOUNT';
  const greeting = `Hello ${data.displayName || 'there'},`;
  const link = String(data.setupUrl || appPublicUrl());
  const hours = String(data.expiryHours || '72');
  const intro = newAccount
    ? 'An account has been created for you on FAPOMS. Choose a password to finish setting it up.'
    : 'A password reset was requested for your FAPOMS account. Choose a new password below.';
  const subject = newAccount ? 'Set up your FAPOMS account' : 'Reset your FAPOMS password';
  const text = `${greeting}\n\n${intro}\n\n${link}\n\nThe link works once and expires in ${hours} hours.`;
  const html = renderEmailHtml({
    title: newAccount ? 'Set up your account' : 'Reset your password',
    bodyLines: [
      greeting,
      intro,
      ...(data.username ? [`Your username is ${data.username}.`] : []),
      `This link works once and expires in ${hours} hours.`,
    ],
    linkUrl: link,
    linkLabel: newAccount ? 'Choose my password' : 'Set a new password',
    securityNotice: 'If you were not expecting this, ignore it and tell your administrator — '
      + 'nothing changes until somebody uses the link.',
  });
  return { html, text, subject };
}

export const EMAIL_TEMPLATE_REGISTRY: Record<EmailTemplateKey, EmailTemplateDefinition> = {
  'otp-verification': {
    key: 'otp-verification',
    name: 'Registration OTP Verification',
    category: 'Security',
    description: 'Sent to verify an appraiser candidate email address during self-onboarding.',
    defaultSubjectTemplate: 'Your Appraiser registration code',
    requiredTokens: ['otpCode', 'validMinutes', 'logoUrl', 'supportEmail'],
    optionalTokens: ['greeting', 'companyName'],
    rawTokens: [],
    allowRawHtmlTokens: false,
    sampleData: {
      otpCode: '849201',
      validMinutes: '5',
      logoUrl: `${appPublicUrl()}/sumeru-logo@2x.png`,
      supportEmail: 'recruitment@sumeruglobal.com',
      greeting: 'Hello,',
      companyName: 'Sumeru Global',
    },
    fallbackRenderer: (data) => {
      const otpCode = String(data.otpCode || '');
      const validMinutes = String(data.validMinutes || '5');
      const subject = 'Your Appraiser registration code';
      const text = `Your Appraiser registration verification code is ${otpCode}. It expires in ${validMinutes} minutes.`;
      const html = renderEmailHtml({
        title: 'Verification Code',
        bodyLines: [
          'Please enter the 6-digit code below to verify your email address and continue your Sumeru Global appraiser registration.',
        ],
        otpCode,
        securityNotice: `This code expires in ${validMinutes} minutes. If you did not request this, you can safely ignore this email.`,
      });
      return { html, text, subject };
    },
  },

  'registration-invite': {
    key: 'registration-invite',
    name: 'Candidate Registration Invitation',
    category: 'Recruitment',
    description: 'Invitation sent to prospective appraisers with unique token link to complete registration.',
    defaultSubjectTemplate: 'Your Appraiser registration link',
    requiredTokens: ['fullName', 'inviteUrl', 'logoUrl'],
    /**
     * `intro` is what this particular link is for: a first invitation, a fresh link that replaces
     * one which stopped working, or HR asking for something more (with what they asked for).
     */
    optionalTokens: ['companyName', 'roleName', 'intro'],
    rawTokens: [],
    allowRawHtmlTokens: false,
    sampleData: {
      fullName: 'Vikram Mehta',
      inviteUrl: `${appPublicUrl()}/apply/reg_sample_token_839210`,
      logoUrl: `${appPublicUrl()}/sumeru-logo@2x.png`,
      companyName: 'Sumeru Global',
      roleName: 'Gold & Bullion Appraiser',
      intro: REGISTRATION_INVITE_INTRO,
    },
    fallbackRenderer: (data) => {
      const greeting = data.fullName ? `Hello ${data.fullName},` : 'Hello,';
      const link = String(data.inviteUrl || appPublicUrl());
      const intro = String(data.intro || REGISTRATION_INVITE_INTRO);
      const subject = 'Your Appraiser registration link';
      const text = `${greeting}\n\n${intro}\n\n${link}`;
      const html = renderEmailHtml({
        title: 'Complete Your Registration',
        bodyLines: [
          greeting,
          // A request for more information carries HR's note as its own paragraph.
          ...intro.split(/\n+/).map((line) => line.trim()).filter(Boolean),
          'Click the button below to complete your profile and upload verification documents from your phone or computer.',
        ],
        linkUrl: link,
        linkLabel: 'Complete Registration',
        securityNotice: 'This registration link is personalized for you. Do not forward or share it.',
      });
      return { html, text, subject };
    },
  },

  'app-credentials': {
    key: 'app-credentials',
    name: 'App Access Credentials',
    category: 'Provisioning',
    description: 'Sent when an administrator issues mobile app access credentials to an appraiser.',
    defaultSubjectTemplate: 'Your FAPOMS app access',
    requiredTokens: ['displayName', 'username', 'temporaryPassword', 'validDays', 'loginUrl', 'logoUrl'],
    optionalTokens: ['securityNotice', 'companyName', 'supportEmail'],
    rawTokens: [],
    allowRawHtmlTokens: false,
    sampleData: {
      displayName: 'Rajesh Kumar',
      username: 'RAJESH.KUMAR',
      temporaryPassword: 'ember-falcon-729',
      validDays: '7',
      loginUrl: appPublicUrl(),
      logoUrl: `${appPublicUrl()}/sumeru-logo@2x.png`,
      companyName: 'Sumeru Global',
      securityNotice: 'Do not share your temporary credentials with anyone. Sumeru Global personnel will never ask for your password.',
      supportEmail: 'audit-ops@sumeruglobal.com',
    },
    fallbackRenderer: (data) => {
      const displayName = String(data.displayName || 'Appraiser');
      const username = String(data.username || '');
      const tempPass = String(data.temporaryPassword || '');
      const validDays = String(data.validDays || '7');
      const loginUrl = String(data.loginUrl || appPublicUrl());
      const subject = 'Your FAPOMS app access';
      const text =
        `Your FAPOMS sign-in is ${username} and your temporary password is ` +
        `${tempPass}. It works for ${validDays} days and you will be asked to choose ` +
        'your own password the first time you sign in.';
      const html = renderEmailHtml({
        title: 'Your FAPOMS App Access Credentials',
        bodyLines: [
          `Hello ${displayName},`,
          'Your authorized account for the Sumeru Global Field Assayer & Portfolio Operations Management mobile application has been provisioned.',
          'Use the temporary credentials below to sign in. You will be asked to set your own password upon first login.',
        ],
        kvTable: [
          { label: 'Username / Appraiser ID', value: username },
          { label: 'Temporary Password', value: tempPass },
          { label: 'Validity Period', value: `${validDays} calendar days` },
        ],
        linkUrl: loginUrl,
        linkLabel: 'Access FAPOMS Portal',
        securityNotice: data.securityNotice || 'Do not share your temporary credentials with anyone. Sumeru Global personnel will never ask for your password.',
      });
      return { html, text, subject };
    },
  },

  'application-approved': {
    key: 'application-approved',
    name: 'Application Approval & Code Issuance',
    category: 'Recruitment',
    description: 'Notice of approval and official appraiser code issuance sent to successfully verified candidates.',
    defaultSubjectTemplate: 'Your Appraiser application has been approved',
    /**
     * `appDownloadUrl`, not `loginUrl`. This letter used to end in a "Sign in to FAPOMS" button
     * pointing at the web root — which is the wrong door twice over: the web app has no appraiser
     * surface at all, and at the moment this is sent the reader has a code but not yet the
     * password that arrives in their `app-credentials` message. The button is now the app itself.
     *
     * `loginUrl` stays DECLARED so an administrator's published version that still uses it keeps
     * validating as a known token rather than being rejected outright — but it is no longer
     * required, and a version without `appDownloadUrl` is now correctly treated as broken: an
     * approval letter that does not say where to get the app is missing the only thing the reader
     * has to act on.
     */
    requiredTokens: ['assayerCode', 'appDownloadUrl', 'logoUrl'],
    optionalTokens: [
      'candidateName', 'displayName', 'fullName', 'remarks', 'securityNotice', 'status',
      'companyName', 'loginUrl',
      // Emitted by the visual editor's layout for this template (`email-template-html.ts`) and
      // never declared, so anything built there failed contract validation on publish.
      'effectiveDate',
    ],
    rawTokens: [],
    allowRawHtmlTokens: false,
    sampleData: {
      assayerCode: 'ASY-2026-0842',
      appDownloadUrl: `${appPublicUrl()}/download/app.apk`,
      logoUrl: `${appPublicUrl()}/sumeru-logo@2x.png`,
      candidateName: 'Pooja Sharma',
      // The shipped HTML greets and names the person by this token.
      fullName: 'Pooja Sharma',
      status: 'Active Roster Ready',
      companyName: 'Sumeru Global',
    },
    fallbackRenderer: (data) => {
      const greeting = data.candidateName ? `Hello ${data.candidateName},` : 'Hello,';
      const assayerCode = String(data.assayerCode || '');
      const subject = 'Your Appraiser application has been approved';
      const text = `${greeting}\n\nYour application has been approved. Your Appraiser code is ${assayerCode}.\n\n`
        + 'Install the appraiser app on your phone: '
        + `${String(data.appDownloadUrl || appPublicUrl())}\n\n`
        + 'Your sign-in details — your username and a temporary password — are sent to you in a '
        + 'separate message. HR will be in touch about next steps.';
      const html = renderEmailHtml({
        title: 'Application Approved — Welcome to Sumeru Global',
        bodyLines: [
          greeting,
          'Congratulations! Your application has been approved. You have been officially registered as an authorized Appraiser in our network.',
          'Install the appraiser app on your phone using the button below. Your sign-in details — your username and a temporary password — are sent to you in a separate message.',
          'Our operations team will be in touch shortly regarding branch roster assignments and field audit schedules.',
        ],
        kvTable: [
          { label: 'Official Appraiser Code', value: assayerCode },
          { label: 'Registered Name', value: String(data.candidateName || data.displayName || data.fullName || '—') },
          { label: 'Status', value: String(data.status || 'Active Roster Ready') },
        ],
        linkUrl: String(data.appDownloadUrl || appPublicUrl()),
        linkLabel: 'Get the appraiser app',
        securityNotice: data.securityNotice || `Keep your Appraiser code (${assayerCode}) confidential. It is required during bank branch audit verification.`,
      });
      return { html, text, subject };
    },
  },

  'application-rejected': {
    key: 'application-rejected',
    name: 'Application Review Decision',
    category: 'Recruitment',
    description: 'Sent when an application is rejected during document verification or background vetting.',
    defaultSubjectTemplate: 'Your Appraiser application',
    requiredTokens: ['fullName', 'reviewNotes', 'supportEmail', 'logoUrl'],
    optionalTokens: ['companyName', 'greeting'],
    rawTokens: [],
    allowRawHtmlTokens: false,
    sampleData: {
      fullName: 'Rajesh Kumar',
      reviewNotes: 'Document resolution insufficient. Government ID photograph and signature specimen do not meet mandatory BIS audit criteria.',
      supportEmail: 'recruitment@sumeruglobal.com',
      logoUrl: `${appPublicUrl()}/sumeru-logo@2x.png`,
      companyName: 'Sumeru Global',
      greeting: 'Hello Rajesh Kumar,',
    },
    fallbackRenderer: (data) => {
      const greeting = data.greeting || (data.fullName ? `Hello ${data.fullName},` : 'Hello,');
      const notes = String(data.reviewNotes || 'Does not meet minimum criteria at this time.');
      const supportEmail = String(data.supportEmail || 'recruitment@sumeruglobal.com');
      const subject = 'Your Appraiser application';
      const text = `${greeting}\n\nAfter review, we are unable to proceed with your application at this time.\n\nReason: ${notes}`;
      const html = renderEmailHtml({
        title: 'Application Status Update',
        bodyLines: [
          greeting,
          'Thank you for your interest in joining Sumeru Global. After reviewing your application dossier and submitted credentials, our verification committee is unable to proceed with your onboarding at this time.',
        ],
        callout: {
          title: 'Review Remarks',
          text: notes,
          tone: 'crimson',
        },
        footer: `Questions regarding this decision may be directed to ${supportEmail}.`,
      });
      return { html, text, subject };
    },
  },

  'reference-notice': {
    key: 'reference-notice',
    name: 'Reference Heads-up',
    category: 'Recruitment',
    description: 'Tells somebody a candidate named as a reference that HR may call them. Sent when the candidate is approved.',
    defaultSubjectTemplate: 'You have been named as a reference',
    // Every reference carries a name — the form refuses one without — so the greeting can rely on it.
    requiredTokens: ['refereeName', 'candidateName', 'contactLine', 'logoUrl'],
    optionalTokens: ['companyName'],
    rawTokens: [],
    allowRawHtmlTokens: false,
    sampleData: {
      candidateName: 'Ramesh Kulkarni',
      refereeName: 'Meera Rao',
      contactLine: 'Priya Nair, grievance officer — privacy@sumeruglobal.com',
      logoUrl: `${appPublicUrl()}/sumeru-logo@2x.png`,
      companyName: 'Sumeru Global',
    },
    /*
      What it says, and what it deliberately does not. The referee learns who named them, why we
      hold their details and who to write to — the notice a person is owed when somebody else hands
      us their contact details. Nothing else about the candidate: no phone, no role detail, nothing a
      referee needs in order to take a call.
    */
    fallbackRenderer: (data) => {
      const greeting = data.refereeName ? `Hello ${data.refereeName},` : 'Hello,';
      const candidate = String(data.candidateName || 'A candidate');
      const contact = String(data.contactLine || 'the office that contacted you');
      const subject = 'You have been named as a reference';
      const lines = [
        greeting,
        `${candidate} has named you as a professional reference in their application to join Sumeru Global as an appraiser.`,
        'A member of our HR team may call you shortly to ask a few questions about them. You do not need to do anything now.',
        `They gave us your name and contact details for this reason only, and we keep them with their record. If you do not know them, or would rather not be contacted, write to ${contact} and we will stop.`,
      ];
      const text = lines.join('\n\n');
      const html = renderEmailHtml({ title: 'You Have Been Named As A Reference', bodyLines: lines });
      return { html, text, subject };
    },
  },

  'application-info-requested': {
    key: 'application-info-requested',
    name: 'Application Needs Your Attention',
    category: 'Recruitment',
    description: 'Sent when HR asks a candidate for specific documents or corrections. Carries the item list, never a link — the candidate reopens the registration link they already hold.',
    defaultSubjectTemplate: 'Action needed: your Appraiser application',
    requiredTokens: ['fullName', 'itemsText', 'supportEmail', 'logoUrl'],
    optionalTokens: ['companyName', 'greeting'],
    rawTokens: [],
    allowRawHtmlTokens: false,
    sampleData: {
      fullName: 'Rajesh Kumar',
      itemsText: '• PAN card: The photo was too blurred to read. Please take it again in better light.\n• Bank account number: Please check and correct this field.',
      supportEmail: 'recruitment@sumeruglobal.com',
      logoUrl: `${appPublicUrl()}/sumeru-logo@2x.png`,
      companyName: 'Sumeru Global',
      greeting: 'Hello Rajesh Kumar,',
    },
    fallbackRenderer: (data) => {
      const greeting = data.greeting || (data.fullName ? `Hello ${data.fullName},` : 'Hello,');
      const items = String(data.itemsText || 'Please review your application details.');
      const supportEmail = String(data.supportEmail || 'recruitment@sumeruglobal.com');
      const subject = 'Action needed: your Appraiser application';
      const text = `${greeting}\n\nHR reviewed your application and needs a few specific things before it can proceed. Open your registration link — the same one you applied with — and fix only what is listed:\n\n${items}\n\nOnce done, submit again from the same link.`;
      const html = renderEmailHtml({
        title: 'Action Needed On Your Application',
        bodyLines: [
          greeting,
          'HR reviewed your application and needs a few specific things before it can proceed. Open your registration link — the same one you applied with — and fix only what is listed below.',
        ],
        callout: {
          title: 'What HR asked for',
          text: items,
          tone: 'gold',
        },
        footer: `Once done, submit again from the same link. Questions? Write to ${supportEmail}.`,
      });
      return { html, text, subject };
    },
  },

  'branch-audit-paperwork': {
    key: 'branch-audit-paperwork',
    name: 'Branch Audit Documentation',
    category: 'Operations',
    description: 'Automated dispatch of confidential branch audit schedule paperwork and appraisal attachments.',
    defaultSubjectTemplate: 'Audit paperwork — {{fileName}}',
    requiredTokens: ['fileName', 'documentType', 'logoUrl'],
    optionalTokens: ['branchName', 'securityNotice', 'companyName'],
    rawTokens: [],
    allowRawHtmlTokens: false,
    sampleData: {
      fileName: 'Audit_Packet_HDFC_Fort_2026-09-16.pdf',
      documentType: 'Bullion Audit Schedule',
      branchName: 'HDFC Bank — Fort Branch, Mumbai',
      logoUrl: `${appPublicUrl()}/sumeru-logo@2x.png`,
      securityNotice: 'Confidential bank audit paperwork. Access is restricted to authorized bank branch personnel and certified Sumeru Global auditors.',
      companyName: 'Sumeru Global',
    },
    fallbackRenderer: (data) => {
      const branchName = data.branchName ? String(data.branchName) : null;
      const fileName = String(data.fileName || 'Audit_Paperwork.pdf');
      const documentType = String(data.documentType || 'Audit Packet');
      const subject = branchName ? `Audit paperwork for ${branchName}` : `Audit paperwork — ${fileName}`;
      const text = [
        branchName ? `Audit paperwork for ${branchName} is attached.` : 'Audit paperwork is attached.',
        '',
        'Our appraiser will collect it from your branch when they arrive for the audit.',
        '',
        'This message was sent automatically. Please do not reply.',
      ].join('\n');
      const html = renderEmailHtml({
        title: 'Audit Documentation Packet',
        bodyLines: [
          branchName
            ? `The official field audit documentation packet for ${branchName} is attached to this transmission.`
            : 'The official field audit documentation packet is attached to this transmission.',
          'Our assigned Sumeru Global certified appraiser will collect and cross-reference this paperwork upon arrival at the branch for the scheduled audit.',
        ],
        kvTable: [
          { label: 'Attached File', value: fileName },
          { label: 'Document Type', value: documentType },
          ...(branchName ? [{ label: 'Target Branch', value: branchName }] : []),
        ],
        securityNotice: data.securityNotice || 'Confidential bank audit paperwork. Access is restricted to authorized bank branch personnel and certified Sumeru Global auditors.',
      });
      return { html, text, subject };
    },
  },

  'morning-digest': {
    key: 'morning-digest',
    name: 'Operations Morning Brief',
    category: 'Operations',
    description: 'Executive daily morning brief summarizing SLA breaches, overdue submissions, and pending approvals.',
    defaultSubjectTemplate: 'FAPOMS morning brief — {{subjectCounts}}',
    requiredTokens: ['subjectCounts', 'briefDate', 'portalUrl', 'logoUrl', 'digestSectionsHtml'],
    // The same sections as plain text, one line each. The built-in fallback cannot use the raw HTML
    // token safely, and without this it sent a generic "please review items" email with none of the
    // headings, items or links the brief exists to deliver.
    optionalTokens: ['companyName', 'digestSectionsText'],
    rawTokens: ['digestSectionsHtml'],
    allowRawHtmlTokens: true,
    sampleData: {
      subjectCounts: '3 Overdue · 1 Approval',
      briefDate: 'Wednesday, September 16, 2026',
      digestSectionsText: 'Desk SLA Breaches (2)\n• Fort Branch: Gold appraisal report overdue by 48 hours\n• Andheri Branch: Pending counter-party verification\nHR Verification Queue (1)\n• Candidate Rajesh Kumar awaiting final empanelment approval',
      portalUrl: `${appPublicUrl()}/operations`,
      logoUrl: `${appPublicUrl()}/sumeru-logo@2x.png`,
      companyName: 'Sumeru Global',
      digestSectionsHtml: `
        <div style="margin-bottom:16px;">
          <div style="font-weight:600;color:#111827;font-size:13px;margin-bottom:6px;">Desk SLA Breaches (2)</div>
          <div style="font-size:13px;color:#4B5563;line-height:1.6;padding-left:12px;border-left:2px solid #ED6714;">
            &bull; Fort Branch: Gold appraisal report overdue by 48 hours<br>
            &bull; Andheri Branch: Pending counter-party verification
          </div>
        </div>
        <div>
          <div style="font-weight:600;color:#111827;font-size:13px;margin-bottom:6px;">HR Verification Queue (1)</div>
          <div style="font-size:13px;color:#4B5563;line-height:1.6;padding-left:12px;border-left:2px solid #10B981;">
            &bull; Candidate Rajesh Kumar awaiting final empanelment approval
          </div>
        </div>`,
    },
    fallbackRenderer: (data) => {
      const subjectCounts = String(data.subjectCounts || 'Operations Brief');
      const subject = `FAPOMS morning brief — ${subjectCounts}`;
      const sectionLines = String(data.digestSectionsText || '').split('\n').map((l) => l.trim()).filter(Boolean);
      const text = `FAPOMS Operations Morning Brief\nDate: ${data.briefDate || ''}\n\n`
        + (sectionLines.length ? `${sectionLines.join('\n')}\n\n` : 'Please review items requiring attention in the FAPOMS portal:\n')
        + `${data.portalUrl || appPublicUrl()}`;
      const html = renderEmailHtml({
        title: 'Operations Morning Brief',
        bodyLines: [
          `Date: ${data.briefDate || 'Today'}`,
          'Here is the executive summary of operational items requiring management review:',
          ...sectionLines,
        ],
        linkUrl: String(data.portalUrl || appPublicUrl()),
        linkLabel: 'Open Operations Desk',
      });
      return { html, text, subject };
    },
  },

  'account-setup-link': {
    key: 'account-setup-link',
    name: 'Staff Account Setup Link',
    category: 'Provisioning',
    description: 'Sent when a staff account is created: a single-use link for the person to choose their own password.',
    defaultSubjectTemplate: 'Set up your FAPOMS account',
    requiredTokens: ['displayName', 'username', 'setupUrl', 'expiryHours', 'logoUrl'],
    optionalTokens: ['companyName'],
    rawTokens: [],
    allowRawHtmlTokens: false,
    sampleData: {
      displayName: 'Priya',
      username: 'priya.nair',
      setupUrl: `${appPublicUrl()}/account-setup/sample_setup_token_5b21`,
      expiryHours: '72',
      logoUrl: `${appPublicUrl()}/sumeru-logo@2x.png`,
      companyName: 'Sumeru Global',
    },
    fallbackRenderer: (data) => passwordLinkEmail('NEW_ACCOUNT', data),
  },

  'password-reset-link': {
    key: 'password-reset-link',
    name: 'Staff Password Reset Link',
    category: 'Security',
    description: 'Sent when an administrator resets a staff password: a single-use link to choose a new one.',
    defaultSubjectTemplate: 'Reset your FAPOMS password',
    requiredTokens: ['displayName', 'username', 'setupUrl', 'expiryHours', 'logoUrl'],
    optionalTokens: ['companyName'],
    rawTokens: [],
    allowRawHtmlTokens: false,
    sampleData: {
      displayName: 'Priya',
      username: 'priya.nair',
      setupUrl: `${appPublicUrl()}/account-setup/sample_reset_token_9c47`,
      expiryHours: '72',
      logoUrl: `${appPublicUrl()}/sumeru-logo@2x.png`,
      companyName: 'Sumeru Global',
    },
    fallbackRenderer: (data) => passwordLinkEmail('RESET', data),
  },

  'mfa-code': {
    key: 'mfa-code',
    name: 'Second-Factor Verification Code',
    category: 'Security',
    description: 'One-time code for a user who signs in with, or is confirming, an email second factor.',
    defaultSubjectTemplate: 'Your FAPOMS verification code',
    requiredTokens: ['otpCode', 'validMinutes', 'purpose', 'logoUrl'],
    optionalTokens: ['companyName'],
    rawTokens: [],
    allowRawHtmlTokens: false,
    sampleData: {
      otpCode: '402913',
      validMinutes: '5',
      purpose: 'sign in',
      logoUrl: `${appPublicUrl()}/sumeru-logo@2x.png`,
      companyName: 'Sumeru Global',
    },
    fallbackRenderer: (data) => {
      const otpCode = String(data.otpCode || '');
      const validMinutes = String(data.validMinutes || '5');
      const purpose = String(data.purpose || 'sign in');
      const subject = 'Your FAPOMS verification code';
      const text = `Your FAPOMS verification code is ${otpCode}. It expires in ${validMinutes} minutes. `
        + `Use it to ${purpose}. If you did not request this, ignore this message.`;
      const html = renderEmailHtml({
        title: 'Verification Code',
        bodyLines: [`Use the code below to ${purpose}.`],
        otpCode,
        securityNotice: `This code expires in ${validMinutes} minutes. If you did not request this, ignore this message.`,
      });
      return { html, text, subject };
    },
  },
};
