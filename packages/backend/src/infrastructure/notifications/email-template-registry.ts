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
  | 'branch-audit-paperwork'
  | 'morning-digest';

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
    optionalTokens: ['companyName', 'roleName'],
    rawTokens: [],
    allowRawHtmlTokens: false,
    sampleData: {
      fullName: 'Vikram Mehta',
      inviteUrl: `${appPublicUrl()}/apply/reg_sample_token_839210`,
      logoUrl: `${appPublicUrl()}/sumeru-logo@2x.png`,
      companyName: 'Sumeru Global',
      roleName: 'Gold & Bullion Appraiser',
    },
    fallbackRenderer: (data) => {
      const greeting = data.fullName ? `Hello ${data.fullName},` : 'Hello,';
      const link = String(data.inviteUrl || appPublicUrl());
      const subject = 'Your Appraiser registration link';
      const text = `${greeting}\n\nUse the link below to complete your Appraiser registration — from your phone or any computer, no app required.\n\n${link}`;
      const html = renderEmailHtml({
        title: 'Complete Your Registration',
        bodyLines: [
          greeting,
          'Use the link below to complete your Appraiser registration — from your phone or any computer, no app required.',
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
    requiredTokens: ['assayerCode', 'loginUrl', 'logoUrl'],
    optionalTokens: ['candidateName', 'displayName', 'fullName', 'remarks', 'securityNotice', 'status', 'companyName'],
    rawTokens: [],
    allowRawHtmlTokens: false,
    sampleData: {
      assayerCode: 'ASY-2026-0842',
      loginUrl: `${appPublicUrl()}/login`,
      logoUrl: `${appPublicUrl()}/sumeru-logo@2x.png`,
      candidateName: 'Pooja Sharma',
      status: 'Active Roster Ready',
      companyName: 'Sumeru Global',
    },
    fallbackRenderer: (data) => {
      const greeting = data.candidateName ? `Hello ${data.candidateName},` : 'Hello,';
      const assayerCode = String(data.assayerCode || '');
      const subject = 'Your Appraiser application has been approved';
      const text = `${greeting}\n\nYour application has been approved. Your Appraiser code is ${assayerCode}. HR will be in touch about next steps.`;
      const html = renderEmailHtml({
        title: 'Application Approved — Welcome to Sumeru Global',
        bodyLines: [
          greeting,
          'Congratulations! Your application has been approved. You have been officially registered as an authorized Appraiser in our network.',
          'Our operations team will be in touch shortly regarding branch roster assignments and field audit schedules.',
        ],
        kvTable: [
          { label: 'Official Appraiser Code', value: assayerCode },
          { label: 'Registered Name', value: String(data.candidateName || data.displayName || data.fullName || '—') },
          { label: 'Status', value: String(data.status || 'Active Roster Ready') },
        ],
        linkUrl: String(data.loginUrl || appPublicUrl()),
        linkLabel: 'Sign in to FAPOMS',
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
    optionalTokens: ['companyName'],
    rawTokens: ['digestSectionsHtml'],
    allowRawHtmlTokens: true,
    sampleData: {
      subjectCounts: '3 Overdue · 1 Approval',
      briefDate: 'Wednesday, September 16, 2026',
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
      const text = `FAPOMS Operations Morning Brief\nDate: ${data.briefDate || ''}\n\nPlease review items requiring attention in the FAPOMS portal:\n${data.portalUrl || appPublicUrl()}`;
      const html = renderEmailHtml({
        title: 'Operations Morning Brief',
        bodyLines: [
          `Date: ${data.briefDate || 'Today'}`,
          'Here is the executive summary of operational items requiring management review:',
        ],
        linkUrl: String(data.portalUrl || appPublicUrl()),
        linkLabel: 'Open Operations Desk',
      });
      return { html, text, subject };
    },
  },
};
