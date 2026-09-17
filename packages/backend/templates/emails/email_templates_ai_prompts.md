# Sumeru Global FAPOMS — AI Email Template Design Catalog & System Prompts

This catalog provides ready-to-copy system prompts tailored for designing FAPOMS transactional email templates with modern AI tools (**ChatGPT, Claude, v0, Cursor, Gemini**).

---

## Universal Design & Compliance Rules for AI Tools

When feeding these prompts to any AI model, the following architectural and security guardrails **must be adhered to strictly**:

### 1. Mandatory Brand Elements
- **Organization**: Sumeru Global — Field Assayer & Portfolio Operations Management System (FAPOMS)
- **Primary Brand Color**: Vibrant Flame Orange (`#ED6714`)
- **Secondary / Text Colors**: Slate Dark (`#1E293B`), Charcoal (`#334155`), Muted Gray (`#64748B`), Border Gray (`#E2E8F0`)
- **Background**: Soft cool gray (`#F8FAFC`) with central pure white container card (`#FFFFFF`)
- **Typography**: Clean, professional system fonts (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`)
- **Header Logo**: Sumeru Global official emblem:
  ```html
  <img src="https://app.sumeruglobal.com/logo.png" alt="Sumeru Global" width="160" style="display:block; max-height:42px; width:auto; border:0;" />
  ```

### 2. Email Client Compatibility (HTML Email Standards)
- Single 600px width responsive centered container (`max-width: 600px; width: 100%; margin: 0 auto;`).
- All styles **MUST BE INLINE CSS** (`style="..."`). Do NOT use external `<link rel="stylesheet">` or separate `<style>` tags that may be stripped by Gmail or Outlook.
- Table-based layout (`<table cellpadding="0" cellspacing="0" border="0">`) or bulletproof email divs.
- Responsive for mobile screens: wrap text, buttons at least 44px height for touch targets.

### 3. Strict Token Preservation Contract
- **DO NOT MODIFY OR RENAME TOKENS**: All tokens are case-sensitive and must be written exactly as `{{tokenName}}`.
- Standard tokens use double braces `{{tokenName}}`. They are automatically escaped against XML/HTML injection.
- Raw HTML tokens use triple braces `{{{rawTokenName}}}` and are **ONLY** permitted on templates that explicitly declare them (e.g. `{{{digestSectionsHtml}}}` in Morning Digest).
- Do not remove any required tokens from the template design; the validation engine will reject the template if any required token is missing.

### 4. Security Rules (Automated Scanner Rejections)
Templates containing any of the following will be **immediately rejected** by the security validator:
- `<script>` tags
- `<iframe>` or `<object>` or `<embed>` tags
- `<form>`, `<input>`, or `<button type="submit">` tags
- JavaScript URI schemes (`href="javascript:..."` or `src="javascript:..."`)
- Event handler attributes (`onclick=`, `onload=`, `onerror=`, `onmouseover=`, etc.)

---

## How to Customize & Deploy a Template

1. **Copy the Prompt**: Copy the dedicated prompt for the template you want to redesign from below.
2. **Generate with AI**: Paste into Claude, ChatGPT, or v0.
3. **Validate & Test**:
   - **Via Platform UI / API**:
     - `POST /notification-admin/email-templates/{key}/validate` with `{ "html": "..." }`
     - `POST /notification-admin/email-templates/{key}/preview` with `{ "html": "..." }`
     - `POST /notification-admin/email-templates/{key}/test` with `{ "to": "your-email@domain.com", "html": "..." }`
     - `POST /notification-admin/email-templates/{key}/publish` to make it live!
   - **Or via Filesystem**:
     - Save your HTML file directly into `packages/backend/templates/emails/{key}.html`.
     - Keep the manifest comment header at the top of the file.
     - The template loader will automatically detect changes on disk without server restarts.

---

## 1. OTP Verification (`otp-verification`)

### Template Metadata
- **Template Key**: `otp-verification`
- **Purpose**: Candidate email verification code during public registration
- **Category**: Security / Authentication
- **Allow Raw HTML**: No (Strictly Escaped)

### Token Contract
| Token Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `{{otpCode}}` | Escaped | **Yes** | 6-digit verification code (e.g., `482910`) |
| `{{validMinutes}}` | Escaped | **Yes** | Number of minutes before expiry (e.g., `5`) |
| `{{logoUrl}}` | Escaped | **Yes** | Brand logo URL |
| `{{supportEmail}}` | Escaped | **Yes** | Support email address (e.g., `support@sumeruglobal.com`) |

### AI Prompt (Copy & Paste)
```markdown
You are an expert HTML email designer. Create a high-converting, enterprise-grade, beautifully branded transactional HTML email for Sumeru Global (Field Assayer & Portfolio Operations Management System - FAPOMS).

The email purpose is sending a 6-digit OTP verification code to an appraiser candidate verifying their email address during onboarding.

BRAND GUIDELINES:
- Primary Accent: #ED6714 (Flame Orange)
- Background: #F8FAFC (Cool Light Gray)
- Card Container: #FFFFFF (White) with subtle border (#E2E8F0) and rounded corners (12px)
- Text Color: Primary #1E293B, Secondary #64748B
- Logo URL: {{logoUrl}}

TECHNICAL REQUIREMENTS:
- 100% Inline CSS styles.
- Max-width 600px, centered container.
- High visual hierarchy: Header with logo, title, explanatory text, large prominent OTP code box, expiration notice, security disclaimer, footer.
- The OTP box should feature large, letter-spaced, bold monospace digits (e.g., 32px font, bold, letter-spacing: 8px, colored in #ED6714, on a clean light-orange background #FFF7ED with border 1px solid #FFEDD5).
- Include a security notice warning the user never to share their code.

CRITICAL TOKEN RULES (DO NOT CHANGE OR OMIT):
You MUST include these exact placeholder tokens in double curly braces:
- {{logoUrl}} -> In the <img> src attribute
- {{otpCode}} -> Inside the prominent OTP display box
- {{validMinutes}} -> In the expiration statement (e.g. "Valid for {{validMinutes}} minutes")
- {{supportEmail}} -> In the support contact footer

Do NOT use any <script>, <iframe>, <form>, or onclick handlers.
Output ONLY the clean, raw HTML code.
```

---

## 2. Candidate Registration Invitation (`registration-invite`)

### Template Metadata
- **Template Key**: `registration-invite`
- **Purpose**: Personalized invite link sent to prospective appraisers to complete their application
- **Category**: Recruitment / HR Onboarding
- **Allow Raw HTML**: No (Strictly Escaped)

### Token Contract
| Token Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `{{candidateName}}` | Escaped | **Yes** | Candidate's full name (e.g., `Amit Sharma`) |
| `{{inviteLink}}` | Escaped | **Yes** | Secure personalized registration URL |
| `{{expiresHours}}` | Escaped | **Yes** | Hours until token expires (e.g., `48`) |
| `{{supportEmail}}` | Escaped | **Yes** | Support email address |

### AI Prompt (Copy & Paste)
```markdown
You are an expert HTML email designer. Create an executive-grade, beautifully branded transactional HTML email for Sumeru Global (Field Assayer & Portfolio Operations Management System - FAPOMS).

The email purpose is welcoming a candidate appraiser and inviting them to complete their digital onboarding dossier and document upload.

BRAND GUIDELINES:
- Primary Accent: #ED6714 (Flame Orange)
- Background: #F8FAFC (Cool Light Gray)
- Card Container: #FFFFFF (White) with border (#E2E8F0) and rounded corners (12px)
- Text Color: Primary #1E293B, Secondary #475569
- Logo: <img src="https://app.sumeruglobal.com/logo.png" alt="Sumeru Global" width="160" />

TECHNICAL REQUIREMENTS:
- 100% Inline CSS. Max-width 600px centered container.
- Clean, welcoming header with Sumeru Global logo.
- Personalized greeting for the candidate.
- Clear 3-step checklist showing what they will need:
  1. Personal & Bank KYC Details (PAN, Aadhaar, Bank Account & IFSC)
  2. Experience & Qualification Certificates
  3. Digital Document Uploads
- Prominent, bulletproof call-to-action button: "Complete Registration &rarr;" linking to {{inviteLink}}
- Fallback clickable URL link printed out for users whose email clients block buttons.
- Expiration callout badge showing {{expiresHours}} hours validity.
- Help footer with {{supportEmail}}.

CRITICAL TOKEN RULES (DO NOT CHANGE OR OMIT):
You MUST include these exact placeholder tokens:
- {{candidateName}} -> Candidate name greeting
- {{inviteLink}} -> Both in the href of the primary CTA button AND as readable link text
- {{expiresHours}} -> In the validity timeframe notice
- {{supportEmail}} -> In the support footer

Do NOT use any <script>, <iframe>, <form>, or onclick handlers.
Output ONLY the clean, raw HTML code.
```

---

## 3. App Access Credentials (`app-credentials`)

### Template Metadata
- **Template Key**: `app-credentials`
- **Purpose**: Delivery of newly provisioned mobile app & portal credentials
- **Category**: Security / Account Provisioning
- **Allow Raw HTML**: No (Strictly Escaped)

### Token Contract
| Token Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `{{assayerName}}` | Escaped | **Yes** | Appraiser's display name |
| `{{username}}` | Escaped | **Yes** | System login username / Assayer ID |
| `{{temporaryPassword}}` | Escaped | **Yes** | Temporary one-time password |
| `{{validDays}}` | Escaped | **Yes** | Validity duration in days (e.g., `7`) |
| `{{portalUrl}}` | Escaped | **Yes** | Portal login URL |
| `{{supportEmail}}` | Escaped | **Yes** | IT Support email |

### AI Prompt (Copy & Paste)
```markdown
You are an expert HTML email designer. Create a secure, polished, enterprise transactional HTML email for Sumeru Global (Field Assayer & Portfolio Operations Management System - FAPOMS).

The email purpose is delivering newly provisioned account credentials (username & temporary password) to an authorized field appraiser for logging into the FAPOMS Mobile App and Portal.

BRAND GUIDELINES:
- Primary Accent: #ED6714 (Flame Orange)
- Background: #F8FAFC
- Card Container: #FFFFFF with subtle border (#E2E8F0) and rounded corners (12px)
- Typography: System sans-serif

TECHNICAL REQUIREMENTS:
- 100% Inline CSS. Max-width 600px centered container.
- Elegant header with Sumeru Global logo.
- High-security credentials card:
  - Table or structured key-value grid containing:
    - Appraiser Name: {{assayerName}}
    - Username / ID: {{username}} (bold, prominent)
    - Temporary Password: {{temporaryPassword}} (monospace font, highlighted in secure light badge)
    - Password Validity: {{validDays}} days
- Primary CTA Button: "Sign In to FAPOMS Portal" linking to {{portalUrl}}.
- Security warning box with soft warning background (#FEF3C7) and amber border (#F59E0B):
  - Instructions to change password immediately upon initial sign-in.
  - Advisory that Sumeru Global staff will never ask for their password.
- Footer with IT Helpdesk link {{supportEmail}}.

CRITICAL TOKEN RULES (DO NOT CHANGE OR OMIT):
You MUST include these exact placeholder tokens:
- {{assayerName}}
- {{username}}
- {{temporaryPassword}}
- {{validDays}}
- {{portalUrl}}
- {{supportEmail}}

Do NOT use any <script>, <iframe>, <form>, or onclick handlers.
Output ONLY the clean, raw HTML code.
```

---

## 4. Application Approved (`application-approved`)

### Template Metadata
- **Template Key**: `application-approved`
- **Purpose**: Official notice of application approval and appraiser code issuance
- **Category**: Recruitment / Certification
- **Allow Raw HTML**: No (Strictly Escaped)

### Token Contract
| Token Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `{{candidateName}}` | Escaped | **Yes** | Candidate's name |
| `{{assayerCode}}` | Escaped | **Yes** | Official Assayer Code (e.g., `ASY-2026-0842`) |
| `{{loginUrl}}` | Escaped | **Yes** | FAPOMS Portal URL |
| `{{supportEmail}}` | Escaped | **Yes** | Support email |
| `{{remarks}}` | Escaped | *Optional* | Committee approval notes or condition remarks |

### AI Prompt (Copy & Paste)
```markdown
You are an expert HTML email designer. Create a celebratory, prestigious, and official transactional HTML email for Sumeru Global (Field Assayer & Portfolio Operations Management System - FAPOMS).

The email purpose is congratulating a candidate whose appraiser application has been officially approved, announcing their new official Assayer Code, and onboarding them to active roster status.

BRAND GUIDELINES:
- Primary Accent: #ED6714 (Flame Orange)
- Success Highlight: #10B981 (Emerald Green)
- Background: #F8FAFC
- Card Container: #FFFFFF with border (#E2E8F0) and rounded corners (12px)

TECHNICAL REQUIREMENTS:
- 100% Inline CSS. Max-width 600px centered container.
- Celebratory banner or status badge: "Application Approved — Welcome to the Network".
- Personalized greeting to {{candidateName}}.
- Official Certification Box:
  - Official Appraiser Code: {{assayerCode}} (styled in prominent, bold font)
  - Standing: Active Roster Ready
  - Next Steps: Operations will assign bank branch audits directly via FAPOMS.
- Optional committee notes section displaying {{remarks}}.
- Primary CTA Button: "Open FAPOMS Portal" linking to {{loginUrl}}.
- Security footer highlighting that {{assayerCode}} is required during bank branch audit identity verification.
- Support footer with {{supportEmail}}.

CRITICAL TOKEN RULES (DO NOT CHANGE OR OMIT):
You MUST include these exact placeholder tokens:
- {{candidateName}}
- {{assayerCode}}
- {{loginUrl}}
- {{supportEmail}}
- {{remarks}} (can be in an optional or small remarks section)

Do NOT use any <script>, <iframe>, <form>, or onclick handlers.
Output ONLY the clean, raw HTML code.
```

---

## 5. Application Rejected (`application-rejected`)

### Template Metadata
- **Template Key**: `application-rejected`
- **Purpose**: Formal notice of application rejection with review remarks
- **Category**: Recruitment / Review Committee
- **Allow Raw HTML**: No (Strictly Escaped)

### Token Contract
| Token Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `{{candidateName}}` | Escaped | **Yes** | Candidate's name |
| `{{remarks}}` | Escaped | **Yes** | Review notes / Reason for rejection |
| `{{supportEmail}}` | Escaped | **Yes** | Recruitment inquiries email |

### AI Prompt (Copy & Paste)
```markdown
You are an expert HTML email designer. Create a respectful, professional, and formal transactional HTML email for Sumeru Global (Field Assayer & Portfolio Operations Management System - FAPOMS).

The email purpose is formally informing a candidate that their appraiser onboarding application was not approved by the verification committee, providing the specific review remarks, and detailing next steps or reapplication information.

BRAND GUIDELINES:
- Primary Brand Accent: #ED6714 (Flame Orange)
- Neutral/Formal Theme: Slate and soft borders (avoid overly aggressive red tones; use professional neutral styling with subtle crimson accent if needed #991B1B)
- Background: #F8FAFC
- Card Container: #FFFFFF with border (#E2E8F0) and rounded corners (12px)

TECHNICAL REQUIREMENTS:
- 100% Inline CSS. Max-width 600px centered container.
- Clean header with Sumeru Global logo.
- Courteous greeting to {{candidateName}}.
- Clear statement thanking them for their interest and submission.
- Review Decision Callout Box:
  - Title: "Committee Review Remarks"
  - Content: {{remarks}}
- Helpful guidance explaining that candidates may re-apply after 6 months or contact recruitment if they believe documentation was submitted in error.
- Support contact footer with {{supportEmail}}.

CRITICAL TOKEN RULES (DO NOT CHANGE OR OMIT):
You MUST include these exact placeholder tokens:
- {{candidateName}}
- {{remarks}}
- {{supportEmail}}

Do NOT use any <script>, <iframe>, <form>, or onclick handlers.
Output ONLY the clean, raw HTML code.
```

---

## 6. Branch Audit Paperwork (`branch-audit-paperwork`)

### Template Metadata
- **Template Key**: `branch-audit-paperwork`
- **Purpose**: Dispatching official field audit documentation packets to bank branch contacts
- **Category**: Operations / Bank Audit Dispatch
- **Allow Raw HTML**: No (Strictly Escaped)

### Token Contract
| Token Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `{{branchName}}` | Escaped | **Yes** | Bank Branch Name (e.g., `HDFC Bank - Fort Branch`) |
| `{{fileName}}` | Escaped | **Yes** | Name of attached PDF packet |
| `{{supportEmail}}` | Escaped | **Yes** | Operations desk email |

### AI Prompt (Copy & Paste)
```markdown
You are an expert HTML email designer. Create an institutional, high-trust transactional HTML email for Sumeru Global (Field Assayer & Portfolio Operations Management System - FAPOMS) sent to bank branch managers.

The email purpose is notifying bank branch staff that the official field audit paperwork packet has been dispatched and attached for an upcoming vault/gold appraisal audit.

BRAND GUIDELINES:
- Primary Accent: #ED6714 (Flame Orange)
- Institutional Navy/Slate: #0F172A
- Background: #F8FAFC
- Card Container: #FFFFFF with border (#E2E8F0) and rounded corners (12px)

TECHNICAL REQUIREMENTS:
- 100% Inline CSS. Max-width 600px centered container.
- Header with Sumeru Global logo and "Official Bank Audit Dispatch" badge.
- Addressed clearly to {{branchName}}.
- Attachment Summary Card:
  - Document: {{fileName}}
  - Notice indicating the file is attached to this email.
  - Instructions that the certified Sumeru Global appraiser will arrive with matching credentials and collect the physical verification countersignatures.
- Security & Compliance Callout:
  - Confidential audit documentation notice.
  - Verification checklist for bank officers upon appraiser arrival.
- Operations desk contact footer with {{supportEmail}}.

CRITICAL TOKEN RULES (DO NOT CHANGE OR OMIT):
You MUST include these exact placeholder tokens:
- {{branchName}}
- {{fileName}}
- {{supportEmail}}

Do NOT use any <script>, <iframe>, <form>, or onclick handlers.
Output ONLY the clean, raw HTML code.
```

---

## 7. Morning Executive Brief (`morning-digest`)

### Template Metadata
- **Template Key**: `morning-digest`
- **Purpose**: Daily 08:30 executive briefing summarizing pending actions across Data Desk, HR, Finance, and Feedback
- **Category**: Operations / Management Briefing
- **Allow Raw HTML**: **Yes (`{{{digestSectionsHtml}}}`)**

### Token Contract
| Token Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `{{recipientName}}` | Escaped | **Yes** | Recipient's name |
| `{{date}}` | Escaped | **Yes** | Formatted calendar date (e.g., `Wednesday, Sep 16, 2026`) |
| `{{subjectCounts}}` | Escaped | **Yes** | Brief overview metrics (e.g., `Desk: 4 stalled · HR: 2 pending`) |
| `{{{digestSectionsHtml}}}` | **Raw HTML** | **Yes** | Dynamic HTML blocks for each department section |
| `{{portalUrl}}` | Escaped | **Yes** | Main dashboard desk link |
| `{{supportEmail}}` | Escaped | **Yes** | Operations desk email |

### AI Prompt (Copy & Paste)
```markdown
You are an expert HTML email designer. Create a sleek, modern, executive-level morning briefing HTML email for Sumeru Global (Field Assayer & Portfolio Operations Management System - FAPOMS).

The email purpose is delivering the daily 08:30 AM operational digest to managers and team leads, highlighting items requiring attention across desks (SLA breaches, pending verification dossiers, stale rework, etc.).

BRAND GUIDELINES:
- Primary Accent: #ED6714 (Flame Orange)
- Dark Slate: #1E293B
- Background: #F1F5F9
- Card Container: #FFFFFF with subtle shadow and border (#E2E8F0)

TECHNICAL REQUIREMENTS:
- 100% Inline CSS. Max-width 620px centered container.
- Clean header with Sumeru Global logo and date badge displaying {{date}}.
- Personalized executive greeting: "Good morning, {{recipientName}}".
- Summary metrics banner displaying {{subjectCounts}}.
- DYNAMIC CONTENT SLOT:
  - You MUST embed the raw HTML token: {{{digestSectionsHtml}}}
  - This token will be dynamically populated at runtime with pre-formatted HTML cards for each operational section (Data Desk, HR Roster, Billing, Feedback).
- Primary CTA Button: "Open Operations Desk &rarr;" linking to {{portalUrl}}.
- Footer with digest scheduling info (Daily 08:30 IST) and support {{supportEmail}}.

CRITICAL TOKEN RULES (DO NOT CHANGE OR OMIT):
You MUST include these exact placeholder tokens:
- {{recipientName}} (Escaped)
- {{date}} (Escaped)
- {{subjectCounts}} (Escaped)
- {{{digestSectionsHtml}}} (NOTICE: 3 curly braces! This injects pre-rendered HTML cards)
- {{portalUrl}} (Escaped)
- {{supportEmail}} (Escaped)

Do NOT use any <script>, <iframe>, <form>, or onclick handlers.
Output ONLY the clean, raw HTML code.
```
