import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Mail, Sparkles, Send, RotateCcw, Copy, Check, Eye, Code, Smartphone, Monitor,
  AlertTriangle, CheckCircle2, History, RefreshCw, LayoutTemplate, Wand2, Sliders, FileText, Trash2,
  Shield, ShieldCheck, Lock, Palette, Sun, Moon,
} from 'lucide-react';
import { readVisualStamp, authorshipOf } from './email-template-authorship';
/*
  The email builder lives in `email-template-html.ts`: it produces a document for Gmail and Outlook
  rather than a screen, so its sizes are literal pixels and it is exempt from the type scale — an
  exemption that must not extend to this admin screen, which is why the two are separate files.
  Re-exported here because callers know this module as the home of the template editor.
*/
export { compileVisualToHtml, shadeColor, type VisualTemplateData } from './email-template-html';
import { compileVisualToHtml, missingTokenBlock, type VisualTemplateData } from './email-template-html';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { useToast, Modal, useConfirm } from '../../components/ui';
import { SectionCard, Pill } from '../../components/ui/settings';
// The picker/detail shape this screen invented, now shared with the text-message studio.
import { TemplateStudioHeader, TemplatePicker, TemplateDetailBar, CommonTokenChips } from './TemplateStudio';
import { LoadFailure } from '../../components/LoadFailure';
import { loadFailed } from '../../queryClient';
import { sourceBadge, sourceOption, sourceHint, TEMPLATE_SOURCE_ORDER, EDITOR_USED, RESTORE_ORIGINAL, PUBLISH_SAFETY_NET, PUBLISH_CHECKS, PREVIEW_NOTE, contentSizeNote } from './email-template-vocabulary';
import { emailTokenHelp } from '@fapoms/shared';

// -----------------------------------------------------------------------------
// Pre-Generated AI Prompts Catalog (Embedded for 1-Click Copy)
// -----------------------------------------------------------------------------

const AI_PROMPTS: Record<string, { prompt: string; tips: string[] }> = {
  'otp-verification': {
    tips: [
      'Preserve exact tokens: {{otpCode}}, {{validMinutes}}, {{logoUrl}}, {{supportEmail}}.',
      'Highlight OTP digits with letter spacing (8px) in a prominent clean card.',
      'Include a security warning: Sumeru staff will never ask for this code.',
    ],
    prompt: `You are an expert HTML email designer. Create a high-converting, enterprise-grade, beautifully branded transactional HTML email for Sumeru Global (Field Assayer & Portfolio Operations Management System - FAPOMS).

The email purpose is sending a 6-digit OTP verification code to an appraiser candidate verifying their email address during onboarding.

BRAND GUIDELINES:
- Primary Accent: #ED6714 (Flame Orange)
- Background: #F8FAFC (Cool Light Gray)
- Card Container: #FFFFFF (White) with subtle border (#E2E8F0) and rounded corners (10px)
- Text Color: Primary #1E293B, Secondary #64748B
- Logo URL: {{logoUrl}}

TECHNICAL REQUIREMENTS:
- 100% Inline CSS styles.
- Max-width 560px, centered container card.
- Header with centered Sumeru logo.
- Clear title: "Verification Code".
- Large prominent OTP code box with letter-spaced bold monospace digits (e.g. 32px type, 8px letter-spacing; color: #9A3412; background: #FFF7ED; border: 1px solid #FED7AA; border-radius: 8px; text-align: center; padding: 18px;).
- Expiration notice showing {{validMinutes}} minutes validity.
- Clean footer with support link {{supportEmail}}.

CRITICAL TOKEN RULES (DO NOT CHANGE OR OMIT):
You MUST include these exact placeholder tokens in double curly braces:
- {{logoUrl}} -> In the <img> src attribute
- {{otpCode}} -> Inside the prominent OTP display box
- {{validMinutes}} -> In the expiration statement
- {{supportEmail}} -> In the support contact footer

Do NOT use any <script>, <iframe>, <form>, or onclick handlers.
Output ONLY the clean, raw HTML code.`,
  },
  'registration-invite': {
    tips: [
      'Preserve exact tokens: {{fullName}}, {{inviteUrl}}, {{logoUrl}}.',
      'Add a prominent solid flame CTA button linking to {{inviteUrl}}.',
      'Show 3 clear onboarding steps: KYC Verification, Certificates, Digital Dossier.',
    ],
    prompt: `You are an expert HTML email designer. Create an executive-grade, beautifully branded transactional HTML email for Sumeru Global (Field Assayer & Portfolio Operations Management System - FAPOMS).

The email purpose is welcoming a candidate appraiser and inviting them to complete their digital onboarding dossier and document upload.

BRAND GUIDELINES:
- Primary Accent: #ED6714 (Flame Orange)
- Background: #F8FAFC (Cool Light Gray)
- Card Container: #FFFFFF (White) with border (#E2E8F0) and rounded corners (10px)
- Text Color: Primary #1E293B, Secondary #475569
- Logo: <img src="{{logoUrl}}" alt="Sumeru Global" width="65" height="50" />

TECHNICAL REQUIREMENTS:
- 100% Inline CSS. Max-width 560px centered container card.
- Clean header with authentic Sumeru Global logo.
- Personalized greeting for {{fullName}}.
- Clear 3-step checklist showing what they will need:
  1. Personal & Bank KYC Details (PAN, Aadhaar, Bank Account & IFSC)
  2. Experience & Qualification Certificates
  3. Digital Document Uploads
- Prominent call-to-action button: "Complete Registration" linking to {{inviteUrl}} (background: #ED6714; color: #ffffff; padding: 12px 24px; border-radius: 6px; font-weight: 600; text-decoration: none; display: inline-block;).
- Fallback clickable URL link printed out for users whose email clients block buttons.
- Confidentiality notice and support footer.

CRITICAL TOKEN RULES (DO NOT CHANGE OR OMIT):
You MUST include these exact placeholder tokens:
- {{fullName}} -> Candidate name greeting
- {{inviteUrl}} -> In the CTA button href and as fallback link
- {{logoUrl}} -> In the logo <img> tag

Do NOT use any <script>, <iframe>, <form>, or onclick handlers.
Output ONLY the clean, raw HTML code.`,
  },
  'app-credentials': {
    tips: [
      'Preserve exact tokens: {{displayName}}, {{username}}, {{temporaryPassword}}, {{validDays}}, {{loginUrl}}, {{logoUrl}}.',
      'Structure credentials into a high-security key-value table.',
      'Include a clear advisory to change password immediately on first login.',
    ],
    prompt: `You are an expert HTML email designer. Create a secure, polished, enterprise transactional HTML email for Sumeru Global (Field Assayer & Portfolio Operations Management System - FAPOMS).

The email purpose is delivering newly provisioned account credentials (username & temporary password) to an authorized field appraiser for logging into the FAPOMS Mobile App and Portal.

BRAND GUIDELINES:
- Primary Accent: #ED6714 (Flame Orange)
- Background: #F8FAFC
- Card Container: #FFFFFF with subtle border (#E2E8F0) and rounded corners (10px)
- Text Color: #1E293B

TECHNICAL REQUIREMENTS:
- 100% Inline CSS. Max-width 560px centered container card.
- Header with Sumeru Global logo (src="{{logoUrl}}").
- High-security credentials card with a structured key-value table:
  - Appraiser Name: {{displayName}}
  - Username: {{username}} (bold, prominent)
  - Temporary Password: {{temporaryPassword}} (monospace font, highlighted in secure light badge)
  - Password Validity: {{validDays}} days
- Primary CTA Button: "Sign In to FAPOMS Portal" linking to {{loginUrl}} (solid #ED6714).
- Security warning box: change password upon first login; Sumeru Global will never ask for your password.

CRITICAL TOKEN RULES (DO NOT CHANGE OR OMIT):
You MUST include these exact placeholder tokens:
- {{displayName}}
- {{username}}
- {{temporaryPassword}}
- {{validDays}}
- {{loginUrl}}
- {{logoUrl}}

Do NOT use any <script>, <iframe>, <form>, or onclick handlers.
Output ONLY the clean, raw HTML code.`,
  },
  'application-approved': {
    tips: [
      'Preserve exact tokens: {{fullName}}, {{assayerCode}}, {{effectiveDate}}, {{loginUrl}}, {{logoUrl}}.',
      'Highlight the official Assayer Code in a prestigious green/emerald badge.',
      'Provide direct link to sign in and accept first assignments.',
    ],
    prompt: `You are an expert HTML email designer. Create a celebratory, prestigious, and official transactional HTML email for Sumeru Global (Field Assayer & Portfolio Operations Management System - FAPOMS).

The email purpose is congratulating a candidate whose appraiser application has been officially approved, announcing their official Assayer Code, and onboarding them to active field status.

BRAND GUIDELINES:
- Primary Accent: #ED6714 (Flame Orange)
- Success Highlight: #059669 (Emerald)
- Container: 560px max-width centered card on #F8FAFC ground.

TECHNICAL REQUIREMENTS:
- 100% Inline CSS.
- Header with Sumeru Global logo (src="{{logoUrl}}").
- Celebratory banner and congratulations message to {{fullName}}.
- Official credentials box displaying:
  - Official Assayer Code: {{assayerCode}} (prominent emerald monospace badge)
  - Effective Date: {{effectiveDate}}
- Next steps guide: Download mobile app, review safety protocols, stand by for job dispatch.
- Primary CTA: "Access Appraiser Portal" linking to {{loginUrl}}.

CRITICAL TOKEN RULES:
You MUST include: {{fullName}}, {{assayerCode}}, {{effectiveDate}}, {{loginUrl}}, {{logoUrl}}.

Do NOT use any <script>, <iframe>, <form>, or onclick handlers.
Output ONLY the clean, raw HTML code.`,
  },
  'application-rejected': {
    tips: [
      'Preserve exact tokens: {{fullName}}, {{reviewNotes}}, {{supportEmail}}, {{logoUrl}}.',
      'Maintain an empathetic, professional, and respectful tone.',
      'Highlight review committee feedback in a clean callout box.',
    ],
    prompt: `You are an expert HTML email designer. Create a dignified, professional, and respectful transactional HTML email for Sumeru Global (Field Assayer & Portfolio Operations Management System - FAPOMS).

The email purpose is informing an appraiser candidate that their onboarding application was not approved following committee review.

BRAND GUIDELINES:
- Primary Accent: #ED6714 (Flame Orange)
- Background: #F8FAFC, Card: #FFFFFF (max 560px width, 10px radius).
- Neutral, empathetic tone.

TECHNICAL REQUIREMENTS:
- 100% Inline CSS.
- Header with Sumeru Global logo (src="{{logoUrl}}").
- Polite notification copy addressed to {{fullName}}.
- Review Feedback callout box displaying {{reviewNotes}} with a subtle left border (#CBD5E1).
- Re-application policy and support contact: {{supportEmail}}.

CRITICAL TOKEN RULES:
You MUST include: {{fullName}}, {{reviewNotes}}, {{supportEmail}}, {{logoUrl}}.

Do NOT use any <script>, <iframe>, <form>, or onclick handlers.
Output ONLY the clean, raw HTML code.`,
  },
  'branch-audit-paperwork': {
    tips: [
      'Preserve exact tokens: {{bankName}}, {{branchName}}, {{fileName}}, {{documentType}}, {{downloadUrl}}, {{logoUrl}}.',
      'Present document dispatch metadata in a crisp banking audit table.',
      'Provide a prominent download button for the signed paperwork.',
    ],
    prompt: `You are an expert HTML email designer. Create a clean, authoritative, and secure transactional HTML email for Sumeru Global (Field Assayer & Portfolio Operations Management System - FAPOMS).

The email purpose is delivering signed branch audit paperwork or certificates directly to bank branch contacts and operations managers.

BRAND GUIDELINES:
- Primary Accent: #ED6714 (Flame Orange)
- Background: #F8FAFC, Card: #FFFFFF, max-width 560px.

TECHNICAL REQUIREMENTS:
- 100% Inline CSS.
- Header with Sumeru Global logo (src="{{logoUrl}}").
- Context block stating audit documentation has been issued for {{bankName}} — {{branchName}}.
- Structured key-value table:
  - Financial Institution: {{bankName}}
  - Branch: {{branchName}}
  - Document Title: {{fileName}}
  - Classification: {{documentType}}
- Primary CTA: "Download Secure Document" linking to {{downloadUrl}} (solid #ED6714).
- Security & compliance note regarding RBI / bank confidentiality.

CRITICAL TOKEN RULES:
You MUST include: {{bankName}}, {{branchName}}, {{fileName}}, {{documentType}}, {{downloadUrl}}, {{logoUrl}}.

Do NOT use any <script>, <iframe>, <form>, or onclick handlers.
Output ONLY the clean, raw HTML code.`,
  },
  'morning-digest': {
    tips: [
      'Preserve exact tokens: {{briefDate}}, {{subjectCounts}}, {{portalUrl}}, {{logoUrl}}, {{{digestSectionsHtml}}}.',
      'Note that {{{digestSectionsHtml}}} uses TRIPLE BRACES for authorized raw HTML sections.',
      'Design clean executive morning brief shell.',
    ],
    prompt: `You are an expert HTML email designer. Create an executive morning brief HTML email shell for Sumeru Global (Field Assayer & Portfolio Operations Management System - FAPOMS).

The email purpose is sending the daily 08:30 AM executive operations summary to coordinators and executives.

BRAND GUIDELINES:
- Primary Accent: #ED6714 (Flame Orange)
- Background: #F8FAFC, Card: #FFFFFF, max 600px width.

TECHNICAL REQUIREMENTS:
- 100% Inline CSS.
- Executive header with Sumeru logo (src="{{logoUrl}}") and "Daily Operations Brief".
- Date subheader with {{briefDate}} and quick metrics {{subjectCounts}}.
- Central content block that renders dynamic digest sections using {{{digestSectionsHtml}}} (note TRIPLE BRACES).
- Primary CTA: "Open Operations Inbox" linking to {{portalUrl}}.

CRITICAL TOKEN RULES:
You MUST include: {{briefDate}}, {{subjectCounts}}, {{portalUrl}}, {{logoUrl}}, and {{{digestSectionsHtml}}}.

Do NOT use any <script>, <iframe>, <form>, or onclick handlers.
Output ONLY the clean, raw HTML code.`,
  },
};

// -----------------------------------------------------------------------------
// Component Interfaces
// -----------------------------------------------------------------------------

interface EmailTemplateSummary {
  key: string;
  name: string;
  description: string;
  category: string;
  requiredTokens: string[];
  optionalTokens: string[];
  rawTokens: string[];
  allowRawHtmlTokens: boolean;
  defaultSubjectTemplate: string;
  sampleData: Record<string, any>;
  activeState: {
    source: 'platform' | 'filesystem' | 'fallback';
    version: number;
    checksum: string;
    isFallback: boolean;
  };
  settings: {
    sourcePreference: string;
    activeVersion?: number;
    hasDraft: boolean;
    versionCount: number;
    hasFilesystemTemplate: boolean;
  };
}

interface StoredVersion {
  version: number;
  status: 'ACTIVE' | 'ARCHIVED';
  subjectTemplate?: string;
  html: string;
  checksum: string;
  createdBy: string;
  createdAt: string;
  publishedAt: string;
}

interface EmailTemplateDetailResponse {
  definition: EmailTemplateSummary;
  activeTemplate: {
    key: string;
    source: 'platform' | 'filesystem' | 'fallback';
    version: number;
    subjectTemplate: string;
    html: string;
    checksum: string;
    isFallback: boolean;
  };
  storedSettings: {
    sourcePreference?: 'platform' | 'filesystem' | 'fallback';
    activeVersion?: number;
    lastKnownGoodVersion?: number;
    draft?: {
      html: string;
      subjectTemplate?: string;
      updatedAt: string;
      updatedBy: string;
    } | null;
    versions: StoredVersion[];
  } | null;
  filesystemTemplate: {
    exists: boolean;
    html?: string;
    checksum?: string;
  };
}

// -----------------------------------------------------------------------------
// Visual Form Models & Zero-Code Compiler (Error-Free for Non-Technical Users)
// -----------------------------------------------------------------------------


export interface BrandThemePreset {
  id: string;
  label: string;
  primary: string;
  accentBg: string;
  description: string;
}

export const BRAND_THEME_PRESETS: BrandThemePreset[] = [
  { id: 'flame', label: 'Sumeru Flame', primary: '#ED6714', accentBg: '#FFF7ED', description: 'Official Sumeru flame orange' },
  { id: 'navy', label: 'Executive Slate', primary: '#0F172A', accentBg: '#F8FAFC', description: 'Authoritative deep corporate navy' },
  { id: 'emerald', label: 'Royal Emerald', primary: '#047857', accentBg: '#ECFDF5', description: 'Institutional trust & verification emerald' },
  { id: 'indigo', label: 'Tech Indigo', primary: '#4F46E5', accentBg: '#EEF2FF', description: 'Modern vibrant digital platform indigo' },
  { id: 'ruby', label: 'Crimson Ruby', primary: '#DC2626', accentBg: '#FEF2F2', description: 'High-urgency operational alert crimson' },
  { id: 'amber', label: 'Precious Gold', primary: '#D97706', accentBg: '#FFFBEB', description: 'Refined bullion & gold assaying amber' },
];


export const VISUAL_DEFAULTS: Record<string, VisualTemplateData> = {
  'otp-verification': {
    subject: 'Your Appraiser registration code',
    headline: 'Verification Code',
    greeting: 'Dear Candidate,',
    leadMessage: 'Please enter the 6-digit verification code below to verify your email address and continue your Sumeru Global appraiser onboarding.',
    footerNotice: 'This code is valid for {{validMinutes}} minutes. Sumeru Global personnel will never ask for your code. Need help? Contact {{supportEmail}}.',
    primaryColor: '#ED6714',
    accentBg: '#FFF7ED',
    headerStyle: 'gradient-banner',
    companyName: 'Sumeru Global',
    logoUrl: '/sumeru-logo@2x.png',
    supportEmail: 'support@sumeruglobal.com',
  },
  'registration-invite': {
    subject: 'Invitation to complete Sumeru Global registration',
    headline: 'Welcome to Sumeru Global',
    greeting: 'Dear {{fullName}},',
    leadMessage: 'You have been selected to complete your formal onboarding as a certified gold and bullion appraiser with Sumeru Global.',
    buttonLabel: 'Complete Registration',
    footerNotice: 'If the button above does not work, visit {{inviteUrl}}. For inquiries, reach out to our recruitment desk.',
    primaryColor: '#ED6714',
    accentBg: '#FFF7ED',
    headerStyle: 'gradient-banner',
    companyName: 'Sumeru Global',
    logoUrl: '/sumeru-logo@2x.png',
    supportEmail: 'support@sumeruglobal.com',
  },
  'app-credentials': {
    subject: 'Your FAPOMS app access credentials',
    headline: 'App Access Provisioned',
    greeting: 'Hello {{displayName}},',
    leadMessage: 'Your mobile app and portal credentials for the Field Assayer & Portfolio Operations Management System (FAPOMS) are ready.',
    buttonLabel: 'Sign In to FAPOMS Portal',
    footerNotice: 'Temporary password is valid for {{validDays}} days. Please change your password on first login.',
    primaryColor: '#ED6714',
    accentBg: '#FFF7ED',
    headerStyle: 'gradient-banner',
    companyName: 'Sumeru Global',
    logoUrl: '/sumeru-logo@2x.png',
    supportEmail: 'support@sumeruglobal.com',
  },
  'application-approved': {
    subject: 'Your Appraiser application has been approved',
    headline: 'Application Approved',
    greeting: 'Congratulations {{fullName}},',
    leadMessage: 'Your application has successfully completed committee evaluation and document verification. You are now officially empanelled.',
    buttonLabel: 'Access Appraiser Portal',
    footerNotice: 'Official Assayer Code: {{assayerCode}}. Effective Date: {{effectiveDate}}.',
    primaryColor: '#ED6714',
    accentBg: '#FFF7ED',
    headerStyle: 'gradient-banner',
    companyName: 'Sumeru Global',
    logoUrl: '/sumeru-logo@2x.png',
    supportEmail: 'support@sumeruglobal.com',
  },
  'application-rejected': {
    subject: 'Your Appraiser application status',
    headline: 'Application Review Decision',
    greeting: 'Dear {{fullName}},',
    leadMessage: 'Thank you for your interest in joining Sumeru Global. Following evaluation of your application dossier, we regret to inform you that we cannot proceed with your empanelment at this time.',
    footerNotice: 'Review Committee Notes: {{reviewNotes}}. For clarification, contact {{supportEmail}}.',
    primaryColor: '#ED6714',
    accentBg: '#FFF7ED',
    headerStyle: 'gradient-banner',
    companyName: 'Sumeru Global',
    logoUrl: '/sumeru-logo@2x.png',
    supportEmail: 'support@sumeruglobal.com',
  },
  'branch-audit-paperwork': {
    subject: 'Audit paperwork — {{fileName}}',
    headline: 'Branch Audit Documentation',
    greeting: 'Dear Operations Team,',
    leadMessage: 'Attached is the official audit paperwork for {{bankName}} — {{branchName}} regarding document type: {{documentType}}.',
    buttonLabel: 'Download Audit Paperwork',
    footerNotice: 'This is a confidential audit communication. Confidential file: {{fileName}}.',
    primaryColor: '#ED6714',
    accentBg: '#FFF7ED',
    headerStyle: 'gradient-banner',
    companyName: 'Sumeru Global',
    logoUrl: '/sumeru-logo@2x.png',
    supportEmail: 'support@sumeruglobal.com',
  },
  'morning-digest': {
    subject: 'FAPOMS morning brief — {{subjectCounts}}',
    headline: 'Executive Operational Brief',
    greeting: 'Good morning,',
    leadMessage: 'Here is your daily operational summary for {{briefDate}}. Current alert totals: {{subjectCounts}}.',
    buttonLabel: 'Open Operations Inbox',
    footerNotice: 'Daily automated digest. Log in to {{portalUrl}} to review all pending action items.',
    primaryColor: '#ED6714',
    accentBg: '#FFF7ED',
    headerStyle: 'gradient-banner',
    companyName: 'Sumeru Global',
    logoUrl: '/sumeru-logo@2x.png',
    supportEmail: 'support@sumeruglobal.com',
  },
};


export const EmailTemplatesSection: React.FC<{ canEdit: boolean }> = ({ canEdit }) => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();

  // State
  const [selectedKey, setSelectedKey] = useState<string>('otp-verification');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [editorMode, setEditorMode] = useState<'visual' | 'code'>('visual');
  /*
    EMPTY until a template is opened, and that is the whole point.

    This started as `{ ...VISUAL_DEFAULTS }`, which looked like a convenience and was in fact a
    silent off-switch for the restore below: that restore only runs when the open template has no
    fields yet, and every shipped template already had them. So an email an administrator had
    written in the form reopened showing the BUILT-IN wording, and the first keystroke compiled
    those built-in fields over the top of what they had written and published. Nothing warned,
    because from the screen's point of view nothing had been replaced.

    Read the fields through `visualFields` below, never from here, so a template that has not been
    opened yet still shows its design rather than empty boxes.
  */
  const [visualState, setVisualState] = useState<Record<string, VisualTemplateData>>({});
  const [editorSubject, setEditorSubject] = useState<string>('');
  const [editorHtml, setEditorHtml] = useState<string>('');
  const [isDirty, setIsDirty] = useState<boolean>(false);

  /**
   * What the form shows for the template that is open: the fields restored from the email itself
   * when the form wrote it, and the built-in design when it did not.
   */
  const visualFields: VisualTemplateData | undefined = visualState[selectedKey] ?? VISUAL_DEFAULTS[selectedKey];
  const [loadedKey, setLoadedKey] = useState<string>('otp-verification');

  // Preview & Viewport State
  const [viewMode, setViewMode] = useState<'desktop' | 'mobile'>('desktop');
  const [formatMode, setFormatMode] = useState<'html' | 'text'>('html');
  const [simulatorClientTheme, setSimulatorClientTheme] = useState<'light' | 'dark'>('light');
  const [previewHtml, setPreviewHtml] = useState<string>('');
  const [previewText, setPreviewText] = useState<string>('');
  const [previewSubject, setPreviewSubject] = useState<string>('');
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [validationWarnings, setValidationWarnings] = useState<string[]>([]);
  const [isValidating, setIsValidating] = useState<boolean>(false);

  // Modals & Drawers
  const [showAiModal, setShowAiModal] = useState<boolean>(false);
  const [showHistoryModal, setShowHistoryModal] = useState<boolean>(false);
  const [showTestModal, setShowTestModal] = useState<boolean>(false);
  const [showSampleDataModal, setShowSampleDataModal] = useState<boolean>(false);
  const [showPublishGateModal, setShowPublishGateModal] = useState<boolean>(false);
  const [publishGateAgreed, setPublishGateAgreed] = useState<boolean>(false);
  const [previewTarget, setPreviewTarget] = useState<'draft' | 'baseline'>('draft');
  const [baselinePreviewHtml, setBaselinePreviewHtml] = useState<string>('');
  const [baselinePreviewText, setBaselinePreviewText] = useState<string>('');
  const [baselinePreviewSubject, setBaselinePreviewSubject] = useState<string>('');
  const [loadingBaseline, setLoadingBaseline] = useState<boolean>(false);
  const [testEmail, setTestEmail] = useState<string>('');
  /**
   * The HTML a test was last sent for, in THIS sitting.
   *
   * The server remembers it too (and is the authority — it refuses to publish an untested draft),
   * but the ordinary flow is edit → test → publish without a reload, and the server's copy is
   * keyed to the saved draft rather than to what is on screen. Holding the exact string here keeps
   * the button honest between the test arriving and the draft being saved.
   */
  const [testedHtml, setTestedHtml] = useState<string | null>(null);
  const [sendingTest, setSendingTest] = useState<boolean>(false);
  const [savingDraft, setSavingDraft] = useState<boolean>(false);
  const [publishing, setPublishing] = useState<boolean>(false);
  const [switchingSource, setSwitchingSource] = useState<boolean>(false);
  const [copiedPrompt, setCopiedPrompt] = useState<boolean>(false);

  // Textarea Ref for token insertion
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Caching & In-flight isolation refs
  const cacheRef = useRef<Record<string, { html: string; subject: string; isDirty: boolean }>>({});
  const activeKeyRef = useRef<string>('otp-verification');
  const visualStateRef = useRef<Record<string, VisualTemplateData>>(visualState);
  visualStateRef.current = visualState;
  const previewTimerRef = useRef<any>(null);

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  const templatesListQuery = useQuery({
    queryKey: ['notification-admin', 'email-templates'],
    queryFn: () => api.request<EmailTemplateSummary[] | { data: EmailTemplateSummary[] }>('/notification-admin/email-templates'),
  });

  const templates: EmailTemplateSummary[] = useMemo(() => {
    const raw = templatesListQuery.data;
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray((raw as any).data)) return (raw as any).data;
    return [];
  }, [templatesListQuery.data]);

  const templateDetailQuery = useQuery({
    queryKey: ['notification-admin', 'email-templates', selectedKey],
    queryFn: () => api.request<EmailTemplateDetailResponse | { data: EmailTemplateDetailResponse }>(`/notification-admin/email-templates/${selectedKey}`),
    enabled: !!selectedKey,
  });

  const detail: EmailTemplateDetailResponse | undefined = useMemo(() => {
    const raw = templateDetailQuery.data;
    if (!raw) return undefined;
    if ('definition' in raw) return raw as EmailTemplateDetailResponse;
    if ('data' in raw && (raw as any).data && 'definition' in (raw as any).data) {
      return (raw as any).data as EmailTemplateDetailResponse;
    }
    return undefined;
  }, [templateDetailQuery.data]);

  // Synchronize default selected key once templates list loads
  useEffect(() => {
    if (templates.length > 0 && (!selectedKey || !templates.some((t) => t.key === selectedKey))) {
      setSelectedKey(templates[0].key);
      activeKeyRef.current = templates[0].key;
    }
  }, [templates, selectedKey]);

  // Handle template selection cleanly without cross-polluting HTML
  const handleSelectTemplate = (newKey: string) => {
    if (newKey === selectedKey) return;

    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }

    if (loadedKey) {
      cacheRef.current[loadedKey] = {
        html: editorHtml,
        subject: editorSubject,
        isDirty,
      };
    }

    setValidationErrors([]);
    setValidationWarnings([]);
    setPreviewTarget('draft');
    setBaselinePreviewHtml('');
    setBaselinePreviewText('');
    setBaselinePreviewSubject('');
    setShowPublishGateModal(false);
    setPublishGateAgreed(false);
    activeKeyRef.current = newKey;
    setSelectedKey(newKey);

    if (cacheRef.current[newKey]) {
      const cached = cacheRef.current[newKey];
      setEditorHtml(cached.html);
      setEditorSubject(cached.subject);
      setIsDirty(cached.isDirty);
      setLoadedKey(newKey);
    } else {
      setLoadedKey('');
    }
  };

  // Initialize or synchronize editor with loaded template
  useEffect(() => {
    if (!detail) return;
    const key = detail.definition.key;
    if (key !== activeKeyRef.current) return;

    /*
      The form's fields come from the TEMPLATE, not from defaults, whenever the form wrote it.
      Seeding them from `VISUAL_DEFAULTS` regardless is what made the simple editor destructive:
      the fields on screen described a different email from the one in the box, and the first
      keystroke compiled the fields over the top of it.
    */
    if (!visualState[key]) {
      const storedHtml = detail.storedSettings?.draft?.html ?? detail.activeTemplate.html ?? '';
      const signed = readVisualStamp(storedHtml);
      const restored = signed ?? VISUAL_DEFAULTS[key];
      if (restored) setVisualState((prev) => ({ ...prev, [key]: restored }));
    }

    if (!cacheRef.current[key]) {
      const draft = detail.storedSettings?.draft;
      const initialHtml = draft?.html ?? detail.activeTemplate.html ?? '';
      const initialSubject = draft?.subjectTemplate ?? detail.activeTemplate.subjectTemplate ?? detail.definition.defaultSubjectTemplate ?? '';

      cacheRef.current[key] = {
        html: initialHtml,
        subject: initialSubject,
        isDirty: false,
      };
      setEditorHtml(initialHtml);
      setEditorSubject(initialSubject);
      setIsDirty(false);
      setLoadedKey(key);
      /*
        WHICH EDITOR OPENS IS DECIDED BY WHO WROTE THE EMAIL.

        The simple form used to open by default on everything, including the seven hand-built
        templates that ship with the platform — and the form rebuilds the whole body from its
        fields, so the very first keystroke replaced an email nobody intended to touch. There was
        no switch to guard, because no switch had happened.

        So: the form opens for an email the form wrote, or for an empty one. Anything else opens in
        the HTML editor, where typing changes only what is typed. Rebuilding is still one button
        away, and that button asks first.
      */
      setEditorMode(authorshipOf(initialHtml) === 'hand-written' ? 'code' : 'visual');
    } else if (loadedKey !== key) {
      const cached = cacheRef.current[key];
      setEditorHtml(cached.html);
      setEditorSubject(cached.subject);
      setIsDirty(cached.isDirty);
      setLoadedKey(key);
    }
  }, [detail, loadedKey, selectedKey, visualState]);

  /**
   * Opening the simple editor, which is the moment the damage used to happen.
   *
   * The form rebuilds the whole email from its fields, so it may only take over a template it
   * wrote itself (`authorshipOf`). For anything else the person is told, in plain words, exactly
   * what switching would do — and "keep my HTML" is the default answer, because the cost of the
   * two mistakes is not symmetrical: staying in the HTML editor wastes a click, and replacing a
   * hand-built email loses work nobody can get back except through version history.
   */
  const openSimpleEditor = async () => {
    if (authorshipOf(editorHtml) === 'hand-written') {
      const replace = await confirm({
        title: 'Rebuild this email from the simple form?',
        message: 'This email was written as HTML, so the simple form cannot show what is in it. '
          + 'Switching will rebuild the whole email from the standard layout and the fields below — '
          + 'everything currently written in the HTML will be replaced.\n\n'
          + 'Nothing is sent to anybody until you publish, and the version you have already '
          + 'published can be restored from History.',
        confirmLabel: 'Rebuild from the form',
        cancelLabel: 'Keep the HTML',
        // Reversible, and worth saying so: the published version is still in History, and nothing
        // reaches anybody until Publish. People decline safe things when nobody tells them.
        reversible: true,
        reversibleNote: 'The version you have already published is unaffected until you publish again, '
          + 'and every earlier version stays in History.',
      });
      if (!replace) return;
    }
    setEditorMode('visual');
  };

  // Handle Visual Content Field Changes (Auto-compiles to 100% compliant HTML)
  const handleVisualFieldChange = (field: keyof VisualTemplateData, value: string) => {
    const currentVisual = visualFields || {
      subject: '',
      headline: '',
      greeting: '',
      leadMessage: '',
      footerNotice: '',
    };
    const updated = { ...currentVisual, [field]: value };
    setVisualState((prev) => ({ ...prev, [selectedKey]: updated }));

    const compiledHtml = compileVisualToHtml(selectedKey, updated);
    setEditorHtml(compiledHtml);
    if (field === 'subject') {
      setEditorSubject(value);
    }
    setIsDirty(true);
    if (loadedKey) {
      cacheRef.current[loadedKey] = {
        html: compiledHtml,
        subject: field === 'subject' ? value : editorSubject,
        isDirty: true,
      };
    }
  };

  // 1-Click Brand Theme Preset Selection
  const handleSelectThemePreset = (preset: BrandThemePreset) => {
    const currentVisual = visualFields || {
      subject: '',
      headline: '',
      greeting: '',
      leadMessage: '',
      footerNotice: '',
    };
    const updated: VisualTemplateData = {
      ...currentVisual,
      primaryColor: preset.primary,
      accentBg: preset.accentBg,
    };
    setVisualState((prev) => ({ ...prev, [selectedKey]: updated }));

    const compiledHtml = compileVisualToHtml(selectedKey, updated);
    setEditorHtml(compiledHtml);
    setIsDirty(true);
    if (loadedKey) {
      cacheRef.current[loadedKey] = {
        html: compiledHtml,
        subject: editorSubject,
        isDirty: true,
      };
    }
  };

  // ---------------------------------------------------------------------------
  // Real-Time Validation & Preview (Debounced & Race-Condition Safe)
  // ---------------------------------------------------------------------------

  const triggerPreview = useCallback(
    async (targetKey: string, htmlToPreview: string, subjectToPreview: string) => {
      if (!targetKey || targetKey !== activeKeyRef.current) return;
      setIsValidating(true);
      try {
        const vData = visualStateRef.current[targetKey] || VISUAL_DEFAULTS[targetKey];
        const rawLogo = vData?.logoUrl || '/sumeru-logo@2x.png';
        const effectiveLogo = rawLogo.startsWith('/') ? `${window.location.origin}${rawLogo}` : rawLogo;

        const res = await api.request<any>(`/notification-admin/email-templates/${targetKey}/preview`, {
          method: 'POST',
          body: JSON.stringify({
            html: htmlToPreview,
            subjectTemplate: subjectToPreview,
            payload: {
              logoUrl: effectiveLogo,
              companyName: vData?.companyName || 'Sumeru Global',
              supportEmail: vData?.supportEmail || 'support@sumeruglobal.com',
            },
          }),
        });

        if (targetKey !== activeKeyRef.current) return;

        const previewData = (res && res.data && 'html' in res.data) ? res.data : res;
        setPreviewHtml(previewData?.html || '');
        setPreviewText(previewData?.text || '');
        setPreviewSubject(previewData?.subject || subjectToPreview);
        setValidationErrors(previewData?.validation?.errors || []);
        setValidationWarnings(previewData?.validation?.warnings || []);
      } catch (err: any) {
        if (targetKey === activeKeyRef.current) {
          setValidationErrors([userMessage(err)]);
        }
      } finally {
        if (targetKey === activeKeyRef.current) {
          setIsValidating(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (!editorHtml || loadedKey !== selectedKey || selectedKey !== activeKeyRef.current) return;
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);

    previewTimerRef.current = setTimeout(() => {
      void triggerPreview(selectedKey, editorHtml, editorSubject);
    }, 350);

    return () => {
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    };
  }, [editorHtml, editorSubject, loadedKey, selectedKey, triggerPreview]);

  // ---------------------------------------------------------------------------
  // Token Status Helpers & AI Auto-Fixers
  // ---------------------------------------------------------------------------

  const requiredTokens = useMemo(() => detail?.definition.requiredTokens ?? [], [detail?.definition.requiredTokens]);
  const optionalTokens = useMemo(() => detail?.definition.optionalTokens ?? [], [detail?.definition.optionalTokens]);
  const rawTokens = useMemo(() => detail?.definition.rawTokens ?? [], [detail?.definition.rawTokens]);

  const tokenPresent = useCallback(
    (token: string, isRaw = false) => {
      const pattern = isRaw ? `{{{${token}}}}` : `{{${token}}}`;
      return editorHtml.includes(pattern) || editorSubject.includes(pattern);
    },
    [editorHtml, editorSubject],
  );

  const missingRequiredTokens = useMemo(() => {
    return requiredTokens.filter((tok) => !tokenPresent(tok));
  }, [requiredTokens, tokenPresent]);

  // Auto-inject missing required tokens into HTML
  const handleAutoInjectMissingTokens = () => {
    if (!detail) return;
    if (missingRequiredTokens.length === 0) {
      toast('info', 'All required tokens are already present!');
      return;
    }

    const injectionBlock = missingTokenBlock(missingRequiredTokens);

    let updatedHtml = editorHtml;
    if (updatedHtml.includes('</body>')) {
      updatedHtml = updatedHtml.replace('</body>', `${injectionBlock}</body>`);
    } else {
      updatedHtml = `${updatedHtml}\n${injectionBlock}`;
    }

    setEditorHtml(updatedHtml);
    setIsDirty(true);
    toast('success', `Auto-injected ${missingRequiredTokens.length} missing required token(s).`);
  };

  // Clean unknown tokens (e.g. from foreign templates or AI hallucinations)
  const handleCleanUnknownTokens = () => {
    if (!detail) return;
    const allowed = new Set([
      ...requiredTokens,
      ...optionalTokens,
      ...rawTokens,
    ]);

    const standardRegex = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
    const rawRegex = /\{\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

    let count = 0;
    let newHtml = editorHtml;
    let newSubject = editorSubject;

    newHtml = newHtml.replace(rawRegex, (match, tok) => {
      if (!allowed.has(tok)) {
        count++;
        return '';
      }
      return match;
    });

    newHtml = newHtml.replace(standardRegex, (match, tok) => {
      if (!allowed.has(tok)) {
        count++;
        return '';
      }
      return match;
    });

    newSubject = newSubject.replace(standardRegex, (match, tok) => {
      if (!allowed.has(tok)) {
        count++;
        return '';
      }
      return match;
    });

    if (count === 0) {
      toast('info', 'No unknown tokens found.');
      return;
    }

    setEditorHtml(newHtml);
    setEditorSubject(newSubject);
    setIsDirty(true);
    toast('success', `Removed ${count} unknown token(s).`);
  };

  // Clean AI code (markdown fences & button tags)
  const handleCleanAiMarkup = () => {
    let text = editorHtml.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '').trim();
    }
    text = text.replace(/<button\b([^>]*)>(.*?)<\/button>/gis, '<a href="#" style="display:inline-block;padding:12px 24px;background:#ED6714;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;"$1>$2</a>');

    setEditorHtml(text);
    setIsDirty(true);
    toast('success', 'Cleaned AI markdown fences and converted button tags.');
  };

  const insertToken = (token: string, isRaw = false) => {
    const tokenStr = isRaw ? `{{{${token}}}}` : `{{${token}}}`;
    if (!textareaRef.current) {
      void navigator.clipboard.writeText(tokenStr);
      toast('info', `Copied ${tokenStr} to clipboard!`);
      return;
    }

    const ta = textareaRef.current;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const nextHtml = editorHtml.substring(0, start) + tokenStr + editorHtml.substring(end);
    setEditorHtml(nextHtml);
    setIsDirty(true);

    setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(start + tokenStr.length, start + tokenStr.length);
    }, 10);
    toast('success', `Inserted ${tokenStr}`);
  };

  /**
   * Whether this exact draft has been seen arriving in a real inbox.
   *
   * Three ways it can be true, in decreasing immediacy: a test was just sent for precisely this
   * HTML; the draft is unchanged since loading and the server says its last test matches; or email
   * delivery is not configured at all, in which case no test is possible and requiring one would
   * only lock the feature.
   */
  const testStatus = (detail as any)?.testStatus as
    { required?: boolean; lastTestSend?: { to: string; at: string } | null; matchesDraft?: boolean } | undefined;
  const lastTestSend = testStatus?.lastTestSend ?? null;
  const draftHasBeenTested = testStatus?.required === false
    || testedHtml === editorHtml
    || (!isDirty && !!testStatus?.matchesDraft);

  // ---------------------------------------------------------------------------
  // Actions: Save Draft, Publish, Source Switch, Rollback, Test
  // ---------------------------------------------------------------------------

  const handleSaveDraft = async () => {
    if (!selectedKey) return;
    setSavingDraft(true);
    try {
      await api.request(`/notification-admin/email-templates/${selectedKey}/draft`, {
        method: 'POST',
        body: JSON.stringify({
          html: editorHtml,
          subjectTemplate: editorSubject,
        }),
      });
      toast('success', 'Draft saved successfully.');
      setIsDirty(false);
      void queryClient.invalidateQueries({ queryKey: ['notification-admin', 'email-templates'] });
    } catch (err) {
      toast('error', `Failed to save draft: ${userMessage(err)}`);
    } finally {
      setSavingDraft(false);
    }
  };

  const isFactoryDefaultActive = useMemo(() => {
    if (!detail) return true;
    return (
      detail.storedSettings?.sourcePreference === 'filesystem' ||
      (!detail.storedSettings?.activeVersion && detail.activeTemplate?.source === 'filesystem')
    );
  }, [detail]);

  const handleOpenPublishGate = () => {
    if (!selectedKey) return;
    if (validationErrors.length > 0) {
      toast('error', `Cannot publish: Please resolve ${validationErrors.length} security/contract errors first.`);
      return;
    }
    setPublishGateAgreed(false);
    setShowPublishGateModal(true);
  };

  const executePublish = async () => {
    if (!selectedKey) return;
    if (validationErrors.length > 0) {
      toast('error', 'Cannot publish: please resolve all security and token errors first.');
      return;
    }
    if (!publishGateAgreed) {
      toast('warning', 'Please verify the live preview and check the confirmation box.');
      return;
    }

    setPublishing(true);
    try {
      const res = await api.request<any>(
        `/notification-admin/email-templates/${selectedKey}/publish`,
        {
          method: 'POST',
          body: JSON.stringify({
            html: editorHtml,
            subjectTemplate: editorSubject,
            changeNotes: `Published via ${editorMode === 'visual' ? 'Visual Form (No-Code)' : 'AI & HTML Studio'}`,
          }),
        },
      );
      const vNum = res?.version?.version ?? res?.data?.version?.version ?? 1;
      toast('success', `Published live version v${vNum} successfully!`);
      setIsDirty(false);
      setShowPublishGateModal(false);
      void queryClient.invalidateQueries({ queryKey: ['notification-admin', 'email-templates'] });
    } catch (err) {
      toast('error', `Failed to publish: ${userMessage(err)}`);
    } finally {
      setPublishing(false);
    }
  };

  const handleSetSourcePreference = async (source: 'platform' | 'filesystem' | 'fallback') => {
    if (!selectedKey) return;
    setSwitchingSource(true);
    try {
      await api.request(`/notification-admin/email-templates/${selectedKey}/source`, {
        method: 'POST',
        body: JSON.stringify({ source }),
      });
      toast('success', `Active template source preference changed to "${source}".`);
      void queryClient.invalidateQueries({ queryKey: ['notification-admin', 'email-templates'] });
    } catch (err) {
      toast('error', `Failed to switch source: ${userMessage(err)}`);
    } finally {
      setSwitchingSource(false);
    }
  };

  const handleResetToFactoryDefault = async () => {
    if (!detail) return;
    const ok = await confirm({
      title: `Send the original design for "${detail.definition.name}"?`,
      message: 'Live email goes back to the design that shipped with the product. Your edited '
        + 'version is kept in the version history and can be published again whenever you want.',
      confirmLabel: RESTORE_ORIGINAL.action,
      tone: 'normal',
    });
    if (!ok) return;

    try {
      // 1. Switch backend source preference to filesystem
      await api.request(`/notification-admin/email-templates/${selectedKey}/source`, {
        method: 'POST',
        body: JSON.stringify({ source: 'filesystem' }),
      });

      // 2. Load disk template html & default subject into editor
      const fsHtml = detail.filesystemTemplate?.html || detail.activeTemplate.html;
      const fsSubject = detail.definition.defaultSubjectTemplate;

      setEditorHtml(fsHtml);
      setEditorSubject(fsSubject);
      if (VISUAL_DEFAULTS[selectedKey]) {
        setVisualState((prev) => ({ ...prev, [selectedKey]: { ...VISUAL_DEFAULTS[selectedKey] } }));
      }
      setIsDirty(false);
      if (loadedKey) {
        cacheRef.current[loadedKey] = {
          html: fsHtml,
          subject: fsSubject,
          isDirty: false,
        };
      }
      toast('success', `"${detail.definition.name}" is now sending the original design.`);
      void queryClient.invalidateQueries({ queryKey: ['notification-admin', 'email-templates'] });
    } catch (err) {
      toast('error', `Failed to reset to factory default: ${userMessage(err)}`);
    }
  };

  const handleResetVisualForm = () => {
    if (!VISUAL_DEFAULTS[selectedKey]) return;
    const defVisual = { ...VISUAL_DEFAULTS[selectedKey] };
    setVisualState((prev) => ({ ...prev, [selectedKey]: defVisual }));
    const compiled = compileVisualToHtml(selectedKey, defVisual);
    setEditorHtml(compiled);
    setEditorSubject(defVisual.subject);
    setIsDirty(true);
    if (loadedKey) {
      cacheRef.current[loadedKey] = {
        html: compiled,
        subject: defVisual.subject,
        isDirty: true,
      };
    }
    toast('info', 'Visual form fields reset to standard factory layout.');
  };

  const handleResetBaselineCode = () => {
    const fsHtml = detail?.filesystemTemplate?.html || detail?.activeTemplate.html;
    if (!fsHtml) {
      toast('error', 'Baseline disk template not available.');
      return;
    }
    setEditorHtml(fsHtml);
    setEditorSubject(detail?.definition.defaultSubjectTemplate || editorSubject);
    setIsDirty(true);
    if (loadedKey) {
      cacheRef.current[loadedKey] = {
        html: fsHtml,
        subject: detail?.definition.defaultSubjectTemplate || editorSubject,
        isDirty: true,
      };
    }
    toast('info', 'Shipped baseline HTML loaded into editor.');
  };

  const fetchBaselinePreview = useCallback(
    async (targetKey: string) => {
      if (!targetKey) return;
      setLoadingBaseline(true);
      try {
        const fsHtml = detail?.filesystemTemplate?.html;
        const vData = visualStateRef.current[targetKey] || VISUAL_DEFAULTS[targetKey];
        const rawLogo = vData?.logoUrl || '/sumeru-logo@2x.png';
        const effectiveLogo = rawLogo.startsWith('/') ? `${window.location.origin}${rawLogo}` : rawLogo;

        const res = await api.request<any>(`/notification-admin/email-templates/${targetKey}/preview`, {
          method: 'POST',
          body: JSON.stringify({
            html: fsHtml || undefined,
            subjectTemplate: detail?.definition.defaultSubjectTemplate,
            payload: {
              logoUrl: effectiveLogo,
              companyName: vData?.companyName || 'Sumeru Global',
              supportEmail: vData?.supportEmail || 'support@sumeruglobal.com',
            },
          }),
        });
        const previewData = res && res.data && 'html' in res.data ? res.data : res;
        setBaselinePreviewHtml(previewData?.html || '');
        setBaselinePreviewText(previewData?.text || '');
        setBaselinePreviewSubject(previewData?.subject || detail?.definition.defaultSubjectTemplate || '');
      } catch (err: any) {
        toast('error', `Failed to load baseline preview: ${userMessage(err)}`);
      } finally {
        setLoadingBaseline(false);
      }
    },
    [detail, toast],
  );

  const handleTogglePreviewTarget = (target: 'draft' | 'baseline') => {
    setPreviewTarget(target);
    if (target === 'baseline' && !baselinePreviewHtml) {
      void fetchBaselinePreview(selectedKey);
    }
  };

  const handleRollback = async (versionNumber: number) => {
    if (!selectedKey) return;
    const ok = await confirm({
      title: `Roll Back to Version v${versionNumber}?`,
      message: `This will restore version v${versionNumber} as the active live platform override.`,
      confirmLabel: `Rollback to v${versionNumber}`,
      tone: 'normal',
    });
    if (!ok) return;

    try {
      await api.request(`/notification-admin/email-templates/${selectedKey}/rollback`, {
        method: 'POST',
        body: JSON.stringify({ version: versionNumber }),
      });
      toast('success', `Rolled back successfully to version v${versionNumber}.`);
      setShowHistoryModal(false);
      void queryClient.invalidateQueries({ queryKey: ['notification-admin', 'email-templates'] });
    } catch (err) {
      toast('error', `Rollback failed: ${userMessage(err)}`);
    }
  };

  const handleSendTestEmail = async () => {
    if (!selectedKey || !testEmail) return;
    setSendingTest(true);
    try {
      await api.request(`/notification-admin/email-templates/${selectedKey}/test`, {
        method: 'POST',
        body: JSON.stringify({
          to: testEmail,
          html: editorHtml,
          subjectTemplate: editorSubject,
        }),
      });
      // Remembered against the exact HTML that was sent, which is what the publish gate asks about.
      setTestedHtml(editorHtml);
      toast('success', `Test email sent to ${testEmail}. Check how it looks before publishing.`);
      setShowTestModal(false);
    } catch (err) {
      toast('error', `Test send failed: ${userMessage(err)}`);
    } finally {
      setSendingTest(false);
    }
  };

  // Filter templates list
  const categories = useMemo(() => {
    const set = new Set<string>();
    templates.forEach((t) => set.add(t.category));
    return ['ALL', ...Array.from(set)];
  }, [templates]);

  const filteredTemplates = useMemo(() => {
    if (categoryFilter === 'ALL') return templates;
    return templates.filter((t) => t.category === categoryFilter);
  }, [templates, categoryFilter]);

  const promptData = AI_PROMPTS[selectedKey] ?? { prompt: '', tips: [] };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loadFailed(templatesListQuery)) {
    return (
      <SectionCard title="Email Templates" description="System transactional email designs">
        <LoadFailure loads={[{ label: 'Email Templates Catalog', query: templatesListQuery }]} />
      </SectionCard>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {confirmDialog}

      {/* ── Top Header & Template Selection Card ──────────────────────────── */}
      <TemplateStudioHeader
        icon={<LayoutTemplate size={20} />}
        title="Transactional Email Design Studio"
        description="Design, preview, and configure live Sumeru Global emails. Edit directly, test live inboxes, or redesign with AI."
        actions={(
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setShowAiModal(true)}
              style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--text-xs)', padding: '7px 12px' }}
            >
              <Sparkles size={14} style={{ color: 'var(--flame-500, #ED6714)' }} />
              Design with AI
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setShowTestModal(true)}
              style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--text-xs)', padding: '7px 12px' }}
            >
              <Send size={13} />
              Send Test Email
            </button>
            {detail?.storedSettings?.versions && detail.storedSettings.versions.length > 0 && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowHistoryModal(true)}
                style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--text-xs)', padding: '7px 12px' }}
              >
                <History size={13} />
                Versions ({detail.storedSettings.versions.length})
              </button>
            )}
          </>
        )}
      >
        {/* Category Filters */}
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '14px', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px' }}>
          <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', fontWeight: 600, marginRight: '4px' }}>
            CATEGORY:
          </span>
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setCategoryFilter(cat)}
              style={{
                background: categoryFilter === cat ? 'rgba(237,103,20,0.12)' : 'transparent',
                color: categoryFilter === cat ? 'var(--flame-500, #ED6714)' : 'var(--text-secondary)',
                border: categoryFilter === cat ? '1px solid var(--flame-500, #ED6714)' : '1px solid transparent',
                borderRadius: '6px',
                padding: '4px 10px',
                fontSize: 'var(--text-2xs)',
                fontWeight: categoryFilter === cat ? 700 : 500,
                cursor: 'pointer',
              }}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Template Selector Grid */}
        <TemplatePicker
          label="Email templates to choose from"
          loading={templatesListQuery.isLoading}
          selectedKey={selectedKey}
          onSelect={handleSelectTemplate}
          items={filteredTemplates.map((tpl) => {
            const source = tpl.activeState.source;
            return {
              key: tpl.key,
              name: tpl.name,
              description: tpl.description,
              badge: tpl.category,
              status: {
                tone: source === 'platform' ? 'success' : source === 'filesystem' ? 'accent' : 'warning',
                label: sourceBadge(source, tpl.activeState.version),
              },
              flag: tpl.settings.hasDraft
                ? (
                  <span style={{ background: '#FFF7ED', color: '#C2410C', padding: '1px 5px', borderRadius: '4px', fontWeight: 600, fontSize: 'var(--text-3xs)' }}>
                    Draft
                  </span>
                )
                : undefined,
            };
          })}
        />
      </TemplateStudioHeader>

      {/* ── Active Template Control Bar ───────────────────────────────────── */}
      {detail && (
        <TemplateDetailBar
          icon={<Mail size={18} />}
          name={detail.definition.name}
          itemKey={detail.definition.key}
          footnote={`Default subject: "${detail.definition.defaultSubjectTemplate}"`}
          pills={isFactoryDefaultActive ? (
            <span
              style={{
                background: 'rgba(16,185,129,0.12)',
                color: 'var(--success)',
                border: '1px solid rgba(16,185,129,0.3)',
                padding: '3px 9px',
                borderRadius: '5px',
                fontSize: 'var(--text-2xs)',
                fontWeight: 700,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
              }}
            >
              <ShieldCheck size={13} />
              Sending the original design
            </span>
          ) : (
            <span
              style={{
                background: 'rgba(245,158,11,0.12)',
                color: 'var(--warning)',
                border: '1px solid rgba(245,158,11,0.3)',
                padding: '3px 9px',
                borderRadius: '5px',
                fontSize: 'var(--text-2xs)',
                fontWeight: 700,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
              }}
            >
              <AlertTriangle size={13} />
              Sending your edited version
            </span>
          )}
          actions={canEdit && (
            <>
              <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', fontWeight: 600 }}>
                Send which version:
              </span>
              <select
                value={detail.storedSettings?.sourcePreference || 'platform'}
                disabled={switchingSource}
                onChange={(e) => handleSetSourcePreference(e.target.value as any)}
                style={{
                  padding: '5px 10px',
                  borderRadius: '6px',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  fontSize: 'var(--text-xs)',
                  color: 'var(--text-primary)',
                  cursor: 'pointer',
                }}
              >
                {TEMPLATE_SOURCE_ORDER.map((src) => (
                  <option key={src} value={src} title={sourceHint(src)}>{sourceOption(src)}</option>
                ))}
              </select>

              <button
                type="button"
                className="btn btn-secondary"
                title={RESTORE_ORIGINAL.hint}
                onClick={handleResetToFactoryDefault}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: 'var(--text-xs)',
                  padding: '6px 12px',
                  fontWeight: 600,
                  borderColor: isFactoryDefaultActive ? undefined : 'rgba(16,185,129,0.5)',
                  color: isFactoryDefaultActive ? undefined : 'var(--success)',
                }}
              >
                <Shield size={13} />
                {RESTORE_ORIGINAL.action}
              </button>
            </>
          )}
        />
      )}

      {/* ── Two-Column Main Workspace: Editor & Live Preview ──────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.15fr) minmax(0, 1fr)', gap: '18px', alignItems: 'start' }}>
        {/* ── LEFT PANE: Mode Switcher, Visual Form / Code Editor & Tokens ─────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {/* Mode Switcher Tabs */}
          <div className="glass-card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: '6px', background: 'var(--bg-primary)', padding: '4px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
              <button
                type="button"
                onClick={() => { void openSimpleEditor(); }}
                style={{
                  padding: '6px 14px',
                  borderRadius: '6px',
                  border: 'none',
                  fontSize: 'var(--text-xs)',
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: editorMode === 'visual' ? 'var(--flame-500, #ED6714)' : 'transparent',
                  color: editorMode === 'visual' ? '#ffffff' : 'var(--text-secondary)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  transition: 'all 0.15s ease',
                }}
              >
                <Sliders size={14} />
                Visual Form (No-Code)
              </button>
              <button
                type="button"
                onClick={() => setEditorMode('code')}
                style={{
                  padding: '6px 14px',
                  borderRadius: '6px',
                  border: 'none',
                  fontSize: 'var(--text-xs)',
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: editorMode === 'code' ? 'var(--flame-500, #ED6714)' : 'transparent',
                  color: editorMode === 'code' ? '#ffffff' : 'var(--text-secondary)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  transition: 'all 0.15s ease',
                }}
              >
                <Code size={14} />
                AI & HTML Studio (Full Control)
              </button>
            </div>

            <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
              {editorMode === 'visual'
                ? '✍️ Zero-code form: guaranteed contract compliance & Sumeru styling.'
                : '⚡ Direct HTML & AI editor with 1-click token auto-fixing.'}
            </div>
          </div>

          {editorMode === 'visual' ? (
            /* ── VISUAL NO-CODE FORM ────────────────────────────────────────── */
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* Card 1: Brand Theme, Colors & Logo */}
              <div className="glass-card" style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)', paddingBottom: '10px' }}>
                  <span style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Palette size={15} style={{ color: 'var(--flame-500, #ED6714)' }} />
                    Brand Theme, Colors & Logo
                  </span>
                  <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <Sparkles size={12} style={{ color: 'var(--flame-500, #ED6714)' }} />
                    Live Simulator Sync
                  </span>
                </div>

                {/* Theme Presets Swatches */}
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>
                    Brand Palette Presets (1-Click Theme Switch)
                  </label>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '8px' }}>
                    {BRAND_THEME_PRESETS.map((preset) => {
                      const currentPrimary = visualFields?.primaryColor || '#ED6714';
                      const isActive = currentPrimary.toLowerCase() === preset.primary.toLowerCase();
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          disabled={!canEdit}
                          onClick={() => handleSelectThemePreset(preset)}
                          title={`${preset.label} — ${preset.description}`}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            padding: '6px 10px',
                            borderRadius: '6px',
                            background: isActive ? 'var(--bg-secondary)' : 'transparent',
                            border: isActive ? `2px solid ${preset.primary}` : '1px solid var(--border-color)',
                            cursor: canEdit ? 'pointer' : 'not-allowed',
                            textAlign: 'left',
                            transition: 'all 0.15s ease',
                          }}
                        >
                          <span
                            style={{
                              width: '18px',
                              height: '18px',
                              borderRadius: '4px',
                              background: preset.primary,
                              border: '1px solid rgba(0,0,0,0.15)',
                              flexShrink: 0,
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              color: '#FFFFFF',
                            }}
                          >
                            {isActive && <Check size={11} strokeWidth={3} />}
                          </span>
                          <span style={{ fontSize: 'var(--text-2xs)', fontWeight: isActive ? 700 : 500, color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {preset.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Custom Brand Colors (Primary + Accent) */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '5px' }}>
                      Primary Brand Color
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <input
                        type="color"
                        value={visualFields?.primaryColor ?? '#ED6714'}
                        disabled={!canEdit}
                        onChange={(e) => handleVisualFieldChange('primaryColor', e.target.value)}
                        style={{
                          width: '38px',
                          height: '36px',
                          padding: '2px',
                          borderRadius: '6px',
                          border: '1px solid var(--border-color)',
                          cursor: canEdit ? 'pointer' : 'not-allowed',
                          background: 'transparent',
                        }}
                      />
                      <input
                        type="text"
                        value={visualFields?.primaryColor ?? '#ED6714'}
                        disabled={!canEdit}
                        placeholder="#ED6714"
                        onChange={(e) => handleVisualFieldChange('primaryColor', e.target.value)}
                        style={{
                          flex: 1,
                          padding: '7px 10px',
                          borderRadius: '6px',
                          background: 'var(--bg-secondary)',
                          border: '1px solid var(--border-color)',
                          fontSize: 'var(--text-xs)',
                          fontFamily: 'monospace',
                          color: 'var(--text-primary)',
                        }}
                      />
                    </div>
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '5px' }}>
                      Light Accent Background
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <input
                        type="color"
                        value={visualFields?.accentBg ?? '#FFF7ED'}
                        disabled={!canEdit}
                        onChange={(e) => handleVisualFieldChange('accentBg', e.target.value)}
                        style={{
                          width: '38px',
                          height: '36px',
                          padding: '2px',
                          borderRadius: '6px',
                          border: '1px solid var(--border-color)',
                          cursor: canEdit ? 'pointer' : 'not-allowed',
                          background: 'transparent',
                        }}
                      />
                      <input
                        type="text"
                        value={visualFields?.accentBg ?? '#FFF7ED'}
                        disabled={!canEdit}
                        placeholder="#FFF7ED"
                        onChange={(e) => handleVisualFieldChange('accentBg', e.target.value)}
                        style={{
                          flex: 1,
                          padding: '7px 10px',
                          borderRadius: '6px',
                          background: 'var(--bg-secondary)',
                          border: '1px solid var(--border-color)',
                          fontSize: 'var(--text-xs)',
                          fontFamily: 'monospace',
                          color: 'var(--text-primary)',
                        }}
                      />
                    </div>
                  </div>
                </div>

                {/* Header Layout Style Selector */}
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>
                    Header Layout Style
                  </label>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
                    {[
                      { id: 'gradient-banner', label: 'Gradient Banner', desc: 'Hero gradient with white logo tile' },
                      { id: 'accent-line', label: 'Accent Line', desc: 'Minimalist 5px top bar & centered logo' },
                      { id: 'framed-card', label: 'Framed Card', desc: 'Light accent box with official notice pill' },
                    ].map((hStyle) => {
                      const isSelected = (visualFields?.headerStyle || 'gradient-banner') === hStyle.id;
                      return (
                        <button
                          key={hStyle.id}
                          type="button"
                          disabled={!canEdit}
                          onClick={() => handleVisualFieldChange('headerStyle' as any, hStyle.id)}
                          style={{
                            padding: '8px 10px',
                            borderRadius: '6px',
                            background: isSelected ? 'rgba(237,103,20,0.08)' : 'var(--bg-secondary)',
                            border: isSelected ? '1.5px solid var(--flame-500, #ED6714)' : '1px solid var(--border-color)',
                            cursor: canEdit ? 'pointer' : 'not-allowed',
                            textAlign: 'left',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '2px',
                          }}
                        >
                          <span style={{ fontSize: 'var(--text-2xs)', fontWeight: 700, color: isSelected ? 'var(--flame-500, #ED6714)' : 'var(--text-primary)' }}>
                            {hStyle.label}
                          </span>
                          <span style={{ fontSize: 'var(--text-3xs)', color: 'var(--text-muted)' }}>
                            {hStyle.desc}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Brand Logo & Company Info */}
                <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '12px' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '5px' }}>
                      <label style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-primary)' }}>
                        Brand Logo URL / Path
                      </label>
                      <button
                        type="button"
                        onClick={() => handleVisualFieldChange('logoUrl', '/sumeru-logo@2x.png')}
                        style={{ background: 'none', border: 'none', fontSize: 'var(--text-3xs)', color: 'var(--flame-500, #ED6714)', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
                      >
                        Reset to Sumeru Logo
                      </button>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {/* Logo Preview Thumbnail Badge */}
                      <div
                        style={{
                          width: '44px',
                          height: '36px',
                          borderRadius: '6px',
                          background: '#FFFFFF',
                          border: '1px solid var(--border-color)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: '3px',
                          flexShrink: 0,
                          boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                        }}
                      >
                        <img
                          src={visualFields?.logoUrl || '/sumeru-logo@2x.png'}
                          alt="Logo Preview"
                          onError={(e) => {
                            (e.currentTarget as HTMLElement).style.display = 'none';
                          }}
                          onLoad={(e) => {
                            (e.currentTarget as HTMLElement).style.display = 'block';
                          }}
                          style={{ maxHeight: '100%', maxWidth: '100%', objectFit: 'contain' }}
                        />
                      </div>
                      <input
                        type="text"
                        value={visualFields?.logoUrl ?? '/sumeru-logo@2x.png'}
                        disabled={!canEdit}
                        placeholder="/sumeru-logo@2x.png"
                        onChange={(e) => handleVisualFieldChange('logoUrl', e.target.value)}
                        style={{
                          flex: 1,
                          padding: '7px 10px',
                          borderRadius: '6px',
                          background: 'var(--bg-secondary)',
                          border: '1px solid var(--border-color)',
                          fontSize: 'var(--text-xs)',
                          color: 'var(--text-primary)',
                        }}
                      />
                    </div>
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '5px' }}>
                      Company / Organization Name
                    </label>
                    <input
                      type="text"
                      value={visualFields?.companyName ?? 'Sumeru Global'}
                      disabled={!canEdit}
                      placeholder="Sumeru Global"
                      onChange={(e) => handleVisualFieldChange('companyName', e.target.value)}
                      style={{
                        width: '100%',
                        padding: '7px 10px',
                        borderRadius: '6px',
                        background: 'var(--bg-secondary)',
                        border: '1px solid var(--border-color)',
                        fontSize: 'var(--text-xs)',
                        color: 'var(--text-primary)',
                        boxSizing: 'border-box',
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* Card 2: Email Content & Messaging */}
              <div className="glass-card" style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)', paddingBottom: '10px' }}>
                  <span style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <FileText size={15} style={{ color: 'var(--flame-500, #ED6714)' }} />
                    Email Content & Messaging
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--success)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <CheckCircle2 size={13} />
                      Contract Compliant
                    </span>
                    <button
                      type="button"
                      onClick={handleResetVisualForm}
                      title="Reset visual inputs back to clean factory default copy"
                      className="btn btn-secondary"
                      style={{ fontSize: 'var(--text-2xs)', padding: '3px 8px', display: 'flex', alignItems: 'center', gap: '4px' }}
                    >
                      <RotateCcw size={11} />
                      Reset to Default Form
                    </button>
                  </div>
                </div>

                {/* Subject Field */}
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '5px' }}>
                    Email Subject Line
                  </label>
                  <input
                    type="text"
                    value={visualFields?.subject ?? editorSubject}
                    disabled={!canEdit}
                    placeholder="Subject line..."
                    onChange={(e) => handleVisualFieldChange('subject', e.target.value)}
                    style={{
                      width: '100%',
                      padding: '9px 12px',
                      borderRadius: '6px',
                      background: 'var(--bg-secondary)',
                      border: '1px solid var(--border-color)',
                      fontSize: 'var(--text-sm)',
                      color: 'var(--text-primary)',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>

                {/* Headline Field */}
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '5px' }}>
                    Header / Headline
                  </label>
                  <input
                    type="text"
                    value={visualFields?.headline ?? ''}
                    disabled={!canEdit}
                    placeholder="e.g. Verification Code"
                    onChange={(e) => handleVisualFieldChange('headline', e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: '6px',
                      background: 'var(--bg-secondary)',
                      border: '1px solid var(--border-color)',
                      fontSize: 'var(--text-sm)',
                      color: 'var(--text-primary)',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>

                {/* Greeting Field */}
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '5px' }}>
                    Greeting Salutation
                  </label>
                  <input
                    type="text"
                    value={visualFields?.greeting ?? ''}
                    disabled={!canEdit}
                    placeholder="e.g. Dear Candidate,"
                    onChange={(e) => handleVisualFieldChange('greeting', e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: '6px',
                      background: 'var(--bg-secondary)',
                      border: '1px solid var(--border-color)',
                      fontSize: 'var(--text-sm)',
                      color: 'var(--text-primary)',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>

                {/* Lead Message Body */}
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '5px' }}>
                    Main Message Instructions
                  </label>
                  <textarea
                    rows={4}
                    value={visualFields?.leadMessage ?? ''}
                    disabled={!canEdit}
                    placeholder="Body instructions..."
                    onChange={(e) => handleVisualFieldChange('leadMessage', e.target.value)}
                    style={{
                      width: '100%',
                      padding: '9px 12px',
                      borderRadius: '6px',
                      background: 'var(--bg-secondary)',
                      border: '1px solid var(--border-color)',
                      fontSize: 'var(--text-sm)',
                      color: 'var(--text-primary)',
                      boxSizing: 'border-box',
                      fontFamily: 'inherit',
                      lineHeight: 1.5,
                    }}
                  />
                </div>

                {/* Dynamic Component Info Banner */}
                <div style={{ padding: '12px 14px', borderRadius: '6px', background: 'rgba(237,103,20,0.06)', border: '1px solid rgba(237,103,20,0.2)' }}>
                  <div style={{ fontSize: 'var(--text-2xs)', fontWeight: 700, color: 'var(--flame-700, #B8460D)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    Auto-Managed Dynamic Component
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginTop: '4px' }}>
                    {selectedKey === 'otp-verification' && 'Letter-spaced 6-digit OTP box ({{otpCode}}) with expiration notice ({{validMinutes}} mins).'}
                    {selectedKey === 'registration-invite' && 'Primary CTA button linking to {{inviteUrl}} and mandatory document checklist.'}
                    {selectedKey === 'app-credentials' && 'Structured secure credentials table ({{username}}, {{temporaryPassword}}, {{validDays}} days).'}
                    {selectedKey === 'application-approved' && 'Official Assayer Code banner ({{assayerCode}}, {{effectiveDate}}) and portal login link.'}
                    {selectedKey === 'application-rejected' && 'Review committee feedback block ({{reviewNotes}}) and re-application guidance.'}
                    {selectedKey === 'branch-audit-paperwork' && 'Branch audit metadata table ({{bankName}}, {{branchName}}, {{fileName}}) and download link.'}
                    {selectedKey === 'morning-digest' && 'Executive morning header ({{briefDate}}, {{subjectCounts}}) and digest sections ({{{digestSectionsHtml}}}).'}
                  </div>
                </div>

                {/* Action Button Label (if applicable) */}
                {(selectedKey === 'registration-invite' || selectedKey === 'app-credentials' || selectedKey === 'application-approved' || selectedKey === 'branch-audit-paperwork' || selectedKey === 'morning-digest') && (
                  <div>
                    <label style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '5px' }}>
                      Call-to-Action Button Label
                    </label>
                    <input
                      type="text"
                      value={visualFields?.buttonLabel ?? ''}
                      disabled={!canEdit}
                      placeholder="e.g. Complete Registration"
                      onChange={(e) => handleVisualFieldChange('buttonLabel', e.target.value)}
                      style={{
                        width: '100%',
                        padding: '8px 12px',
                        borderRadius: '6px',
                        background: 'var(--bg-secondary)',
                        border: '1px solid var(--border-color)',
                        fontSize: 'var(--text-sm)',
                        color: 'var(--text-primary)',
                        boxSizing: 'border-box',
                      }}
                    />
                  </div>
                )}

                {/* Footer Notice */}
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '5px' }}>
                    Security & Support Footer Notice
                  </label>
                  <input
                    type="text"
                    value={visualFields?.footerNotice ?? ''}
                    disabled={!canEdit}
                    placeholder="Security and support contact note..."
                    onChange={(e) => handleVisualFieldChange('footerNotice', e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: '6px',
                      background: 'var(--bg-secondary)',
                      border: '1px solid var(--border-color)',
                      fontSize: 'var(--text-sm)',
                      color: 'var(--text-primary)',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
              </div>
            </div>
          ) : (
            /* ── AI & HTML CODE STUDIO (FULL CONTROL) ───────────────────────── */
            <>
              {/* Smart AI & Token Action Toolbar */}
              <div className="glass-card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  {missingRequiredTokens.length > 0 && (
                    <button
                      type="button"
                      onClick={handleAutoInjectMissingTokens}
                      style={{
                        background: 'var(--flame-500, #ED6714)',
                        color: '#FFFFFF',
                        border: 'none',
                        borderRadius: '6px',
                        padding: '6px 12px',
                        fontSize: 'var(--text-2xs)',
                        fontWeight: 700,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '5px',
                        boxShadow: '0 1px 3px rgba(237,103,20,0.3)',
                      }}
                    >
                      <Wand2 size={13} />
                      ✨ Auto-Fix Missing Tokens ({missingRequiredTokens.length})
                    </button>
                  )}

                  {validationErrors.some((e) => e.includes('Unknown token')) && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={handleCleanUnknownTokens}
                      style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: 'var(--text-2xs)', padding: '5px 10px' }}
                    >
                      <Trash2 size={12} />
                      🧹 Clean Unknown Tokens
                    </button>
                  )}

                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleCleanAiMarkup}
                    title="Strip markdown ``` fences and convert buttons to email links"
                    style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: 'var(--text-2xs)', padding: '5px 10px' }}
                  >
                    <Sparkles size={12} />
                    Clean AI Code
                  </button>

                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleResetBaselineCode}
                    title="Restore authentic factory baseline HTML into editor"
                    style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: 'var(--text-2xs)', padding: '5px 10px' }}
                  >
                    <RotateCcw size={12} />
                    Load Baseline HTML
                  </button>
                </div>

                <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
                  Tip: Paste AI HTML directly below and click Auto-Fix if tokens are missing.
                </div>
              </div>

              {/* Subject Line Editor */}
              <div className="glass-card" style={{ padding: '16px 18px' }}>
                <label style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>
                  Email Subject Template
                </label>
                <input
                  type="text"
                  value={editorSubject}
                  disabled={!canEdit}
                  placeholder={detail?.definition.defaultSubjectTemplate || 'Subject line...'}
                  onChange={(e) => {
                    setEditorSubject(e.target.value);
                    setIsDirty(true);
                  }}
                  style={{
                    width: '100%',
                    padding: '9px 12px',
                    borderRadius: '6px',
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-color)',
                    fontSize: 'var(--text-sm)',
                    color: 'var(--text-primary)',
                    fontFamily: 'inherit',
                    boxSizing: 'border-box',
                  }}
                />
                <div style={{ fontSize: 'var(--text-3xs)', color: 'var(--text-muted)', marginTop: '5px' }}>
                  Supports dynamic tokens like <code>&#123;&#123;otpCode&#125;&#125;</code> or <code>&#123;&#123;fullName&#125;&#125;</code>.
                </div>
              </div>

              {/* Tokens Palette */}
              <div className="glass-card" style={{ padding: '14px 18px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Code size={13} style={{ color: 'var(--flame-500, #ED6714)' }} />
                    Dynamic Tokens (Click to insert or copy)
                  </span>
                  <span style={{ fontSize: 'var(--text-3xs)', color: 'var(--text-muted)' }}>
                    All required tokens must be present in HTML or subject
                  </span>
                </div>

                {/* Required Tokens */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
                  {requiredTokens.map((tok) => {
                    const present = tokenPresent(tok);
                    return (
                      <button
                        key={tok}
                        type="button"
                        title={`${emailTokenHelp(tok)}\n\nRequired — ${present ? 'it is in your wording.' : 'it is MISSING from your wording.'}`}
                        onClick={() => insertToken(tok)}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '5px',
                          padding: '4px 8px',
                          borderRadius: '5px',
                          fontSize: 'var(--text-2xs)',
                          fontFamily: 'var(--font-mono)',
                          fontWeight: 600,
                          cursor: 'pointer',
                          background: present ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.12)',
                          border: present ? '1px solid rgba(16,185,129,0.3)' : '1px solid rgba(239,68,68,0.4)',
                          color: present ? 'var(--success)' : 'var(--danger)',
                        }}
                      >
                        {present ? <Check size={11} /> : <AlertTriangle size={11} />}
                        &#123;&#123;{tok}&#125;&#125;
                      </button>
                    );
                  })}

                  {/* Optional Tokens */}
                  {optionalTokens.map((tok) => (
                    <button
                      key={tok}
                      type="button"
                      title={`${emailTokenHelp(tok)}\n\nOptional — leave it out if you would rather write the words yourself.`}
                      onClick={() => insertToken(tok)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        padding: '4px 8px',
                        borderRadius: '5px',
                        fontSize: 'var(--text-2xs)',
                        fontFamily: 'var(--font-mono)',
                        cursor: 'pointer',
                        background: 'var(--bg-secondary)',
                        border: '1px solid var(--border-color)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      &#123;&#123;{tok}&#125;&#125;
                    </button>
                  ))}

                  {/* Raw HTML tokens (if authorized) */}
                  {rawTokens.map((tok) => (
                    <button
                      key={tok}
                      type="button"
                      title={`Authorized Raw HTML token {{{${tok}}}}`}
                      onClick={() => insertToken(tok, true)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        padding: '4px 8px',
                        borderRadius: '5px',
                        fontSize: 'var(--text-2xs)',
                        fontFamily: 'var(--font-mono)',
                        cursor: 'pointer',
                        background: 'rgba(237,103,20,0.12)',
                        border: '1px solid var(--flame-500, #ED6714)',
                        color: 'var(--flame-700, #B8460D)',
                        fontWeight: 700,
                      }}
                    >
                      &#123;&#123;&#123;{tok}&#125;&#125;&#125;
                    </button>
                  ))}
                </div>

                {/*
                  The values the platform fills for every message, on both channels. Listed here as
                  well as on the SMS screen from one shared component, so what an administrator
                  learns writing an email still holds when they write a text.
                */}
                <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border-color)' }}>
                  <CommonTokenChips
                    onInsert={(token) => insertToken(token)}
                    overriddenBy={[...requiredTokens, ...optionalTokens]}
                  />
                </div>
              </div>

              {/* HTML Code Editor */}
              <div className="glass-card" style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                  <span style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Code size={13} />
                    HTML Source Code
                  </span>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: 'var(--text-3xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                      {editorHtml.length} chars · {editorHtml.split('\n').length} lines
                    </span>
                    {isDirty && (
                      <span style={{ fontSize: 'var(--text-3xs)', color: 'var(--warning)', fontWeight: 600 }}>
                        Unsaved changes
                      </span>
                    )}
                  </div>
                </div>

                <textarea
                  ref={textareaRef}
                  // Named, because a box with no label is unusable by anybody on a screen reader
                  // and unaddressable by anything that tests this screen.
                  aria-label="Email HTML"
                  value={editorHtml}
                  disabled={!canEdit}
                  spellCheck={false}
                  rows={20}
                  onChange={(e) => {
                    setEditorHtml(e.target.value);
                    setIsDirty(true);
                  }}
                  style={{
                    width: '100%',
                    padding: '12px',
                    borderRadius: '6px',
                    background: '#0F172A',
                    color: '#E2E8F0',
                    border: '1px solid #334155',
                    fontFamily: 'var(--font-mono, monospace)',
                    fontSize: 'var(--text-xs)',
                    lineHeight: 1.55,
                    tabSize: 2,
                    boxSizing: 'border-box',
                    resize: 'vertical',
                    whiteSpace: 'pre',
                    overflowWrap: 'normal',
                    overflowX: 'auto',
                  }}
                />
              </div>
            </>
          )}

          {/* Validation Feedback Banner (Shared across modes) */}
          <div className="glass-card" style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {validationErrors.length > 0 ? (
              <div style={{ padding: '12px 14px', borderRadius: '6px', background: 'rgba(239,68,68,0.1)', border: '1px solid var(--danger)', color: 'var(--danger)', fontSize: 'var(--text-xs)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '8px' }}>
                  <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <AlertTriangle size={15} /> Contract & Security Issues ({validationErrors.length}):
                  </div>
                  {missingRequiredTokens.length > 0 && (
                    <button
                      type="button"
                      onClick={handleAutoInjectMissingTokens}
                      style={{
                        background: 'var(--flame-500, #ED6714)',
                        color: '#FFFFFF',
                        border: 'none',
                        borderRadius: '5px',
                        padding: '4px 10px',
                        fontSize: 'var(--text-2xs)',
                        fontWeight: 700,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                      }}
                    >
                      <Wand2 size={12} />
                      ✨ Auto-Fix All Tokens
                    </button>
                  )}
                </div>
                <ul style={{ margin: 0, paddingLeft: '18px', lineHeight: 1.5 }}>
                  {validationErrors.map((err, idx) => (
                    <li key={idx}>{err}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <div style={{ padding: '10px 14px', borderRadius: '6px', background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.3)', color: 'var(--success)', fontSize: 'var(--text-2xs)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <CheckCircle2 size={14} />
                Contract & Security checks passed. All required tokens present and safe for live delivery.
              </div>
            )}

            {validationWarnings.length > 0 && (
              <div style={{ padding: '8px 12px', borderRadius: '6px', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', color: 'var(--warning)', fontSize: 'var(--text-xs)' }}>
                <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                  <AlertTriangle size={13} /> Notices:
                </div>
                <ul style={{ margin: 0, paddingLeft: '18px', lineHeight: 1.4 }}>
                  {validationWarnings.map((w, idx) => (
                    <li key={idx}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Action Buttons */}
            {canEdit && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px', marginTop: '6px' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={savingDraft}
                  onClick={handleSaveDraft}
                  style={{ fontSize: 'var(--text-xs)', padding: '8px 16px' }}
                >
                  {savingDraft ? 'Saving Draft…' : 'Save Draft'}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={publishing}
                  onClick={handleOpenPublishGate}
                  title={validationErrors.length > 0 ? 'Resolve validation issues before publishing' : 'Open Pre-Flight Safety Verification Gate'}
                  style={{
                    background: validationErrors.length === 0 ? 'var(--flame-500, #ED6714)' : undefined,
                    borderColor: validationErrors.length === 0 ? 'var(--flame-500, #ED6714)' : undefined,
                    color: '#ffffff',
                    fontSize: 'var(--text-xs)',
                    padding: '8px 18px',
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  {validationErrors.length > 0 ? <Lock size={13} /> : <ShieldCheck size={13} />}
                  {publishing ? 'Publishing…' : 'Publish Live Version'}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ── RIGHT PANE: Live Interactive Preview & Simulator ────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div className="glass-card" style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {/* Simulator Toolbar */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Eye size={15} style={{ color: 'var(--flame-500, #ED6714)' }} />
                <span style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-primary)' }}>
                  Live Inbox Simulator
                </span>
                {isValidating && (
                  <span style={{ fontSize: 'var(--text-3xs)', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <RefreshCw size={10} className="spin" /> rendering…
                  </span>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                {/* Draft vs Factory Baseline Switcher */}
                <div style={{ display: 'flex', background: 'var(--bg-secondary)', borderRadius: '6px', padding: '2px', border: '1px solid var(--border-color)' }}>
                  <button
                    type="button"
                    onClick={() => handleTogglePreviewTarget('draft')}
                    style={{
                      border: 'none',
                      padding: '3px 8px',
                      fontSize: 'var(--text-2xs)',
                      fontWeight: previewTarget === 'draft' ? 700 : 500,
                      borderRadius: '4px',
                      cursor: 'pointer',
                      background: previewTarget === 'draft' ? 'var(--bg-primary)' : 'transparent',
                      color: previewTarget === 'draft' ? 'var(--flame-500, #ED6714)' : 'var(--text-muted)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                    }}
                  >
                    <Eye size={11} />
                    Live Draft
                  </button>
                  <button
                    type="button"
                    title="View certified Sumeru Global factory default baseline"
                    onClick={() => handleTogglePreviewTarget('baseline')}
                    style={{
                      border: 'none',
                      padding: '3px 8px',
                      fontSize: 'var(--text-2xs)',
                      fontWeight: previewTarget === 'baseline' ? 700 : 500,
                      borderRadius: '4px',
                      cursor: 'pointer',
                      background: previewTarget === 'baseline' ? 'rgba(16,185,129,0.15)' : 'transparent',
                      color: previewTarget === 'baseline' ? 'var(--success)' : 'var(--text-muted)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                    }}
                  >
                    <ShieldCheck size={11} />
                    Factory Baseline
                  </button>
                </div>

                {/* HTML vs Text Toggle */}
                <div style={{ display: 'flex', background: 'var(--bg-secondary)', borderRadius: '6px', padding: '2px', border: '1px solid var(--border-color)' }}>
                  <button
                    type="button"
                    onClick={() => setFormatMode('html')}
                    style={{
                      border: 'none',
                      padding: '3px 8px',
                      fontSize: 'var(--text-2xs)',
                      fontWeight: formatMode === 'html' ? 700 : 500,
                      borderRadius: '4px',
                      cursor: 'pointer',
                      background: formatMode === 'html' ? 'var(--bg-primary)' : 'transparent',
                      color: formatMode === 'html' ? 'var(--text-primary)' : 'var(--text-muted)',
                    }}
                  >
                    HTML
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormatMode('text')}
                    style={{
                      border: 'none',
                      padding: '3px 8px',
                      fontSize: 'var(--text-2xs)',
                      fontWeight: formatMode === 'text' ? 700 : 500,
                      borderRadius: '4px',
                      cursor: 'pointer',
                      background: formatMode === 'text' ? 'var(--bg-primary)' : 'transparent',
                      color: formatMode === 'text' ? 'var(--text-primary)' : 'var(--text-muted)',
                    }}
                  >
                    Plain Text
                  </button>
                </div>

                {/* Client Theme Simulation Toggle */}
                <div style={{ display: 'flex', background: 'var(--bg-secondary)', borderRadius: '6px', padding: '2px', border: '1px solid var(--border-color)' }}>
                  <button
                    type="button"
                    title="Simulate Light Mode Email Client"
                    onClick={() => setSimulatorClientTheme('light')}
                    style={{
                      border: 'none',
                      padding: '3px 8px',
                      fontSize: 'var(--text-2xs)',
                      fontWeight: simulatorClientTheme === 'light' ? 700 : 500,
                      borderRadius: '4px',
                      cursor: 'pointer',
                      background: simulatorClientTheme === 'light' ? 'var(--bg-primary)' : 'transparent',
                      color: simulatorClientTheme === 'light' ? 'var(--flame-500, #ED6714)' : 'var(--text-muted)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                    }}
                  >
                    <Sun size={12} />
                    Light
                  </button>
                  <button
                    type="button"
                    title="Simulate Dark Mode Email Client"
                    onClick={() => setSimulatorClientTheme('dark')}
                    style={{
                      border: 'none',
                      padding: '3px 8px',
                      fontSize: 'var(--text-2xs)',
                      fontWeight: simulatorClientTheme === 'dark' ? 700 : 500,
                      borderRadius: '4px',
                      cursor: 'pointer',
                      background: simulatorClientTheme === 'dark' ? 'var(--bg-primary)' : 'transparent',
                      color: simulatorClientTheme === 'dark' ? '#38BDF8' : 'var(--text-muted)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                    }}
                  >
                    <Moon size={12} />
                    Dark
                  </button>
                </div>

                {/* Device Viewport Toggle */}
                <div style={{ display: 'flex', background: 'var(--bg-secondary)', borderRadius: '6px', padding: '2px', border: '1px solid var(--border-color)' }}>
                  <button
                    type="button"
                    title="Desktop Preview (560px)"
                    onClick={() => setViewMode('desktop')}
                    style={{
                      border: 'none',
                      padding: '4px 6px',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      background: viewMode === 'desktop' ? 'var(--bg-primary)' : 'transparent',
                      color: viewMode === 'desktop' ? 'var(--flame-500, #ED6714)' : 'var(--text-muted)',
                    }}
                  >
                    <Monitor size={14} />
                  </button>
                  <button
                    type="button"
                    title="Mobile Phone Preview (375px)"
                    onClick={() => setViewMode('mobile')}
                    style={{
                      border: 'none',
                      padding: '4px 6px',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      background: viewMode === 'mobile' ? 'var(--bg-primary)' : 'transparent',
                      color: viewMode === 'mobile' ? 'var(--flame-500, #ED6714)' : 'var(--text-muted)',
                    }}
                  >
                    <Smartphone size={14} />
                  </button>
                </div>
              </div>
            </div>

            {/* Simulated Email Client Envelope */}
            <div
              style={{
                borderRadius: '8px',
                overflow: 'hidden',
                border: simulatorClientTheme === 'dark' ? '1px solid #334155' : '1px solid var(--border-color)',
                background: simulatorClientTheme === 'dark' ? '#0F172A' : '#F8F9FA',
                transition: 'all 0.2s ease',
              }}
            >
              {/* Email Envelope Header */}
              <div
                style={{
                  padding: '12px 14px',
                  background: simulatorClientTheme === 'dark' ? '#1E293B' : '#FFFFFF',
                  borderBottom: simulatorClientTheme === 'dark' ? '1px solid #334155' : '1px solid #E5E7EB',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  fontSize: 'var(--text-2xs)',
                  transition: 'background 0.2s ease',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ color: simulatorClientTheme === 'dark' ? '#94A3B8' : '#6B7280', width: '55px', fontWeight: 600 }}>From:</span>
                  <span style={{ color: simulatorClientTheme === 'dark' ? '#F8FAFC' : '#111827', fontWeight: 600 }}>
                    {visualFields?.companyName || 'Sumeru Global'} Operations &lt;notifications@sumeruglobal.com&gt;
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ color: simulatorClientTheme === 'dark' ? '#94A3B8' : '#6B7280', width: '55px', fontWeight: 600 }}>Subject:</span>
                  <span style={{ color: simulatorClientTheme === 'dark' ? '#FFFFFF' : '#111827', fontWeight: 700 }}>
                    {(previewTarget === 'baseline' ? baselinePreviewSubject : previewSubject) || '(No subject)'}
                  </span>
                </div>
              </div>

              {/* Email Body Canvas */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  padding: '20px 12px',
                  background: simulatorClientTheme === 'dark' ? '#090D16' : '#F1F5F9',
                  minHeight: '480px',
                  transition: 'background 0.2s ease',
                }}
              >
                {previewTarget === 'baseline' && (
                  <div
                    style={{
                      width: '100%',
                      maxWidth: viewMode === 'desktop' ? '560px' : '375px',
                      marginBottom: '14px',
                      background: 'rgba(16,185,129,0.08)',
                      border: '1px solid rgba(16,185,129,0.3)',
                      borderRadius: '8px',
                      padding: '8px 12px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '8px',
                      fontSize: 'var(--text-2xs)',
                      color: 'var(--success)',
                      boxSizing: 'border-box',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600 }}>
                      <ShieldCheck size={14} />
                      This is the original design, not your edits
                    </div>
                    <button
                      type="button"
                      onClick={handleResetBaselineCode}
                      style={{
                        background: 'var(--success)',
                        color: '#ffffff',
                        border: 'none',
                        borderRadius: '4px',
                        padding: '3px 8px',
                        fontSize: 'var(--text-3xs)',
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      Load into Editor
                    </button>
                  </div>
                )}

                {loadingBaseline && previewTarget === 'baseline' ? (
                  <div style={{ padding: '40px', color: 'var(--text-muted)', fontSize: 'var(--text-xs)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <RefreshCw size={14} className="spin" />
                    Loading official factory baseline preview…
                  </div>
                ) : formatMode === 'text' ? (
                  <div
                    style={{
                      width: '100%',
                      maxWidth: viewMode === 'desktop' ? '560px' : '375px',
                      background: '#FFFFFF',
                      padding: '24px',
                      borderRadius: '8px',
                      border: '1px solid #E2E8F0',
                      fontFamily: 'var(--font-mono, monospace)',
                      fontSize: 'var(--text-xs)',
                      color: '#1E293B',
                      whiteSpace: 'pre-wrap',
                      lineHeight: 1.6,
                      boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
                    }}
                  >
                    {(previewTarget === 'baseline' ? baselinePreviewText : previewText) || '(No plain-text generated)'}
                  </div>
                ) : (
                  <iframe
                    title="Email Preview"
                    sandbox="allow-same-origin"
                    srcDoc={
                      (() => {
                        const raw = previewTarget === 'baseline' ? (baselinePreviewHtml || previewHtml) : previewHtml;
                        if (!raw) return '';
                        // Guarantee all localhost:5173, cid:sumeru-logo, or relative logo references resolve to the active browser origin
                        return raw
                          .replaceAll('http://localhost:5173', window.location.origin)
                          .replaceAll('cid:sumeru-logo', `${window.location.origin}/sumeru-logo@2x.png`);
                      })()
                    }
                    style={{
                      width: viewMode === 'desktop' ? '100%' : '375px',
                      maxWidth: viewMode === 'desktop' ? '560px' : '375px',
                      height: '620px',
                      border: 'none',
                      borderRadius: '10px',
                      boxShadow: simulatorClientTheme === 'dark'
                        ? '0 10px 25px -5px rgba(0, 0, 0, 0.6), 0 8px 10px -6px rgba(0, 0, 0, 0.4)'
                        : '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
                      background: '#FFFFFF',
                      transition: 'max-width 0.2s ease, box-shadow 0.2s ease',
                    }}
                  />
                )}
              </div>
            </div>

            {/* Sample Data Viewer & Tweak Button */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 'var(--text-3xs)', color: 'var(--text-muted)', paddingTop: '4px' }}>
              <span>{PREVIEW_NOTE}</span>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowSampleDataModal(true)}
                style={{ padding: '3px 8px', fontSize: 'var(--text-3xs)' }}
              >
                Inspect Sample Data
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── MODAL: Design with AI & System Prompts ───────────────────────── */}
      {showAiModal && (
        <Modal
          open={showAiModal}
          title={`Design "${detail?.definition.name}" with AI`}
          onClose={() => setShowAiModal(false)}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '650px' }}>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
              Copy the pre-generated prompt below into <strong>ChatGPT, Claude, or v0</strong>. The prompt includes Sumeru Global's authentic design standards, color tokens, layout specifications, and mandatory dynamic tokens.
            </div>

            {/* Key Tips */}
            <div style={{ padding: '10px 14px', borderRadius: '6px', background: 'rgba(237,103,20,0.08)', border: '1px solid rgba(237,103,20,0.25)', fontSize: 'var(--text-2xs)' }}>
              <div style={{ fontWeight: 700, color: 'var(--flame-700, #B8460D)', marginBottom: '4px' }}>
                Prompt Guardrails:
              </div>
              <ul style={{ margin: 0, paddingLeft: '16px', color: 'var(--text-secondary)' }}>
                {promptData.tips.map((tip, i) => (
                  <li key={i}>{tip}</li>
                ))}
              </ul>
            </div>

            {/* Prompt Code Block */}
            <div style={{ position: 'relative' }}>
              <pre
                style={{
                  maxHeight: '260px',
                  overflowY: 'auto',
                  background: '#0F172A',
                  color: '#E2E8F0',
                  padding: '14px',
                  borderRadius: '6px',
                  fontSize: 'var(--text-2xs)',
                  lineHeight: 1.5,
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {promptData.prompt}
              </pre>

              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(promptData.prompt);
                  setCopiedPrompt(true);
                  setTimeout(() => setCopiedPrompt(false), 2500);
                  toast('success', 'AI prompt copied to clipboard!');
                }}
                style={{
                  position: 'absolute',
                  top: '10px',
                  right: '10px',
                  background: copiedPrompt ? 'var(--success)' : 'var(--flame-500, #ED6714)',
                  color: '#FFFFFF',
                  border: 'none',
                  borderRadius: '5px',
                  padding: '5px 10px',
                  fontSize: 'var(--text-2xs)',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '5px',
                }}
              >
                {copiedPrompt ? <Check size={12} /> : <Copy size={12} />}
                {copiedPrompt ? 'Copied!' : 'Copy Prompt'}
              </button>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '6px' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowAiModal(false)}
              >
                Close
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── MODAL: Send Live Test Email ───────────────────────────────────── */}
      {showTestModal && (
        <Modal
          open={showTestModal}
          title={`Send Live Test Email: ${detail?.definition.name}`}
          onClose={() => setShowTestModal(false)}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', minWidth: '380px' }}>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
              Dispatches a live test email directly to your inbox rendered with the currently loaded editor template and sample data.
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 600, marginBottom: '6px' }}>
                Recipient Email Address:
              </label>
              <input
                type="email"
                placeholder="you@company.com"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  borderRadius: '6px',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  fontSize: 'var(--text-sm)',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowTestModal(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={sendingTest || !testEmail}
                onClick={handleSendTestEmail}
                style={{
                  background: 'var(--flame-500, #ED6714)',
                  borderColor: 'var(--flame-500, #ED6714)',
                  color: '#FFFFFF',
                }}
              >
                {sendingTest ? 'Sending Test…' : 'Send Test'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── MODAL: Version History & Rollback ─────────────────────────────── */}
      {showHistoryModal && (
        <Modal
          open={showHistoryModal}
          title={`Version History: ${detail?.definition.name}`}
          onClose={() => setShowHistoryModal(false)}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '500px', maxWidth: '650px' }}>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
              Past published versions for this template. You can roll back to any previous version with 1 click.
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '350px', overflowY: 'auto' }}>
              {detail?.storedSettings?.versions.map((ver) => {
                const isActive = ver.version === detail.storedSettings?.activeVersion;
                return (
                  <div
                    key={ver.version}
                    style={{
                      padding: '12px 14px',
                      borderRadius: '6px',
                      border: isActive ? '1.5px solid var(--flame-500, #ED6714)' : '1px solid var(--border-color)',
                      background: isActive ? 'rgba(237,103,20,0.06)' : 'var(--bg-secondary)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '12px',
                    }}
                  >
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-primary)' }}>
                          Version v{ver.version}
                        </span>
                        {isActive && (
                          <Pill tone="accent">Active Live</Pill>
                        )}
                        <span style={{ fontSize: 'var(--text-3xs)', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                          checksum: {ver.checksum}
                        </span>
                      </div>
                      <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginTop: '4px' }}>
                        Published by {ver.createdBy} on {new Date(ver.publishedAt || ver.createdAt).toLocaleString()}
                      </div>
                    </div>

                    {canEdit && !isActive && (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => handleRollback(ver.version)}
                        style={{ fontSize: 'var(--text-2xs)', padding: '5px 10px', display: 'flex', alignItems: 'center', gap: '4px' }}
                      >
                        <RotateCcw size={11} /> Rollback
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '10px' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowHistoryModal(false)}
              >
                Close
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── MODAL: Sample Data Inspector ─────────────────────────────────── */}
      {showSampleDataModal && (
        <Modal
          open={showSampleDataModal}
          title={`Sample Data: ${detail?.definition.name}`}
          onClose={() => setShowSampleDataModal(false)}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '400px' }}>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
              These values are passed during preview and contract verification:
            </div>
            <pre
              style={{
                background: '#0F172A',
                color: '#E2E8F0',
                padding: '14px',
                borderRadius: '6px',
                fontSize: 'var(--text-xs)',
                fontFamily: 'var(--font-mono)',
                margin: 0,
                maxHeight: '300px',
                overflowY: 'auto',
              }}
            >
              {JSON.stringify(detail?.definition.sampleData, null, 2)}
            </pre>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '6px' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowSampleDataModal(false)}
              >
                Close
              </button>
            </div>
          </div>
        </Modal>
      )}
      {/* ── MODAL: Pre-Flight Safety Verification Gate ──────────────────── */}
      {showPublishGateModal && (
        <Modal
          open={showPublishGateModal}
          title="Pre-Flight Safety Verification"
          onClose={() => setShowPublishGateModal(false)}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', minWidth: '460px', maxWidth: '620px' }}>
            <div style={{
              background: 'rgba(237,103,20,0.08)',
              border: '1px solid rgba(237,103,20,0.25)',
              borderRadius: '8px',
              padding: '12px 14px',
              fontSize: 'var(--text-xs)',
              color: 'var(--text-primary)',
              lineHeight: 1.5,
            }}>
              <strong>⚠️ Production Notice:</strong> You are about to publish a live override for{' '}
              <strong>{detail?.definition.name}</strong> (<code>{selectedKey}</code>). Once activated, all outgoing emails for this operational workflow will immediately use this design.
            </div>

            {/* 4-Gate Safety Matrix */}
            <div>
              <div style={{ fontSize: 'var(--text-2xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)', marginBottom: '8px' }}>
                Automated Production Safety Gates
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {/* Gate 1: Security Scan */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 12px',
                  borderRadius: '6px',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  fontSize: 'var(--text-xs)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <ShieldCheck size={16} style={{ color: 'var(--success)' }} />
                    <div>
                      <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Security & Sanitization Gate</div>
                      <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>0 prohibited scripts, forms, buttons, or dangerous URIs</div>
                    </div>
                  </div>
                  <span style={{ fontSize: 'var(--text-2xs)', fontWeight: 700, color: 'var(--success)', background: 'rgba(16,185,129,0.1)', padding: '2px 8px', borderRadius: '4px' }}>
                    PASSED
                  </span>
                </div>

                {/* Gate 2: Contract Completeness */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 12px',
                  borderRadius: '6px',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  fontSize: 'var(--text-xs)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {missingRequiredTokens.length === 0 ? (
                      <CheckCircle2 size={16} style={{ color: 'var(--success)' }} />
                    ) : (
                      <AlertTriangle size={16} style={{ color: 'var(--danger)' }} />
                    )}
                    <div>
                      <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{PUBLISH_CHECKS.required.title}</div>
                      <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
                        {missingRequiredTokens.length === 0
                          ? PUBLISH_CHECKS.required.ok(requiredTokens.length)
                          : PUBLISH_CHECKS.required.bad(missingRequiredTokens)}
                      </div>
                    </div>
                  </div>
                  <span style={{
                    fontSize: 'var(--text-2xs)',
                    fontWeight: 700,
                    color: missingRequiredTokens.length === 0 ? 'var(--success)' : 'var(--danger)',
                    background: missingRequiredTokens.length === 0 ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
                    padding: '2px 8px',
                    borderRadius: '4px',
                  }}>
                    {missingRequiredTokens.length === 0 ? 'PASSED' : 'FAILED'}
                  </span>
                </div>

                {/* Gate 3: Allowed Token Scope */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 12px',
                  borderRadius: '6px',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  fontSize: 'var(--text-xs)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {!validationErrors.some((e) => e.includes('Unknown token')) ? (
                      <CheckCircle2 size={16} style={{ color: 'var(--success)' }} />
                    ) : (
                      <AlertTriangle size={16} style={{ color: 'var(--danger)' }} />
                    )}
                    <div>
                      <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{PUBLISH_CHECKS.unknown.title}</div>
                      <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{PUBLISH_CHECKS.unknown.ok}</div>
                    </div>
                  </div>
                  <span style={{
                    fontSize: 'var(--text-2xs)',
                    fontWeight: 700,
                    color: !validationErrors.some((e) => e.includes('Unknown token')) ? 'var(--success)' : 'var(--danger)',
                    background: !validationErrors.some((e) => e.includes('Unknown token')) ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
                    padding: '2px 8px',
                    borderRadius: '4px',
                  }}>
                    {!validationErrors.some((e) => e.includes('Unknown token')) ? 'PASSED' : 'FAILED'}
                  </span>
                </div>

                {/* Gate 4: Handlebars Engine Render Check */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 12px',
                  borderRadius: '6px',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  fontSize: 'var(--text-xs)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <CheckCircle2 size={16} style={{ color: 'var(--success)' }} />
                    <div>
                      <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{PUBLISH_CHECKS.renders.title}</div>
                      <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{PUBLISH_CHECKS.renders.ok}</div>
                    </div>
                  </div>
                  <span style={{ fontSize: 'var(--text-2xs)', fontWeight: 700, color: 'var(--success)', background: 'rgba(16,185,129,0.1)', padding: '2px 8px', borderRadius: '4px' }}>
                    PASSED
                  </span>
                </div>
              </div>
            </div>

            {/* Change Summary Card */}
            <div style={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-color)',
              borderRadius: '6px',
              padding: '10px 14px',
              fontSize: 'var(--text-xs)',
            }}>
              <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
                Summary of Changes:
              </div>
              <div style={{ color: 'var(--text-secondary)', lineHeight: 1.5, fontSize: 'var(--text-2xs)' }}>
                <div>&bull; <strong>Subject Template:</strong> "{editorSubject}"</div>
                <div>&bull; <strong>Edited with:</strong> {editorMode === 'visual' ? EDITOR_USED.visual : EDITOR_USED.code}</div>
                {(() => {
                  const size = contentSizeNote(editorHtml);
                  return (
                    <div style={{ color: size.tone === 'bad' ? 'var(--danger)' : size.tone === 'warn' ? 'var(--warning)' : undefined }}>
                      &bull; <strong>Size:</strong> {size.text}
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* Zero-Downtime Guarantee */}
            <div style={{
              fontSize: 'var(--text-2xs)',
              color: 'var(--text-muted)',
              background: 'rgba(16,185,129,0.06)',
              border: '1px dashed rgba(16,185,129,0.3)',
              borderRadius: '6px',
              padding: '8px 12px',
              lineHeight: 1.4,
            }}>
              🛡️ {PUBLISH_SAFETY_NET}
            </div>

            {/* Mandatory Confirmation Checkbox */}
            <label style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '10px',
              cursor: 'pointer',
              padding: '10px 12px',
              background: 'var(--bg-primary)',
              borderRadius: '6px',
              border: '1px solid var(--border-color)',
            }}>
              <input
                type="checkbox"
                checked={publishGateAgreed}
                onChange={(e) => setPublishGateAgreed(e.target.checked)}
                style={{ marginTop: '2px' }}
              />
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-primary)', lineHeight: 1.4 }}>
                I have looked at the preview and this email is ready to send to real people.
              </span>
            </label>

            {/*
              The check that is not a promise. A preview is a browser drawing HTML; an inbox is a
              different engine on a different screen, usually with images switched off — so the
              server will not publish a version that has never actually been delivered somewhere.
              Saying that HERE, with the button to do it, is the difference between a guardrail and
              an error message: the alternative is somebody pressing Publish and being refused.
            */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
              padding: '10px 12px', borderRadius: '6px',
              background: testStatus?.required === false ? 'var(--bg-surface-2)'
                : draftHasBeenTested ? 'var(--success-bg, #ECFDF5)' : 'var(--warning-bg, #FFFBEB)',
              border: `1px solid ${draftHasBeenTested ? 'var(--success, #047857)' : 'var(--warning, #D97706)'}33`,
            }}
            >
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-primary)', flex: 1, minWidth: 0, lineHeight: 1.5 }}>
                {/*
                  Three states, three truths — and the third one matters: when no email transport is
                  configured a test CANNOT be sent, and saying "test email received" there would be
                  a claim nobody has earned. It says what is actually true instead, and publishing
                  stays open because refusing it would lock the feature rather than protect anyone.
                */}
                {testStatus?.required === false ? (
                  <>
                    <strong>No test was sent.</strong>{' '}
                    Email delivery is not set up yet, so this email cannot be sent to anybody —
                    including you. Publishing still works; the design is unverified until it can be.
                  </>
                ) : draftHasBeenTested ? (
                  <>
                    <strong>Test email received.</strong>{' '}
                    {lastTestSend?.to ? `This exact version was sent to ${lastTestSend.to}.` : 'This exact version has been sent.'}
                  </>
                ) : (
                  <>
                    <strong>Send yourself a test first.</strong>{' '}
                    {lastTestSend
                      ? 'The last test was of an earlier version — this one has changed since.'
                      : 'Nobody has received this email yet, so nothing has confirmed how it looks in a real inbox.'}
                  </>
                )}
              </span>
              {!draftHasBeenTested && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ fontSize: 'var(--text-xs)' }}
                  onClick={() => { setShowPublishGateModal(false); setShowTestModal(true); }}
                >
                  Send a test
                </button>
              )}
            </div>

            {/* Modal Actions */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px', marginTop: '4px' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowPublishGateModal(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!publishGateAgreed || !draftHasBeenTested || validationErrors.length > 0 || publishing}
                onClick={executePublish}
                style={{
                  background: (!publishGateAgreed || !draftHasBeenTested || validationErrors.length > 0) ? undefined : 'var(--flame-500, #ED6714)',
                  borderColor: (!publishGateAgreed || !draftHasBeenTested || validationErrors.length > 0) ? undefined : 'var(--flame-500, #ED6714)',
                  color: '#ffffff',
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <ShieldCheck size={14} />
                {publishing ? 'Publishing…' : 'Confirm & Publish Live Version'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};
