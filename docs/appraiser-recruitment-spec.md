# Requirement Specification Document: Appraiser Recruitment Application

## Provenance — read this first

This document was **not authored in this repository**. It was pasted into a working session on
2026-09-11 as the requirement for what became the recruitment pipeline, and until now it existed
only in that session's transcript. Everything the code calls "the Appraiser Recruitment spec" —
including the module numbers in comments such as *"the Appraiser Recruitment spec's Module 8"*
(`assayer.controller.ts`) — refers to the text reproduced verbatim in §1–§8 below.

It is committed here so that "as per our docs" is a claim anybody can check, and so that where the
code deliberately departs from it, the departure is recorded next to the requirement rather than
remembered. Those departures are in the status table at the end; two of them were the owner's own
decisions and one of them is a bug.

One word of caution about vocabulary. `docs/business-spec.md` is a **different system** — the
Branch Audit Management System — and it instructs that "Appraiser" be replaced by "Regional
Operator", an internal staff role. In THIS document "Appraiser" means the field worker, which the
code calls an **Assayer**. The two documents use the same word for two different people.

---

## 1. Overview

This application is designed to digitize and streamline the recruitment, onboarding, and
validation of Appraisers. The process includes interview recording, registration, profile
creation, internal validation, background verification (BGV), and issuance of an ID card.

## 2. Modules & Workflow

### Overall Flow

```
Interview → Registration → Profile Creation → Internal Validation → Profile Activation → BGV
→ Final Documentation → ID Card Request
```

## 3. Module-wise Breakdown

### 1. Interview Process (Internal Use Only)

**Actors:** Internal HR / Ops
**Purpose:** Capture basic profile and initiate recruitment

Features:
- Form to input: Appraiser Name, Mobile Number, Interview Summary/Notes, Interview Outcome
  (Pass/Fail)
- On successful interview: Create a draft profile (Status: Interviewed), Send link for Registration

### 2. Registration (Appraiser Access)

**Actors:** Appraiser
**Purpose:** Allow new users to register into the system

Steps:
- Access link sent by internal team
- Click on New User Registration
- Enter Mobile Number → OTP-based verification
- If verified, redirect to profile creation

### 3. Profile Creation (Appraiser)

**Actors:** Appraiser
**Purpose:** Submit all required personal/professional data

Form fields:

1. **Personal Details:** Full Name, DOB, Gender, Address, State, City, Pincode, Photo Upload
2. **Professional Details:** Experience, Current Employer, Expertise, Availability
3. **Document Uploads:**

   *If Freelancer:* Experience letter · Shop Address Proof · PAN Card · Aadhar Card · Rent
   agreement (If address is different than Aadhar) · Latest Electricity Bill of Owner

   *If Proprietor:* Shop Entity Proof · Shop Address Proof · Association letter · PAN Card ·
   Aadhar Card · Rent Agreement (If shop is rented) · Latest Electricity Bill

4. **Declaration & Consent Checkbox**

Buttons: Submit, Save as Draft. Upon submission, status = Pending Validation

### 4. Internal Validation (Admin Panel)

**Actors:** Internal Team
**Purpose:** Approve, reject, or ask for more information

Actions:
- View submitted profile and documents
- Add comments
- Approve, Reject, or Request More Info, Request additional or updated documents.

### 5. Profile Activation (System & Admin)

Once approved, system updates status to Activated. BGV process is initiated automatically.

### 6. BGV Process

**Actors:** Internal HR Team
**Purpose:** Background verification and documentation

Actions:
- Upload BGV Report
- Mark BGV Result: Successful (BGV Passed) or Unsuccessful (BGV Failed)
- Mention comments for approval or rejection.

### 7. Final Documentation (System Automated)

On BGV Passed: Auto-generate unique Appraiser Code and tag all documents under Appraiser's digital
record.

### 8. ID Card Request & Upload

**Actors:** Internal Team

Action:
- A soft copy of ID card with predefined template will be generated.
- HR team should be able to download the ID card in PDF format.
- While downloading, it should have the date when downloaded and expiry date as the end of current
  calendar year.

## 4. Admin Dashboard Features

- Search & filter appraisers by name, code, status
- Export appraiser data (Excel, PDF)
- Upload / download documents
- Bulk operations: Approve/Reject/Notify
- Email/SMS notifications
- Audit log for each profile update

## 5. User Roles

- **Appraiser:** Form filling, Upload Documents, Respond to requests by HR
- **Internal Team (HR):** Create draft profile, Upload documents, Full access to review, validate,
  approve/reject
- **Admin:** Create internal users, view all modules.

## 6. Status Flow Summary

```
Interviewed → Registered → Pending Validation → Awaiting Info → Rejected → Activated →
BGV Passed/Failed → Onboarded
```

## 7. Notifications

- OTP during registration
- Submission confirmation
- Document requests
- Approval/Rejection alerts
- BGV outcome
- Appraiser Code issuance

## 8. Technical Considerations

- OTP Authentication via mobile (SMS gateway required)
- Secure Document Uploads
- Role-Based Access Control
- Audit Trail for compliance
- Responsive UI for mobile usage

---

# Where each module lives

Verified against the source, not against memory. A ✗ is a gap; a ≠ is a deliberate departure with
the reason and the decision recorded.

| Module | State | Where it lives |
|---|---|---|
| **1** Interview | built | `assayer-interview.service.ts` `record()` — name, mobile, notes, PASS/FAIL. A PASS calls `createInvite`, which is the only producer of an application in the whole backend. |
| **2** Registration | built ≠ | `public-registration.controller.ts` — every route keyed on the invite token, no auth guard at all. **≠ the OTP is emailed, not texted**; §8 asks for an SMS gateway and there is none. |
| **3** Profile creation | built | `PublicRegistration.tsx` and the mobile `SelfRegistrationScreen`, against `updateDraft` / `acceptConsent` / `uploadDocument` / `submit`. The freelancer/proprietor document split is `FREELANCER_DOCUMENTS` and `PROPRIETOR_DOCUMENTS` (`registration-application.service.ts:75-88`). "Save as Draft" is autosave per field. |
| **4** Internal validation | built | `hr-applications.controller.ts` — `approve` / `reject` / `request-info`, each with its reason. |
| **5** Profile activation | ≠ | Approval opens the record at `INVITED`, and `INVITED → DOCUMENT_VERIFICATION → BACKGROUND_VERIFICATION → TRAINING → ACTIVE` are four moves somebody makes. **Nothing auto-advances, and BGV does not start itself.** Deliberate (`9d99c061`): every lifecycle move stays a decision with a person behind it. |
| **6** BGV | built | `POST /assayers/:assayerId/background-check`. A check is added, never edited — a later finding is a second fact, not a correction. |
| **7** Final documentation | ≠ | The Appraiser code is minted at **approval**, inside `AssayerService.create`, not on BGV pass. The vetting gate moved onto what leaves the building instead: the ID card refuses without a verified identity and a passed check. Owner's decision, 2026-09-12 (`identity-artifacts.ts:3-13`). |
| **8** ID card | built ≠ | `GET /assayers/:assayerId/id-card`. **≠ expiry is configurable**, because a card issued on 31 December expired the day it was printed — the owner spotted that. See `id-card.ts:22-27`. |
| **§4** Admin dashboard | partial | Search, filter, export and the audit log exist on the roster. **✗ There are no bulk operations on applications** — `hr-applications.controller.ts` has no bulk route, so Approve/Reject/Notify are one at a time. |
| **§5** Roles | ≠ | Three roles in the spec; nine in the product, and no dedicated HR role — `/hr/interviews` and `/hr/applications` are gated ADMIN + OPERATIONS. |
| **§7** Notifications | partial | The three staff-facing ones are in the catalogue (`ASSAYER_APPLICATION_SUBMITTED`, `ASSAYER_BGV_RECORDED`, `ASSAYER_CODE_ISSUED`). Candidate-facing mail goes direct through `EmailProvider`, because a pre-account candidate has no role principal to address. **✗ No SMS on any of them.** |

## The one status the code does not have

The spec's flow opens `Interviewed → Registered → …`. The code's `ApplicationStatus` opens
`DRAFT → PENDING_VALIDATION → …`, so:

- **"Interviewed"** is `DRAFT` with nothing filled in yet. The Applications screen labels this
  filter "Not started" for that reason.
- **"Registered"** has no counterpart at all: there is no state between being invited and
  submitting. Nothing appears to depend on the distinction, and none of the screens offer it.

Both are worth knowing when reading this spec against the code, because the same person is in a
differently-named state in each document.
