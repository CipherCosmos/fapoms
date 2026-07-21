# Business Operating Model

**Company:** (FAPOMS-operating entity — "The Company")
**Industry:** Field Audit Services for Banking & Financial Institutions
**Document Type:** Business Process & Operating Model
**Date:** 2026-07-21
**Status:** Reverse-Engineered from existing systems, specifications, and domain artifacts

---

## Table of Contents

1. [Business Vision & Identity](#1-business-vision--identity)
2. [Business Objectives](#2-business-objectives)
3. [Value Proposition](#3-value-proposition)
4. [Organization Structure](#4-organization-structure)
5. [Departments & Functions](#5-departments--functions)
6. [Roles & Responsibilities](#6-roles--responsibilities)
7. [External Stakeholders](#7-external-stakeholders)
8. [Business Capabilities](#8-business-capabilities)
9. [End-to-End Business Processes](#9-end-to-end-business-processes)
10. [Standard Operating Procedures](#10-standard-operating-procedures)
11. [Business Rules](#11-business-rules)
12. [Decision Points & Authority](#12-decision-points--authority)
13. [Exception Scenarios](#13-exception-scenarios)
14. [Inputs & Outputs](#14-inputs--outputs)
15. [Documents Exchanged](#15-documents-exchanged)
16. [Information Ownership](#16-information-ownership)
17. [Approval Hierarchy](#17-approval-hierarchy)
18. [Key Performance Indicators](#18-key-performance-indicators)
19. [Service Level Agreements](#19-service-level-agreements)
20. [Regulatory & Compliance Requirements](#20-regulatory--compliance-requirements)
21. [Operational Constraints](#21-operational-constraints)
22. [Future Business Growth Assumptions](#22-future-business-growth-assumptions)

---

# 1. Business Vision & Identity

## Who We Are

We are a specialized field audit services company. Our clients are banks and financial institutions that need their branch networks physically audited. Our field auditors — whom we call "Assayers" — visit bank branches to verify records, count cash, inspect operations, and confirm compliance. We do not employ these assayers directly; they are independent contractors who work with us on an assignment-by-assignment basis.

## Our Business Purpose

We exist because banks need independent, verifiable audits of their branch operations, but maintaining an in-house team of traveling auditors is expensive and logistically complex. We solve this by maintaining a network of geographically distributed assayers who can visit any branch in the country, and by providing the operational coordination, document management, validation, and reporting infrastructure that turns individual branch visits into a coherent audit program.

## Core Identity

We are a coordination and quality-assurance company, not an audit firm in the traditional sense. Our value lies not in performing the audits ourselves, but in:

- **Managing the complexity** of matching hundreds of branches with dozens of available assayers across multiple states
- **Ensuring quality** through standardized document packages, validation workflows, and review processes
- **Providing visibility** to our clients through real-time coverage status and comprehensive reports
- **Maintaining audit integrity** through immutable records, structured communication, and chain-of-custody for all documents

## Brand & Market Position

We position ourselves as a technology-enabled operational partner. Our differentiator is not that we have auditors (many companies do), but that we can coordinate large-scale audit programs reliably, transparently, and faster than competitors who rely on spreadsheets, phone calls, and personal relationships.

---

# 2. Business Objectives

## Primary Objectives

| Objective | Description | Measurement |
|-----------|-------------|-------------|
| Maximize branch coverage | Every branch submitted by a client should be audited | Coverage percentage per project (>95% target) |
| Minimize operational cost | Reduce travel, coordination, and administrative overhead | Cost per branch audited |
| Minimize planning cycle time | Reduce time from branch list receipt to assignment confirmation | Days from project creation to 100% assignment |
| Maximize assayer satisfaction | Keep assayers engaged with fair fees, reasonable travel, and reliable scheduling | Assayer retention rate, acceptance rate |
| Improve client visibility | Give clients real-time access to project status and reports | Client NPS score, report delivery timeliness |

## Secondary Objectives

- Standardize operations across all clients (reduce process variation)
- Reduce dependency on individual operational staff (institutionalize knowledge)
- Build a data advantage (geographic coverage maps, assayer performance history, branch audit history)
- Create a scalable operating model that can grow from 1 client to 10+ without proportional headcount increase

---

# 3. Value Proposition

## For Banking Clients

**Problem:** Banks must audit their branch networks regularly (monthly, quarterly, or annually). Maintaining an internal audit travel team is expensive, logistically complex, and prone to coverage gaps.

**Our Solution:** We manage the entire field audit lifecycle — from receiving the branch list to delivering validated audit reports. Our clients get:

- **Certainty:** Every branch in the list is assigned to a qualified assayer
- **Visibility:** Real-time dashboards showing which branches are planned, assigned, in progress, and completed
- **Quality:** Standardized audit document packages, professional assayers, and a multi-stage validation process
- **Efficiency:** Faster turnaround than managing the process internally
- **Compliance:** Complete audit trail with all communications, document versions, and validation results preserved

## For Assayers (Independent Auditors)

**Problem:** Independent auditors struggle to find consistent work, manage administrative overhead, and maintain relationships with multiple clients.

**Our Solution:** We provide assayers with:

- **Steady workflow:** Consistent assignments matched to their geographic location
- **Reduced admin:** We handle client communication, document generation, scheduling, and payment
- **Fair compensation:** Negotiated fees per assignment
- **Professional support:** Clear briefings, timely document dispatch, and responsive coordination

## For the Company

**Our Value:** We create value by being the trusted intermediary between banks that need audits and professionals who perform them. Our operational platform is the engine that makes this intermediation efficient, reliable, and scalable.

---

# 4. Organization Structure

## Organizational Model

The company operates as a flat-but-functional organization. Department heads report to the Managing Director or Chief Operating Officer. The organization is designed for operational efficiency rather than hierarchy.

```
                    Managing Director / COO
                            |
         +------------------+------------------+
         |                  |                  |
   Operations        Quality &          Finance &
    Division         Compliance          Admin
         |               |                 |
    +---------+     +--------+       +-----------+
    |         |     |        |       |           |
  Planning  Field   Valid.  Audit    HR / Admin /
  & Ops     Coord.  Team    & Comp.  Accounts
```

## Organizational Principles

- **Operations is the center of gravity.** Everything exists to support the planning and execution of field audits.
- **Quality is independent.** The validation team reports separately from operations to maintain independence in the review process.
- **Assayers are not employees.** They are independent contractors managed through the coordination team.
- **Client-facing and assayer-facing roles are distinct.** Operations Executives primarily interact with assayers; Account Managers or Client Relations handle client communication.

---

# 5. Departments & Functions

## Operations Department

**Head:** Operations Manager
**Purpose:** Plan, coordinate, and execute field audit assignments from branch list receipt to document dispatch.

**Sub-functions:**

| Function | Responsibilities |
|----------|-----------------|
| Project Planning | Receive branch lists, create projects, organize branches into zones, set priorities |
| Assayer Coordination | Identify candidate assayers, make contact, negotiate fees and availability |
| Assignment Management | Confirm assignments, record all communication, track status |
| Scheduling | Set audit dates, resolve conflicts, manage rescheduling |
| Field Coordination | Real-time support for assayers during fieldwork, issue resolution |

**Staffing ratios (typical):** One Operations Executive can actively manage 30-50 active assignments simultaneously. One Operations Manager oversees 3-5 executives.

## Quality & Validation Department

**Head:** Validation Manager
**Purpose:** Ensure all completed audits meet quality standards before delivery to clients.

**Sub-functions:**

| Function | Responsibilities |
|----------|-----------------|
| Validation Intake | Receive completed audit documents, verify completeness, log receipt |
| OCR Processing | Scan and digitally process returned documents |
| Human Review | Review OCR output against original documents, verify accuracy |
| Correction Management | Flag errors, manage correction workflow, re-verify |
| Quality Audit | Random sampling of completed audits for quality assurance |
| Final Report Assembly | Compile audit results, generate client reports |

## Document Management Department

**Head:** Document Executive (lead)
**Purpose:** Manage all document workflows including client data receipt, PDF generation, dispatch, and tracking.

**Sub-functions:**

| Function | Responsibilities |
|----------|-----------------|
| Client Data Intake | Receive and validate customer master data from clients |
| PDF Generation | Generate standardized audit document packages per branch |
| Dispatch | Send documents to assayers (physical or electronic, T-1) |
| Return Tracking | Track receipt of completed documents from assayers |
| Archival | Maintain document repository for compliance and reference |

## Administration & Finance

**Head:** Administrator / Finance Manager
**Purpose:** Manage internal operations, HR, accounts, and client contracting.

**Sub-functions:**

| Function | Responsibilities |
|----------|-----------------|
| User Management | Onboard/offboard internal staff, manage access, roles |
| Client Onboarding | Contracts, rate agreements, SLA definitions |
| Assayer Onboarding | KYC, bank account setup, agreement signing, PAN verification |
| Fee Processing | Track fees, generate payment instructions, manage assayer payouts |
| Reporting | Internal management reports, client billing support |
| Configuration | System configuration, business rule maintenance, audit log review |

---

# 6. Roles & Responsibilities

## Internal Roles

### Managing Director / COO
- Overall business strategy and growth
- Client relationship management (top-tier)
- Organizational performance review
- Capital and resource allocation
- Regulatory and compliance oversight

### Operations Manager
- Plan and oversee all active projects
- Assign Operations Executives to projects
- Set strategic planning direction (zones, priorities, targets)
- Review and approve assignments (especially high-value or complex)
- Monitor coverage metrics across all projects
- Escalate resolution for exceptions
- Report project status to clients and MD
- Manage Operations Executive team (capacity, performance, training)

### Operations Executive
- Execute day-to-day planning and coordination for assigned projects
- Import and validate branch lists
- Identify candidate assayers using available tools and knowledge
- Contact assayers, explain assignment details, negotiate fees and availability
- Record all communication with assayers (calls, messages, emails)
- Confirm assignments and coordinate scheduling
- Track assignment progress and follow up as needed
- Flag exceptions to Operations Manager

### Validation Manager
- Oversee validation workflow for all completed audits
- Assign validation cases to Validators
- Monitor validation throughput and quality metrics
- Review and approve completed validations
- Manage correction/rework process
- Generate validation completion reports
- Escalate quality issues to Operations Manager

### Validator
- Review returned audit documents
- Compare OCR output against original documents
- Identify and flag discrepancies
- Perform manual corrections when needed
- Record review decisions and notes
- Submit completed validation cases for approval

### Document Executive
- Receive and log incoming client data
- Generate audit document packages
- Dispatch documents to assayers according to schedule
- Track document delivery and receipt status
- Log returned documents and forward to validation
- Maintain document repository and version history

### Administrator
- Manage internal user accounts and permissions
- Onboard and configure new clients
- Onboard assayers (KYC, banking, agreements)
- Maintain system configuration and reference data
- Generate operational reports for management
- Coordinate with finance on assayer payouts and client billing

### Compliance / Audit Officer
- Review audit trail for completeness
- Perform random quality audits on completed assignments
- Verify adherence to standard operating procedures
- Prepare compliance documentation for regulatory requirements
- Recommend process improvements based on audit findings

## External Contractor Roles

### Assayer (Independent Field Auditor)
- Accept or decline assignment offers
- Negotiate fees (within framework)
- Receive and review audit document packages
- Perform physical branch audits according to standards
- Complete and return audit documents within agreed timeline
- Communicate any issues or delays to Operations Executive
- Report audit completion

### Client User (Bank Representative)
- Submit branch lists for audit projects
- Provide customer master data for each branch
- Track project progress and coverage status
- Receive and review final audit reports
- Raise queries or requests for additional information

---

# 7. External Stakeholders

## Clients (Banking Institutions)

**Relationship:** Contractual — the client pays for audit services.
**Touchpoints:**
- Operations Manager (project status, escalations, reporting)
- Administrator (contracting, billing, SLA definitions)
- Document Executive (data intake, report delivery)

**Needs:**
- Reliable coverage of all submitted branches
- Timely delivery of audit reports
- Visibility into project progress
- Professional handling of sensitive branch data

**Dependencies on us:**
- Branch list accuracy (we validate and flag issues)
- Coverage of all branches in their network
- Quality and timeliness of final reports

**Our dependencies on them:**
- Accurate and complete branch lists with correct addresses
- Customer master data provided on schedule
- Clear communication of scope changes

## Assayers (Independent Auditors)

**Relationship:** Non-contractual commercial relationship — assayers work assignment-by-assignment.
**Touchpoints:**
- Operations Executive (assignment offers, negotiation, scheduling, support)
- Document Executive (document dispatch and receipt)
- Administrator (payment processing, KYC updates)

**Needs:**
- Fair and timely compensation
- Assignments close to their location
- Clear assignment briefings and complete documentation
- Professional and responsive coordination
- Reliable scheduling (no last-minute changes)

**Our dependencies on them:**
- Willingness to accept assignments (no obligation)
- Quality and timeliness of fieldwork
- Professional conduct at client branches
- Timely return of completed documents

## Regulatory Bodies

**Relationship:** Compliance obligation.
**Requirements:**
- Audit trail retention for specified periods
- Data privacy and protection for client branch information
- Assayer credential verification
- Adherence to banking audit standards

---

# 8. Business Capabilities

## Client Management Capabilities

| Capability | Description |
|-----------|-------------|
| Client Onboarding | Contract, SLA, rate card, contact setup |
| Client Configuration | Per-client operational parameters (working days, radius, SLA targets) |
| Client Communication | Status reporting, escalation, query resolution |
| Client Reporting | Project completion reports, coverage summaries |

## Branch Management Capabilities

| Capability | Description |
|-----------|-------------|
| Branch List Intake | Receive branch lists from clients in various formats |
| Branch Validation | Verify address, location, geography against reference data |
| Branch Deduplication | Identify and handle branches appearing in multiple projects |
| Branch Geocoding | Determine geographic coordinates for planning and proximity search |
| Branch Lifecycle | Track branch through planning, assignment, audit, and completion |

## Assayer Management Capabilities

| Capability | Description |
|-----------|-------------|
| Assayer Onboarding | KYC, bank details, PAN verification, agreement, status setup |
| Assayer Profiling | Skills, specialization, geographic coverage area, availability |
| Assayer Status Management | Track availability (active, busy, inactive, suspended) |
| Assayer Performance History | Track acceptance rate, quality score, timeliness |
| Assayer Payout Management | Track fees, generate payment data |

## Project Planning Capabilities

| Capability | Description |
|-----------|-------------|
| Project Creation | Define project scope, client, timeline, priorities |
| Branch Organization | Group branches into zones for planning efficiency |
| Coverage Target Setting | Define coverage goals per project |
| Planning Workspace | Multi-panel view of branches, candidates, assignments, and coverage |
| Project Lifecycle | Manage project through phases: draft, planning, scheduling, execution, validation, completed, archived |

## Assignment Capabilities

| Capability | Description |
|-----------|-------------|
| Candidate Identification | Find suitable assayers based on proximity, workload, history |
| Candidate Comparison | View multiple recommendations with decision-relevant data |
| Contact Initiation | Log first contact attempt, track response |
| Fee Negotiation | Discuss and agree fee for assignment |
| Availability Negotiation | Discuss and agree dates |
| Assignment Confirmation | Formal acceptance of assignment by both parties |
| Assignment Lifecycle | Track through: created, candidate selected, contact initiated, negotiation, accepted, scheduled, audit completed, closed |

## Scheduling Capabilities

| Capability | Description |
|-----------|-------------|
| Date Proposal | Propose audit date based on branch location, assayer availability |
| Holiday Conflict Detection | Check against holiday calendar (national, regional, bank) |
| Assayer Availability Check | Verify assayer is not already booked |
| Double-Booking Prevention | Ensure no two assignments conflict |
| Schedule Confirmation | Formal confirmation of audit date |
| Rescheduling | Change date with conflict re-check, audit trail |

## Communication Capabilities

| Capability | Description |
|-----------|-------------|
| Interaction Logging | Record all communications: phone, WhatsApp, email, in-person |
| Outcome Tracking | Was assayer reached? What was discussed? What are next steps? |
| Communication History | Complete timeline per assignment for audit and continuity |
| Contact Attempt Tracking | Track attempts even when assayer not reached |

## Document Management Capabilities

| Capability | Description |
|-----------|-------------|
| Document Intake | Receive and register incoming client data files |
| Document Generation | Trigger PDF audit document package creation |
| Document Dispatch | Send documents to assayers, track delivery |
| Document Receipt | Log return of completed documents |
| Document Versioning | Track revisions and updates to documents |
| Document Archival | Maintain document repository with retention policies |

## Validation Capabilities

| Capability | Description |
|-----------|-------------|
| Validation Case Creation | Create review case when completed documents are received |
| Case Assignment | Assign validation cases to validators |
| OCR Processing | Machine processing of returned documents |
| Human Review | Manual comparison and verification of OCR output |
| Correction Workflow | Flag, assign, complete, and verify corrections |
| Quality Approval | Final sign-off on validated cases |
| Report Assembly | Compile validated results into client report |

## Coverage & Analytics Capabilities

| Capability | Description |
|-----------|-------------|
| Coverage Calculation | What % of branches are assigned/scheduled/completed |
| Multi-Level Coverage | By project, zone, state, client |
| Trend Tracking | Coverage trends over time, project-to-project comparison |
| Assayer Utilization | How many active assignments per assayer, historical load |
| SLA Monitoring | Track adherence to service level targets |

---

# 9. End-to-End Business Processes

## Process 1: Client Onboarding

**Trigger:** New client contract signed.

| Step | Owner | Activity | Output |
|------|-------|----------|--------|
| 1 | Administrator | Set up client profile in system | Client record created |
| 2 | Administrator | Define client configuration (working days, radius, SLA targets) | Client configuration |
| 3 | Administrator | Set up client contact users | User accounts |
| 4 | Administrator | Define import mapping for client's branch list format | Import template |
| 5 | Administrator | Provide client with submission guidelines | Instruction document |
| 6 | Operations Manager | Review client requirements and assign to Operations Executive | Project team assigned |

**Frequency:** Once per new client.

---

## Process 2: Project Creation and Branch Import

**Trigger:** Client submits branch list for audit.

| Step | Owner | Activity | Output |
|------|-------|----------|--------|
| 1 | Client User | Submit branch list file | Excel/CSV file |
| 2 | Document Executive | Receive and log incoming file | File registered |
| 3 | Operations Manager | Create project (name, client, dates, priority) | Project created |
| 4 | Operations Executive | Import branch list using client's import mapping | Branches loaded |
| 5 | Operations Executive | Validate imported data (check required fields, geography) | Validation report |
| 6 | Operations Executive | Resolve data issues (missing fields, bad addresses) | Clean branch data |
| 7 | Operations Executive | Organize branches into zones | Zoned branch list |
| 8 | Operations Manager | Review and approve project setup | Project ready for planning |

**Inputs:** Client branch list file (Excel/CSV).
**Outputs:** Organized, validated branch list grouped into zones.

**Frequency:** Per project cycle (typically monthly per client).

---

## Process 3: Assayer Assignment (The Core Workflow)

**Trigger:** Branches are organized and ready for assignment.

```
    ┌─────────────────────────────────────────────────────────────┐
    │                  ASSIGNMENT WORKFLOW                        │
    ├─────────────────────────────────────────────────────────────┤
    │                                                             │
    │  1. SELECT CANDIDATE                                        │
    │     Operations Executive views recommended assayers         │
    │     for a branch based on proximity and availability        │
    │     ↓                                                       │
    │  2. INITIATE CONTACT                                        │
    │     Operations Executive calls/messages assayer             │
    │     Records contact attempt (date, time, channel)           │
    │     ↓                                                       │
    │  3. NEGOTIATE                                               │
    │     Discuss: Fee, availability, travel, timing              │
    │     May go through multiple rounds                          │
    │     Record each interaction                                 │
    │     ↓                                                       │
    │  4. DECISION                                                │
    │     ┌── ACCEPTED ──┐          ┌── REJECTED ──┐             │
    │     │              │          │              │             │
    │  5a. CONFIRM       │     5b. RETURN TO       │             │
    │      Agreed fee    │         CANDIDATE       │             │
    │      Confirmed date│         SEARCH          │             │
    │      Status set    │                         │             │
    │      ↓             │                         │             │
    │  6. SCHEDULE       │                         │             │
    │      Finalize date │                         │             │
    │      Check holiday │                         │             │
    │      Create record │                         │             │
    │      ↓             │                         │             │
    │  7. DOCUMENT PHASE │                         │             │
    │      (separate)    │                         │             │
    └─────────────────────────────────────────────────────────────┘
```

**Decision Point:** Operations Executive can negotiate. Operations Manager approves final acceptance for high-value or complex assignments.

**Exception Paths:**
- No candidate available → Escalate to Operations Manager → May accept reduced coverage
- Assayer drops out after acceptance → Return to candidate search, reprioritize
- Fee disagreement → Multiple negotiation rounds, or Operations Manager approves rate exception

---

## Process 4: Document Pipeline

**Trigger:** Assignment accepted and scheduled.

| Step | Owner | Activity | Output |
|------|-------|----------|--------|
| 1 | Client User | Upload customer master data for each branch | Data files |
| 2 | Document Executive | Receive and log customer data | Data registered |
| 3 | Document Executive | Trigger PDF generation for each branch's audit package | PDF documents |
| 4 | Operations Executive | Verify PDFs are complete and accurate | Verified documents |
| 5 | Document Executive | Dispatch PDFs to assayer (T-1 before audit) | Documents sent |
| 6 | Document Executive | Log dispatch (date, method, tracking) | Dispatch record |
| 7 | Assayer | Acknowledge receipt | Receipt confirmation |
| 8 | Assayer | Perform field audit | Completed documents |
| 9 | Assayer | Return completed documents | Returned documents |
| 10 | Document Executive | Log receipt and verify completeness | Receipt record |
| 11 | Document Executive | Forward documents to validation | Documents to validation |

**Deadline:** Dispatch by T-1 (day before scheduled audit). Return within agreed timeframe (typically 2-5 days after audit).

---

## Process 5: Validation Workflow

**Trigger:** Completed documents received from assayer.

| Step | Owner | Activity | Output |
|------|-------|----------|--------|
| 1 | Validation Manager | Create validation case for received documents | Case created |
| 2 | Validation Manager | Assign case to a Validator | Case assigned |
| 3 | Validator | Run/document OCR processing | OCR output |
| 4 | Validator | Human review: compare OCR to originals | Review record |
| 5 | Validator | Decision: Approved or Corrections Needed | Decision |
| 6 | Validation Manager | If corrections: review and verify changes | Corrected case |
| 7 | Validation Manager | Approve final validation | Case approved |
| 8 | Document Executive | Compile final report package | Report ready |

**Decision Points:**
- Validator decides if corrections are needed
- Validation Manager approves final quality
- If quality issues are systemic → escalate to Operations Manager

---

## Process 6: Client Reporting

**Trigger:** Validation completed for a project (or on scheduled reporting date).

| Step | Owner | Activity | Output |
|------|-------|----------|--------|
| 1 | Operations Manager | Review project completion status | Status summary |
| 2 | Document Executive | Compile all validated cases into client report | Report draft |
| 3 | Validation Manager | Verify report accuracy | Verified report |
| 4 | Operations Manager | Approve report for delivery | Approved report |
| 5 | Document Executive | Deliver report to client | Report sent |
| 6 | Operations Manager | Follow up with client for feedback/acceptance | Client acceptance |

---

# 10. Standard Operating Procedures

## SOP 1: Branch List Intake

**Purpose:** Ensure branch data is complete, accurate, and usable before entering planning.

**Procedure:**

1. Receive branch list file from client via defined channel
2. Verify file format matches expected format (per client's import mapping)
3. Load file into system and validate:
   - All required fields present (branch code, name, address, state, district, city)
   - Geography references valid (state, district, city exist in reference data)
   - No duplicate branch codes within client or project
   - Coordinates (if provided) are within expected range
4. Generate validation report showing:
   - Total branches received
   - Branches with valid data
   - Branches with data issues (missing fields, invalid geography)
   - Next steps (resolve issues, accept with notes, or reject)
5. If issues exist, contact client for clarification or correction

**Owner:** Operations Executive
**Timeline:** Within 1 business day of receipt.

## SOP 2: Assayer Contact Protocol

**Purpose:** Ensure consistent, professional, and documented communication with assayers.

**Procedure:**

1. Before contacting, verify:
   - Assayer status is ACTIVE (not suspended, inactive, or busy)
   - Assayer has no existing accepted assignments for the same date range
   - Assayer distance to branch is within acceptable range (default 50km, configurable per client)
2. Preferred contact order: Phone call first, WhatsApp/text follow-up, email as formal record
3. During call:
   - Introduce yourself and the project
   - Explain: branch name, location, proposed date range, expected fee range
   - Ask: availability, interest, any concerns
   - If interested, discuss: specific fee, specific dates, travel requirements
4. After call, within 1 hour:
   - Log contact record: date, time, duration, channel, outcome
   - Log notes: discussed points, assayer concerns, next steps
   - If fee agreed and date tentatively set, create assignment with status NEGOTIATION

**Owner:** Operations Executive
**Standard:** Every assayer contact must be logged. No verbal-only agreements.

## SOP 3: Dispatch Document Package

**Purpose:** Ensure assayers receive complete, correct audit documents before fieldwork.

**Procedure:**

1. After assignment is accepted and scheduled:
   - Verify customer master data has been received from client
   - Verify PDF generation is complete
   - Review PDF package for completeness (all required forms present, correct branch name, correct dates)
2. Assemble dispatch package:
   - Audit instruction sheet
   - Audit forms per branch
   - Customer master data
   - Return instructions
3. Dispatch via agreed method (physical courier or secure electronic delivery):
   - Log dispatch: date, method, tracking ID, recipient confirmation
4. Confirm receipt with assayer within 24 hours
   - If no confirmation, follow up by phone
5. Deadline: Dispatch must occur by T-1 (one day before scheduled audit date)

**Owner:** Document Executive
**Standard:** 100% dispatch completion by T-1. 100% receipt confirmation before audit date.

---

# 11. Business Rules

## Branch Rules

| Rule ID | Rule | Source |
|---------|------|--------|
| BR-B01 | Every branch must belong to exactly one client | Data integrity |
| BR-B02 | Branch code is unique within a client | Data integrity |
| BR-B03 | A branch cannot appear in two active projects simultaneously | Operational |
| BR-B04 | Branch address, state, district, and city are mandatory | Operational |
| BR-B05 | Branch state/district/city must exist in geographic reference data | Validation |
| BR-B06 | Duplicate branches within a project are not allowed | Operational**
BR-B07 | Branches cannot be physically deleted — only deactivated (soft delete) | Audit |

## Assignment Rules

| Rule ID | Rule | Source |
|---------|------|--------|
| BR-A01 | An assayer can have only one assignment per branch per project | Operational |
| BR-A02 | An assayer cannot be double-booked on the same date | Operational |
| BR-A03 | Assignments cannot be scheduled on holidays (national, regional, or bank) | Operational |
| BR-A04 | Only ACTIVE assayers can receive assignment offers | Operational |
| BR-A05 | Once accepted, an assignment cannot be modified without cancellation and re-creation | Commitment |
| BR-A06 | Assignment fees must be within the agreed range for the client | Contract |
| BR-A07 | Every assignment status change requires an audit record | Compliance |

## Project Rules

| Rule ID | Rule | Source |
|---------|------|--------|
| BR-P01 | Projects follow lifecycle: Draft → Planning → Scheduling → Execution → Validation → Completed → Archived | Operational |
| BR-P02 | A project cannot move to Execution until all branches have either an assignment or an exception | Operational |
| BR-P03 | A project cannot move to Completed until all branches are completed or formally excepted | Operational |
| BR-P04 | Once Archived, a project is read-only | Compliance |
| BR-P05 | Project number must be unique across all clients | Data integrity |
| BR-P06 | Branches from different clients cannot be in the same project | Organizational |

## Communication Rules

| Rule ID | Rule | Source |
|---------|------|--------|
| BR-C01 | Every outbound contact with an assayer must be logged | Operational |
| BR-C02 | Fee discussions must be recorded with specific numbers discussed | Audit |
| BR-C03 | If an assayer rejects an offer, the reason must be recorded | Operational |
| BR-C04 | All communication records are immutable once created | Compliance |

## Document Rules

| Rule ID | Rule | Source |
|---------|------|--------|
| BR-D01 | Documents cannot be deleted — only versioned and archived | Compliance |
| BR-D02 | Every document dispatch must have a receipt confirmation | Operational |
| BR-D03 | Documents must be dispatched by T-1 before scheduled audit | SLA |
| BR-D04 | Customer master data must be received before PDF generation can begin | Dependency |

## Validation Rules

| Rule ID | Rule | Source |
|---------|------|--------|
| BR-V01 | Every completed assignment must go through validation | Operational |
| BR-V02 | Validator cannot validate their own assignments (separation of duties) | Quality |
| BR-V03 | A validation requiring corrections must be re-reviewed after correction | Quality |
| BR-V04 | Only the Validation Manager can approve final validation | Authority |

---

# 12. Decision Points & Authority

## Decision Matrix

| Decision | Routine/Exception | Decided By | Can Delegate To | Notes |
|----------|------------------|------------|-----------------|-------|
| Which assayer to contact first | Routine | Operations Executive | — | Recommendation engine suggests, human decides |
| Fee to propose | Routine | Operations Executive | — | Must be within client rate card range |
| Fee to accept (if above rate card) | Exception | Operations Manager | — | Requires justification |
| Whether to accept assignment | Routine | Operations Executive | — | After negotiation |
| Whether to override recommendation | Exception | Operations Manager | — | Override reason must be recorded |
| Project priority | Routine | Operations Manager | — | Based on client SLA |
| Whether to extend project deadline | Exception | Operations Manager | — | Client communication required |
| Whether to cancel accepted assignment | Exception | Operations Manager | — | Requires documented reason, client notification |
| Validation approval | Routine | Validator | — | Standard cases |
| Validation approval (complex case) | Exception | Validation Manager | — | Disputes, quality issues |
| Whether to re-audit a branch | Exception | Operations Manager + Validation Manager | — | Requires client notification |
| System configuration change | Routine | Administrator | — | Minimal impact |
| Business rule change | Exception | Managing Director / COO | — | Significant impact |
| New client acceptance | Exception | Managing Director / COO | — | Strategic decision |

## Escalation Path

```
Operations Executive
    → Operations Manager (fee exceptions, scheduling conflicts, no candidates)
        → Administrator (system issues, data integrity)
            → Managing Director / COO (client escalations, policy changes, strategic issues)

Validator
    → Validation Manager (quality disputes, complex corrections)
        → Operations Manager (systemic quality issues)
            → Managing Director / COO (process changes)
```

---

# 13. Exception Scenarios

## E1: No Assayer Available for a Branch

**Scenario:** PostGIS proximity search returns no ACTIVE assayers within the configured radius.

**Handling:**
1. Operations Executive expands search radius (subject to client SLA)
2. If still no candidate, escalate to Operations Manager
3. Operations Manager may:
   - Expand to adjacent states/regions
   - Contact inactive/suspended assayers to check availability
   - Mark branch as "Unable to Cover" with documented reason
   - Accept reduced coverage for that branch
4. If branch cannot be covered, client must be notified

**Business rule:** Coverage exceptions must be documented and approved by Operations Manager.

## E2: Assayer Drops Out After Acceptance

**Scenario:** Accepted assignment is cancelled by assayer (illness, schedule conflict, personal emergency).

**Handling:**
1. Operations Executive records reason for cancellation
2. Assignment status changed to CANCELLED with reason
3. Branch returns to candidate search pool
4. Operations Executive re-prioritizes the branch (priority increased)
5. If urgent (audit date within 48 hours), Operations Manager is notified
6. If no replacement available, escalate per E1

**Impact:** Delays audit for that branch. May affect project completion SLA.

## E3: Client Changes Scope Mid-Project

**Scenario:** After planning is complete, client adds or removes branches.

**Handling:**
1. Document Executive logs change request
2. Operations Manager evaluates impact on timeline and coverage
3. If branches added:
   - New branches imported and validated
   - Candidate search initiated
   - Existing assignments not affected unless reprioritization needed
4. If branches removed:
   - Existing assignments cancelled (with assayer notification)
   - Project scope adjusted
5. SLA timeline may need renegotiation with client

## E4: Documents Lost or Damaged

**Scenario:** Assayer reports documents lost in transit, damaged, or incomplete.

**Handling:**
1. Document Executive logs the issue
2. If before audit date:
   - Regenerate document package
   - Re-dispatch with priority
3. If after audit but before return:
   - Determine if assayer can complete audit without forms
   - If yes, assayer uses backup/alternative forms
   - If no, reschedule audit
4. If returned documents are damaged:
   - Assess if legible for OCR processing
   - If not, request assayer to resubmit
5. All document issues logged for tracking

## E5: Validation Quality Issues

**Scenario:** Systemic errors found during validation (wrong forms used, incomplete data, incorrect calculations).

**Handling:**
1. Validator flags issue and returns for correction
2. Validation Manager assesses if this is a training/process issue
3. If systemic:
   - Operations Manager notified
   - Root cause analysis conducted
   - Process improvement implemented
4. Individual case returned to correction workflow
5. If quality issue affects multiple assignments, batch review may be triggered

## E6: Concurrent Planning Conflicts

**Scenario:** Two Operations Executives attempt to assign the same assayer to different branches on the same date.

**Handling:**
1. System prevents double-booking at time of scheduling
2. Second executive sees conflict warning
3. Executives coordinate to resolve (which assignment takes priority)
4. If cannot resolve, Operations Manager decides

## E7: SLA Breach

**Scenario:** Coverage percentage falls below target, or assignment-to-audit timeline exceeds SLA.

**Handling:**
1. System generates alert
2. Operations Manager reviews and takes corrective action
3. If breach impacts client delivery:
   - Client notification prepared
   - Remediation plan communicated
4. Root cause documented for process improvement

---

# 14. Inputs & Outputs

## Process-Level Inputs and Outputs

| Process | Inputs | Outputs |
|---------|--------|---------|
| Client Onboarding | Signed contract, client requirements | Client profile, configuration, user accounts, import template |
| Project Creation | Client branch list | Validated, zoned project with branches |
| Assayer Assignment | Branch list, assayer database | Accepted assignments with agreed fees and dates |
| Document Handling | Customer master data, assignment data | Dispatched document packages, received completed documents |
| Validation | Completed audit documents | Validated cases, correction reports, quality records |
| Client Reporting | Validated cases, project data | Final audit reports, coverage summaries |

## Business Entity Catalog

| Entity | Description | Created By | Consumed By | Retention |
|--------|-------------|------------|-------------|-----------|
| Client | Banking institution contracting audits | Administrator | All departments | Indefinite (active) |
| Client Configuration | Per-client operating parameters | Administrator | Operations | Duration of contract |
| Branch | Bank branch requiring audit | Client import | Operations, Validation | Indefinite |
| Assayer | Independent field auditor | Administrator | Operations | Indefinite (active) |
| Project | Single audit cycle for a client | Operations Manager | All departments | Indefinite |
| Project Branch | Branch's participation in a project | Operations Executive | Operations, Validation | Indefinite |
| Assignment | Commitment between assayer and branch | Operations Executive | Operations, Document | Indefinite |
| Schedule | Confirmed audit date | Operations Executive | Operations, Assayer | Indefinite |
| Communication | Contact record with assayer | Operations Executive | Operations | Indefinite |
| Document | File in the audit workflow | Various | All departments | 7+ years (regulatory) |
| Validation Case | Review record for completed audit | Validation Manager | Validation | Indefinite |

---

# 15. Documents Exchanged

## Internal Documents

| Document | Purpose | Creator | Consumer | Format |
|----------|---------|---------|----------|--------|
| Audit Document Package | Standardized forms for field audit | Document Executive | Assayer | PDF |
| Dispatch Record | Log of document dispatch | Document Executive | Operations | Digital record |
| Receipt Confirmation | Proof of document delivery | Assayer / Courier | Document Executive | Digital |
| Validation Report | Review results for one case | Validator | Validation Manager | Digital |
| Correction Request | Flagged errors needing rework | Validator | Validator (self) | Digital |
| Quality Report | Summary of validation metrics | Validation Manager | Operations Manager | Digital |

## External Documents (Client-Facing)

| Document | Purpose | Sender | Receiver | Frequency |
|----------|---------|--------|----------|-----------|
| Branch List | Branches requiring audit | Client | Company | Per project |
| Customer Master Data | Per-branch data for audit | Client | Company | After assignment confirmation |
| Project Status Report | Coverage and progress | Company | Client | Weekly or on demand |
| Final Audit Report | Completed audit results | Company | Client | Per project |
| Invoice | Billing for services | Company (Finance) | Client | Per project or monthly |

## External Documents (Assayer-Facing)

| Document | Purpose | Sender | Receiver | Frequency |
|----------|---------|--------|----------|-----------|
| Assignment Offer | Branch details, fee, date | Company | Assayer | Per assignment |
| Audit Document Package | Forms and instructions | Company | Assayer | Per assignment |
| Completed Audit Documents | Filled audit results | Assayer | Company | Per assignment |
| Payment Advice | Fee confirmation | Company | Assayer | Per completed assignment |

---

# 16. Information Ownership

## Data Domains and Ownership

| Data Domain | Owner | Steward | Access |
|-------------|-------|---------|--------|
| Client Information | Operations Manager | Administrator | Ops, Document, Validation (relevant portions) |
| Client Financial Terms | Managing Director | Administrator | Admin only |
| Branch Data | Client (source) | Operations Manager | Ops, Validation |
| Assayer Personal Data | Assayer (source) | Administrator | Ops Executive (limited), Admin |
| Assayer Financial Data | Assayer (source) | Administrator | Admin only |
| Assignment Records | Operations Executive | Operations Manager | Ops, Document, Validation |
| Communication Logs | Operations Executive | Operations Manager | Ops |
| Document Files | Various | Document Executive | Document, Validation |
| Validation Records | Validator | Validation Manager | Validation, Ops (read) |
| Audit Trail | System (automated) | Administrator | Compliance, Admin |
| Configuration Data | Administrator | Administrator | Admin, Operations Manager (read) |

## Information Sensitivity Classification

| Classification | Description | Examples | Controls |
|----------------|-------------|----------|----------|
| Public | Non-sensitive operational data | Branch names, project names | No restriction |
| Internal | Day-to-day operational data | Assignment status, coverage metrics | All authenticated users |
| Confidential | Sensitive business data | Client financial terms, fee structures | Role-restricted |
| Restricted | Highly sensitive personal data | Assayer bank details, PAN numbers | Admin only, encrypted |

---

# 17. Approval Hierarchy

## Operational Approvals

| Action | Required Approval | Notes |
|--------|------------------|-------|
| Create project | Operations Manager | — |
| Modify project scope | Operations Manager | Client notification required |
| Archive project | Operations Manager | Only after all branches completed or excepted |
| Accept assignment (standard fee) | Operations Executive | Within rate card |
| Accept assignment (above rate) | Operations Manager | Documented exception |
| Cancel accepted assignment | Operations Manager | Reason required, assayer notified |
| Override recommendation | Operations Manager | Reason recorded |
| Unusual fee arrangement | Operations Manager | Documented |
| Approve validation (standard) | Validator | — |
| Approve validation (disputed) | Validation Manager | — |
| Close project | Operations Manager + Validation Manager | Both must confirm |
| Create new client | Managing Director / COO | — |
| Modify client SLA | Managing Director / COO | — |
| Onboard assayer | Administrator | KYC must be verified |
| Suspend assayer | Operations Manager | Reason required |

---

# 18. Key Performance Indicators

## Operational KPIs

| KPI | Formula | Target | Owner | Frequency |
|-----|---------|--------|-------|-----------|
| Branch Coverage % | (Assigned / Total) * 100 | >95% | Operations Manager | Daily |
| Assignment Cycle Time | Days from branch import to assignment accepted | <5 days | Operations Manager | Per project |
| Time-to-Contact | Hours from candidate identification to first contact | <24 hours | Operations Executive | Per assignment |
| Negotiation Success Rate | (Accepted / Total Contacted) * 100 | >70% | Operations Manager | Monthly |
| Scheduling Accuracy | (Scheduled as planned / Total scheduled) * 100 | >90% | Operations Manager | Monthly |
| Dispatch Timeliness | % dispatched by T-1 | 100% | Document Executive | Per dispatch |
| Document Return Rate | % returned within SLA | >95% | Document Executive | Monthly |
| Validation Throughput | Cases validated per day per validator | 15-20 | Validation Manager | Weekly |
| Correction Rate | (Cases requiring correction / Total) * 100 | <10% | Validation Manager | Monthly |
| Report Delivery Timeliness | % delivered by deadline | 100% | Operations Manager | Per project |

## Quality KPIs

| KPI | Formula | Target | Owner |
|-----|---------|--------|-------|
| Re-Audit Rate | (Branches requiring re-audit / Total) * 100 | <2% | Validation Manager |
| Client Satisfaction Score | Post-project survey | >4.0/5.0 | Operations Manager |
| Assayer Retention Rate | (Active >6 months / Total) * 100 | >80% | Operations Manager |
| Data Accuracy Rate | (Branches with valid data at import / Total) * 100 | >98% | Operations Executive |

## Financial KPIs

| KPI | Target | Owner |
|-----|--------|-------|
| Cost per Branch Audited | Decreasing trend | Operations Manager |
| Average Fee per Assignment | Stable or growing | Operations Manager |
| Assayer Payout Accuracy | 100% | Administrator |
| Client Invoice Accuracy | 100% | Administrator |

---

# 19. Service Level Agreements

## Standard SLAs (Business-Level, Not Technical)

| SLA ID | Metric | Target | Measurement | Owner |
|--------|--------|--------|-------------|-------|
| SLA-01 | Branch list processing | Within 2 business days of receipt | Queue to validated branches | Operations Manager |
| SLA-02 | Assayer assignment | Within 5 business days of project start | Project start to last assignment | Operations Manager |
| SLA-03 | Document dispatch | T-1 before scheduled audit | Scheduled date minus dispatch date | Document Executive |
| SLA-04 | Validation completion | Within 5 business days of document receipt | Receipt to approval | Validation Manager |
| SLA-05 | Final report delivery | Within 10 business days of audit completion | Audit completion to report sent | Operations Manager |
| SLA-06 | Client query response | Within 4 business hours | Query to initial response | Operations Manager |
| SLA-07 | Assayer query response | Within 2 business hours | Query to initial response | Operations Executive |
| SLA-08 | Assayer payout | Within 30 days of assignment completion | Completion to payment | Administrator |
| SLA-09 | New assayer onboarding | Within 2 business days of application | Application to active status | Administrator |
| SLA-10 | Exception resolution | Within 1 business day of escalation | Escalation to resolution or plan | Operations Manager |

---

# 20. Regulatory & Compliance Requirements

## Known Requirements

| Area | Requirement | Implication |
|------|-------------|-------------|
| Audit Trail | All business decisions and state changes must be recorded immutably | Every assignment status change, fee negotiation, communication must be logged |
| Data Retention | Client and audit records must be retained for minimum period (typically 7 years) | Documents and audit records must be preserved, not physically deleted |
| Data Privacy | Assayer personal information (PAN, bank details, address) must be protected | Access controls, encryption for sensitive fields |
| Separation of Duties | Operations and Validation functions must be independent | A validator cannot review their own assignments; Operations Manager cannot also be Validation Manager |
| Non-Repudiation | Assignment acceptances and fee agreements must be attributable | All agreements must be logged with user identity and timestamp |
| Client Confidentiality | One client's data must not be visible to another client | Strict data isolation between clients |
| Assayer Credential Verification | Assayer qualifications must be verified before onboarding | KYC process, PAN verification, bank account verification |

## Implied Requirements (Industry Best Practice)

| Area | Requirement |
|------|-------------|
| Document Chain of Custody | Every document transfer must be logged (who sent, who received, when) |
| Access Reviews | User access should be reviewed periodically (quarterly) |
| Change Control | Changes to configurations, business rules, and SLA targets should be logged |
| Incident Response | Process for handling data breaches, document loss, or operational failures |

---

# 21. Operational Constraints

## People Constraints

- Operations Executives cannot be in two places at once — they manage active projects sequentially
- Assayers are independent contractors — they have no obligation to accept any assignment
- Assayer availability varies seasonally (holiday periods, harvest seasons in rural areas)
- Validators require training and domain knowledge — not easily replaceable
- Single point of failure risk if only one person knows a client's preferences or an assayer's situation

## Process Constraints

- Planning cannot begin until branch list is received and validated
- PDF generation cannot begin until customer master data is received
- Documents cannot be dispatched until assignment is accepted and scheduled
- Validation cannot begin until documents are returned
- Project cannot close until all branches are completed or excepted
- Some processes are sequential by nature (document → audit → validation → report)
- Peak load periods (month-end, quarter-end) create bottlenecks

## External Constraints

- Branch locations are fixed — we cannot move branches closer to assayers
- Client data quality is variable — some clients provide clean data, others require significant cleanup
- Postal/courier reliability varies by region — document dispatch to remote areas may require longer lead times
- Banking regulations may require physical presence for certain audit steps (cannot be done remotely)
- Weather and local conditions can delay field audits (monsoon, flooding, civil unrest)
- Client contracting cycles can delay project initiation

## Technology Constraints

- Current operations rely on Excel files and phone calls — digital literacy varies among staff
- Assayers may not have reliable internet access in remote areas
- Some clients may require physical document delivery (cannot be fully digital)
- Mobile app for assayers would improve efficiency but requires development and adoption effort

---

# 22. Future Business Growth Assumptions

## Volume Growth

- From 1-2 clients to 5-10 clients over 2 years
- From 100-500 branches per month to 1000-5000 branches per month
- From 20-50 active assayers to 100-300 active assayers
- Multiple concurrent projects (different clients, different regions)

## Service Expansion

- New audit types: thematic audits, compliance checks, fraud investigation support
- New service lines: audit report analysis, trend reporting, benchmarking
- Geographic expansion: new states, new regions, potentially new countries

## Business Model Evolution

- From per-assignment pricing to retainer + per-assignment models
- Potential white-label partnership with larger audit firms
- Potential direct-to-client SaaS offering (license the platform, not the service)
- Assayer network as a marketplace (assayers can set availability, bid on assignments)

## Operational Model Implications

- Current manual processes will not scale to 10x volume
- Supervisor-to-executive ratio must improve through system-enforced workflows
- Self-service for clients (branch list upload, status checking, report download)
- Self-service for assayers (availability management, assignment browsing, document upload)
- Automated candidate recommendation must be reliable enough to reduce manual search time
- Coverage analytics must be real-time and proactive (alerts before SLA breaches, not after)

---

*End of Business Operating Model*
