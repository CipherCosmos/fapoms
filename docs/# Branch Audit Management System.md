# Branch Audit Management System

### Business Process & Functional Specification

This document restructures the raw workflow notes into one specification: the entities involved, the complete process from contract intake to final report delivery, and a focused, build-ready breakdown of the Document Management module. It's written to be handed directly to a development team or an AI coding agent so the whole application can be redesigned consistently, not patched piece by piece.

Section 12 lists open questions surfaced while structuring this — a few of them affect the data model directly, so they're worth resolving (or explicitly deciding) before implementation starts.

## 1. Business Summary & Scope

The company performs physical audits of bank branches on behalf of client banks. Each client periodically — typically monthly — issues a contract covering a specific set of branches. The company plans and assigns independent field assessors to visit those branches, collects the completed audit paperwork, converts it into a validated digital report, and returns that report to the client.

**In scope for this rebuild:** project/branch intake, planning and assessor assignment, coverage reporting, document dispatch and collection (Document Management), the data-entry handoff/queue, and status tracking across all of it.

**Out of scope (stays external, only integrated with):**

- The **External OCR Application** — used to turn client master data into the field-ready audit PDF, and later to OCR/extract the hand-filled data. The new system only uploads to it and downloads from it.
- The **Client's own banking portal** — used only to receive branch/customer data from the client and to deliver the final report back to them.

## 2. Glossary

| Term                               | Definition                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Client**                   | A bank that contracts the company to audit some of its branches.                                                                                                                                                                                                                                         |
| **Branch**                   | A single physical location belonging to a Client. The same Branch is reused across multiple Projects over time.                                                                                                                                                                                          |
| **Project**                  | One contract/work order from a Client — usually recurring monthly — containing the specific list of branches to audit in that cycle.                                                                                                                                                                   |
| **Packet**                   | The volume of audit work at a branch (e.g., number of accounts/loan files to check), sent by the client alongside each branch name.*(Interpretation — confirm in 12.1.)*                                                                                                                              |
| **Assessor**                 | An independent field auditor who visits a branch, performs the audit, and fills in the paperwork.                                                                                                                                                                                                        |
| **Regional Operator**        | Internal staff who own the assessor relationships in one geographic region — see Section 3.                                                                                                                                                                                                             |
| **Data Entry Team**          | Internal team that OCR-processes and validates each returned, hand-filled PDF and produces the final Excel report.                                                                                                                                                                                       |
| **Data Entry Head**          | Internal approver who reviews the finished report before it goes to the client.                                                                                                                                                                                                                          |
| **External OCR Application** | Third-party/separate system, out of scope, used only to generate the field-ready PDF and to OCR the completed one.                                                                                                                                                                                       |
| **Assessment**               | *Proposed entity name* — one branch's audit within one specific Project. This is the unit that actually moves through planning, dispatch, field work, and data entry — not the Branch itself. You already used this word ("upload back the audited pdf on the same assessment"); this formalizes it. |
| **Coverage**                 | The share of a Project's branches successfully assigned to an assessor and audited, versus those that couldn't be.                                                                                                                                                                                       |

## 3. Roles & Actors

| Actor               | Function                | Core responsibility                                                                                                                                |
| ------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client (Bank)       | External                | Issues the Project's branch list + packet sizes; uploads customer master data per branch; receives the coverage report and the final audit report. |
| Planning / Ops Team | Internal                | Creates Projects, imports branch lists, runs the Planning workspace.                                                                               |
| Regional Operator   | Internal, region-scoped | Calls and negotiates with assessors in their region; dispatches audit PDFs to them; collects completed PDFs back.                                  |
| Assessor            | External / Field        | Accepts or declines assignments; visits the branch; fills in and scans the paperwork; returns it.                                                  |
| Data Entry Team     | Internal                | OCR + manual validation of returned PDFs; produces and checks the Excel report; contacts assessors to resolve unclear entries.                     |
| Data Entry Head     | Internal                | Final reviewer/approver before the report reaches the client.                                                                                      |
| System (automation) | Background              | Geocoding, assessor recommendation, auto-dispatch, notifications, status tracking.                                                                 |

*Planning/Ops Team and Regional Operator may well be the same people wearing two hats — whoever calls an assessor during planning appears to be the same person who later dispatches and collects that assessor's documents. Treat this as two functions, not necessarily two separate teams.*

## 4. Key Design Principle: Branch vs. Assessment

> A **Branch** is a permanent master record — it exists once and is reused every time that bank sends it in a future contract. An **Assessment** is specific to one Project: its status, assigned assessor, schedule, and documents must live on the Assessment, never on the Branch record itself. If the current system stores status or assignment fields directly on Branch, that alone would explain a lot of the fragmentation — the same branch coming up in next month's Project would arrive carrying last month's leftover status, assessor, or documents. Everything described below (status, documents, call logs, assessor assignment) belongs to the Assessment.

## 5. High-Level Flow

```
Project Created → Branch List Imported (matched or geocoded) → Planning
(assessor recommended → called → accepted/rejected) → Coverage Report →
Client Uploads Data → OCR PDF Generated → Dispatched to Assessor → Field
Audit → Audited PDF Collected → Data Entry & Validation → (clarification
loop) → Report Approved → Delivered to Client
```

## 6. Detailed End-to-End Workflow

### Phase 1 — Project Creation

**Trigger:** Client issues a new contract.

- Internal team creates a Project under that Client.

**Result:** Empty Project, ready for its branch list.

### Phase 2 — Branch Intake & Geocoding

**Trigger:** Client sends the branch list for the Project, with a packet size per branch.

- List is imported into the Project (bulk upload).
- For each branch, the system checks whether it already exists for this Client: if yes, reuse the existing Branch record and coordinates; if not, geocode the address and create a new Branch record.
- An Assessment is created for every branch, status `Pending Planning`.

**Result:** All branches exist as Branch + Assessment records with valid coordinates.

### Phase 3 — Planning & Assessor Assignment

**Trigger:** Planning page opened for the Project.

- Page lists every Assessment needing an assessor.
- System recommends candidate assessors per branch, ranked by distance, SLA, fee, time/workload, and schedule conflicts; branches and candidates are plotted on a map.
- Regional Operator calls the top candidate:
  - **Accepted** (possibly after negotiating fee/allowance) → capture agreed fee and audit date, Assessment → `Assigned & Scheduled`.
  - **Rejected / no deal** → move to the next candidate, repeat.
- Every call outcome (who called, when, result, negotiated fee) should be logged against the Assessment — this doesn't appear to be captured today.

**Result:** Each Assessment ends as `Assigned & Scheduled` or `Unassigned`. Goal is to maximize the assigned count.

### Phase 4 — Coverage Reporting

**Trigger:** Planning is complete/closed for the Project.

- System compiles covered branches (assessor + date) and uncovered branches.
- Report is sent to the Client.

**Result:** Client knows exactly which branches will be audited, and when.

### Phase 5 — Client Data Upload

**Trigger:** Due one day before a covered branch's scheduled audit date.

- Client uploads customer master data for that branch (destination TBD — see 12.3).
- System tracks, per Assessment, whether data arrived relative to the due date, and flags it if late.

**Result:** Assessment → `Client Data Received`.

### Phase 6 — OCR PDF Generation *(external system)*

**Trigger:** Master data received for an Assessment.

- Team uploads the data into the External OCR Application.
- It generates a branch-specific PDF: customer data pre-filled, with blank columns for the assessor to complete on-site.
- Team downloads the generated PDF — this is the handoff back into the new system.

**Result:** Assessment → `PDF Generated`.

### Phase 7 — Dispatch to Assessor *(Document Management — Section 8)*

- Generated PDF is uploaded into the Assessment inside the application.
- Dispatched to the assigned assessor — automatically on schedule, or manually on demand — bundled with branch/contact details, not the PDF alone.

**Result:** Assessment → `Dispatched to Assessor`.

### Phase 8 — Field Audit

*(performed by the assessor, outside the system)*

- Assessor visits the branch on the scheduled date and fills in the blank columns manually.
- Scans the completed pages back into one PDF.

**Result:** Assessor has a completed PDF ready to return.

### Phase 9 — Audited PDF Collection *(Document Management — Section 8)*

- Assessor uploads the completed PDF back against the same Assessment.
- System routes it automatically into the Data Entry Team's queue.

**Result:** Assessment → `Audited PDF Received` → `Sent to Data Entry`.

### Phase 10 — Data Entry, Validation & Report Generation *(external system + internal team)*

- Data Entry team uploads the returned PDF into the External OCR Application, against the same record.
- OCR extraction plus human validation, page by page.
- Once complete, the Excel report is generated, downloaded, and reviewed.

**Result:** Assessment → `Data Entry in Progress` → `Report Drafted`.

### Phase 11 — Clarification Loop

- Where entries are unclear (handwriting, missing info), Data Entry team contacts the assessor directly to resolve before finalizing.

**Result:** Loops back into Phase 10 until resolved.

### Phase 12 — Final Review & Delivery

- Finished report goes to the Data Entry Head for approval.
- Data Entry Head sends the approved report to the client's own banking portal.

**Result:** Assessment → `Delivered to Client` → `Completed`.

## 7. Application Modules / Pages

| Module / Page                    | Covers         | Primary users                           |
| -------------------------------- | -------------- | --------------------------------------- |
| Client & Project Setup           | Phase 1        | Planning / Ops Team                     |
| Branch Master + Import           | Phase 2        | Planning / Ops Team, System (geocoding) |
| Planning (map + recommendations) | Phase 3        | Regional Operator                       |
| Coverage Reporting               | Phase 4        | Planning / Ops Team, Client             |
| Client Data Intake               | Phase 5        | Client, Planning / Ops Team             |
| **Document Management**    | Phases 7 & 9   | Regional Operator, Assessor             |
| Assessor App/Portal              | Phases 7, 8, 9 | Assessor                                |
| Data Entry Dashboard             | Phases 9–11   | Data Entry Team                         |
| Approval & Delivery              | Phase 12       | Data Entry Head                         |

*(The External OCR Application covers Phases 6 & 10 and stays outside this system, per the scope in Section 1.)*

## 8. Document Management Module — Detailed Requirements

This is the module to rebuild first. It owns Phases 7 and 9, replacing the current email-based handoffs.

### 8.1 Upload

- Target: a Project (bulk, all covered branches at once) or a single Assessment.
- Available any time after OCR generation — not tied to a strict day-by-day sequence.
- Each uploaded file must resolve to exactly one Assessment (needs a matching rule — filename convention or a manual mapping step; see 12.7).
- On upload: document type = "Pre-Field Audit PDF", Assessment → `Ready for Dispatch`.

### 8.2 Auto-Dispatch

- A scheduled job checks every `Ready for Dispatch` Assessment with a confirmed audit date.
- Dispatches automatically once a defined trigger is reached (e.g., N days before the audit date — exact rule to confirm, see 12.6).
- Delivered to the assessor via the Assessor App/Portal, bundled with branch/contact details.
- Every dispatch is logged: timestamp, method = Auto.

### 8.3 Manual Dispatch

- A Regional Operator can dispatch any `Ready for Dispatch` Assessment immediately, overriding the schedule.
- Logged the same way: timestamp, method = Manual, dispatched by.

### 8.4 Assessor Return Upload

- Assessor uploads the completed, scanned PDF back against their Assessment, through the Assessor App/Portal.
- Should only be possible once that Assessment has actually been dispatched.
- On upload: Assessment → `Audited PDF Received`, Regional Operator notified.

### 8.5 Collection → Data Entry Routing

- Every `Audited PDF Received` Assessment appears automatically in the Data Entry Team's queue — no manual forwarding.
- Queue shows: branch, client/project, assessor, date received, days pending, and an action to mark it sent onward to the External OCR Application.

### 8.6 Status & Audit Trail

- Every document carries its full history: uploaded → dispatched (auto/manual, by whom, when) → received back → sent to data entry → sent to external OCR → finalized → delivered.
- This trail is what answers "where is branch X's paperwork right now" at a glance — likely the single biggest gap in the current setup.

## 9. Proposed Data Model

| Entity               | Key fields                                                                                                                                        | Relationships                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Client               | id, name, contact info                                                                                                                            | has many Branch, Project                                |
| Branch               | id, client_id, code/name, address, lat/long, geocode_source                                                                                       | belongs to Client; referenced by many Assessment        |
| Project              | id, client_id, contract period, created_at, status                                                                                                | has many Assessment                                     |
| **Assessment** | id, project_id, branch_id, packet_size, status, assigned_assessor_id, audit_date, agreed_fee, coverage_flag                                       | belongs to Project + Branch; has many Document, CallLog |
| Assessor             | id, name, region, contact info, base coordinates, fee rate, current workload, SLA/rating history                                                  | assigned to many Assessment                             |
| CallLog              | id, assessment_id, assessor_id, called_by, timestamp, outcome, negotiated_fee, notes                                                              | belongs to Assessment                                   |
| Document             | id, assessment_id, type (pre-field / audited / final report), file_reference, uploaded_by/at, dispatched_at, dispatch_method, received_at, status | belongs to Assessment                                   |
| User                 | id, name, role, region_scope                                                                                                                      | —                                                      |
| CoverageReport       | id, project_id, generated_at, covered_count, uncovered_count, sent_at                                                                             | belongs to Project                                      |

## 10. Assessment Status Lifecycle

1. Pending Planning
2. Assessor Recommended
3. In Negotiation
4. Assigned & Scheduled *(or → 5 if no assessor is secured)*
5. Unassigned *(end state, feeds the coverage report)*
6. Awaiting Client Data
7. Client Data Received
8. PDF Generated
9. Ready for Dispatch
10. Dispatched to Assessor
11. Audited PDF Received
12. Sent to Data Entry
13. Data Entry in Progress *(loops with 14 as needed)*
14. Clarification Needed
15. Report Finalized
16. Pending Data Entry Head Approval
17. Delivered to Client
18. Completed

## 11. Cross-Cutting Requirements

- **Notifications:** dispatch confirmation, return confirmation, late-client-data alerts, clarification requests — to the relevant internal role and/or assessor.
- **Permissions:** Regional Operators likely see only their own region's Assessments and assessors; Data Entry sees only what's been routed to them; Data Entry Head sees everything pending approval.
- **Bulk actions:** bulk upload and bulk dispatch — a Project can involve dozens of branches at once.
- **Assessor App/Portal usability:** assessors work from the field, so this should stay simple and mobile-friendly — essentially "my assignments," "download PDF," "upload completed PDF."
- **Audit trail:** every status change and document event timestamped and attributed to a user or "system (auto)" — this is what actually fixes "things not working," since breakage in a fragmented system usually shows up as "we don't know what happened to this branch."

## 12. Assumptions & Open Questions

#### 1. Packet

The existing assumption is correct.

* Packet represents the volume of audit work allocated to a branch.
* Remove this as an open question.
* Treat it as a confirmed business rule everywhere in the document.

---

#### 2. Branch Matching

Update every section that discusses branch import, branch creation, deduplication, or branch matching.

Business rule:

* SOL ID should be the primary identifier.
* If SOL ID is unavailable or inconsistent, intelligently match using:

  * Branch Name
  * State
  * Other available identifying information
* The system should detect duplicate or mixed branch records wherever possible.

This is no longer an open question.

---

#### 3. Client Data Source

Update every workflow and module that references client uploads.

The application **does not** provide a client upload portal.

Actual business flow:

* Banks maintain their own portal.
* My team retrieves (downloads/pulls) branch/customer data from that portal.
* The downloaded data is then processed through the existing workflow.

Update:

* Scope
* Business Summary
* Phase 5
* Module descriptions
* Any architectural assumptions

to reflect this real workflow.

---

#### 4. Coverage Report Delivery

The system only needs to generate and provide a download option.

Business process:

* Users manually send the downloaded report to the client using the existing business process.

Do not introduce:

* Email automation
* Client portal delivery
* Automatic submission

unless explicitly required elsewhere.

---

#### 5. Assessor Application

Do not describe the Assessor App as a brand-new application.

Reality:

* An Assessor App already exists.
* It is incomplete.
* This project extends, completes, and integrates the existing application.

Update every reference accordingly.

---

#### 6. Auto Dispatch

Replace every placeholder or assumption regarding dispatch timing.

Business rule:

* Automatically dispatch documents **1 day before** the scheduled audit date.
* Regional Operators must also have a Manual Dispatch option that can override or trigger dispatch whenever required.

Reflect this consistently throughout:

* Workflow
* Document Management
* Status lifecycle
* Automation descriptions

---

#### 7. PDF Matching

Update every document upload workflow.

Business rule:

1. Match PDFs using filename conventions.
2. If automatic matching fails:

   * allow manual mapping
   * allow users to assign PDFs to the correct Assessment.

Both mechanisms are required.

---

#### 8. Data Entry Queue

The current specification incorrectly routes PDFs directly to the Data Entry Team.

Replace that flow.

Actual business flow:

* All collected PDFs first appear in the Data Entry Head's queue.
* The Data Entry Head downloads the PDFs.
* The Head distributes work to the Data Entry team using the existing manual process.

The application should provide:

* lifecycle tracking
* status tracking
* ownership visibility
* progress tracking
* pending work tracking

The application does **not** assign work directly to individual Data Entry operators.

Update:

* Workflow
* Document Management
* Module descriptions
* Queue description
* Status tracking

accordingly.

---

#### 9. Remove the "Done vs Audited" Question

This is no longer an open question.

The workflow has already been understood.

Remove it completely instead of leaving it as an assumption.

---

#### 10. Terminology

Standardize terminology throughout the entire document.

Use:

**Regional Operator**

Replace any inconsistent references such as:

* Operator
* Upraiser
* Appraiser

unless they genuinely refer to different business roles.

---

## 13. Suggested Build Priority

1. Formalize **Assessment** as its own entity, separate from Branch, if it isn't already — this unblocks everything else cleanly.
2. Confirm or build the **Assessor App/Portal** — auto-dispatch and return-upload both depend on assessors having somewhere to receive and send files.
3. Rebuild **Document Management** per Section 8: upload → auto/manual dispatch → assessor return → auto-route to the Data Entry queue.
4. Add the **status/audit trail** (Section 11) across the whole Assessment lifecycle — this alone should resolve most of the "can't tell what's happening" pain.
5. Resolve the Section 12 open questions with stakeholders before locking the data model.
