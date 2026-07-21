# Business Domain Model

**Company:** Field Audit Services Provider
**Domain:** Field Audit Planning & Operations Management
**Document Type:** Canonical Business Domain Model (DDD)
**Date:** 2026-07-21
**Status:** Version 1 — Approved Business Operating Model as Source
**Authority:** This document is the single source of truth for all business concepts. No implementation decision shall be made that contradicts this model without formal deviation approval.

---

## Table of Contents

1. [Domain Index](#1-domain-index)
2. [Domain Definitions](#2-domain-definitions)
3. [Domain Relationship Map](#3-domain-relationship-map)
4. [Business Aggregates](#4-business-aggregates)
5. [Domain Events Catalog](#5-domain-events-catalog)
6. [Domain Dependencies](#6-domain-dependencies)
7. [Boundary Analysis](#7-boundary-analysis)
8. [Consistency Rules (Invariants)](#8-consistency-rules-invariants)
9. [Domain Maturity Assessment](#9-domain-maturity-assessment)

---

# 1. Domain Index

| # | Domain | Classification | Aggregate Root | Business Owner |
|---|--------|---------------|----------------|----------------|
| 1 | Client | Supporting | Yes | Administrator |
| 2 | Project | Core | Yes | Operations Manager |
| 3 | Branch | Supporting | Yes | Operations Executive |
| 4 | ProjectBranch | Core | Child of Project | Operations Executive |
| 5 | Assayer | Supporting | Yes | Administrator |
| 6 | Assignment | Core | Yes | Operations Executive |
| 7 | Schedule | Supporting | Child of Assignment | Operations Executive |
| 8 | Communication | Supporting | Child of Assignment | Operations Executive |
| 9 | Document | Supporting | Yes | Document Executive |
| 10 | ValidationCase | Core | Yes | Validation Manager |
| 11 | Coverage | Core | Calculated | Operations Manager |
| 12 | Report | Supporting | Yes | Document Executive |
| 13 | Payment | Supporting | Yes | Administrator |
| 14 | Notification | Generic | No | System |
| 15 | Holiday | Generic | Yes | Administrator |
| 16 | Zone | Supporting | Yes | Operations Manager |
| 17 | User | Generic | Yes | Administrator |
| 18 | Role | Generic | Yes | Administrator |
| 19 | Permission | Generic | No | Administrator |
| 20 | Configuration | Generic | Yes | Administrator |
| 21 | ReferenceData | Generic | Yes | Administrator |

---

# 2. Domain Definitions

---

## Domain 1: Client

### 1.1 Business Purpose

The Client domain exists to represent the banking institutions that engage the company to perform field audits. A client is the source of every project and the ultimate consumer of every audit report. The company cannot operate without clients.

### 1.2 Business Definition

A client is a financial institution (bank, credit union, or other regulated entity) that contracts the company to audit its branch network. Each client has a formal contractual relationship with the company, including agreed service levels, fee structures, and operational parameters.

### 1.3 Business Owner

- **Department:** Administration & Finance
- **Accountable:** Administrator
- **Maintained by:** Administrator

### 1.4 Primary Actors

| Action | Role |
|--------|------|
| Create | Administrator |
| Modify | Administrator, Operations Manager |
| View | Administrator, Operations Manager, Operations Executive, Document Executive, Validation Manager |
| Deactivate | Administrator (with Managing Director approval) |
| Configure | Administrator |

### 1.5 Lifecycle

| Stage | Description |
|-------|-------------|
| Prospect | Initial contact, no contract signed |
| Onboarding | Contract in progress, configuration being set up |
| Active | Contract signed, operations running |
| Suspended | Operations paused (contract dispute, payment issue) |
| Inactive | Contract completed, no active projects |
| Archived | Historical record only |

### 1.6 State Transition Matrix

| From | To | Who | Precondition |
|------|----|-----|--------------|
| Prospect | Onboarding | Administrator | Signed term sheet |
| Onboarding | Active | Administrator | Contract executed, configuration complete |
| Active | Suspended | Administrator | Operations Manager request |
| Suspended | Active | Administrator | Issue resolved |
| Active | Inactive | Administrator | All projects completed or transferred |
| Inactive | Archived | Administrator | Retention period confirmed |

**Forbidden transitions:** Prospect to Active (skips onboarding). Archived to Active (must re-onboard).

**Events raised:** ClientOnboarded, ClientSuspended, ClientReactivated, ClientDeactivated

### 1.7 Business Rules

| Rule ID | Rule | Type |
|---------|------|------|
| BR-C01 | A client must have a unique client code | Mandatory |
| BR-C02 | A client cannot have active projects while suspended | Mandatory |
| BR-C03 | Client configuration (working days, radius, SLA) must be defined before first project | Mandatory |
| BR-C04 | Client import mapping must be configured before branch list processing | Mandatory |
| BR-C05 | Client data must be isolated from other clients at all times | Mandatory |

### 1.8 Relationships

| Domain | Relationship | Business Meaning |
|--------|-------------|-----------------|
| Project | One-to-many | A client initiates many projects over time |
| Branch | One-to-many | A client owns many branches in their network |
| Configuration | One-to-one | A client has exactly one active configuration |
| User (Client) | One-to-many | A client may have multiple contact users |
| Zone | One-to-many | A client may define operational zones |
| Report | One-to-many | A client receives many reports across projects |

### 1.9 Business Data

- Client identity (legal name, display name, unique code)
- Contract information (effective dates, terms)
- Contact persons (name, email, phone)
- Operational configuration (working days, default radius, import mapping, SLA rules)
- Status and lifecycle history
- Notes and communications

### 1.10 Business Operations

- **Onboard:** Create client record and initial configuration
- **Configure:** Update operational parameters
- **View:** Review client profile and history
- **Suspend:** Temporarily halt operations
- **Reactivate:** Resume operations after suspension
- **Deactivate:** End client relationship

### 1.11 Validation Rules

- Client code must be unique
- Display name must be unique
- Contract must be signed before projects can be created
- Configuration must be complete before first project

### 1.12 KPIs

- Number of active clients
- Average project completion time per client
- Client retention rate
- Client satisfaction score

### 1.13 SLA Impact

SLA-01 through SLA-10 are configured per client. Client configuration defines SLA targets.

### 1.14 Risks

- Client data breach (confidential branch information)
- Single-client dependency (if one client represents >50% of revenue)
- Client payment default
- Scope creep beyond contracted terms

---

## Domain 2: Project

### 2.1 Business Purpose

The Project domain exists to organize a discrete audit cycle for a single client. It groups branches that need auditing, tracks coverage progress, and governs the lifecycle from branch list receipt through final reporting. A project is the operational container within which all audit activities occur.

### 2.2 Business Definition

A project is a time-bound audit engagement for one client. It begins when the client submits a list of branches requiring audit and ends when all branches have been audited (or formally excepted) and the final report has been delivered. A project typically corresponds to a monthly or quarterly audit cycle.

### 2.3 Business Owner

- **Department:** Operations
- **Accountable:** Operations Manager
- **Maintained by:** Operations Executive

### 2.4 Primary Actors

| Action | Role |
|--------|------|
| Create | Operations Manager |
| Plan | Operations Executive |
| Approve | Operations Manager |
| Execute | Operations Executive (coordination), Assayer (fieldwork) |
| Monitor | Operations Manager |
| Close | Operations Manager |
| Archive | Operations Manager |

### 2.5 Lifecycle

| Stage | Description |
|-------|-------------|
| Draft | Project created, no branches loaded yet |
| Planning | Branches imported, being organized and assigned |
| Scheduling | Assignments being scheduled |
| Execution | Field audits in progress (documents dispatched, assayers in field) |
| Validation | Field audits complete, documents being validated |
| Completed | All branches validated and reported |
| Archived | Final report delivered, project closed for historical reference |

### 2.6 State Transition Matrix

| From | To | Who | Precondition |
|------|----|-----|--------------|
| Draft | Planning | Operations Manager | Branches imported and validated |
| Planning | Scheduling | Operations Manager | All branches either assigned or exception-documented |
| Scheduling | Execution | Operations Manager | All assignments scheduled, documents dispatched or in progress |
| Execution | Validation | Operations Executive | All field audits completed, documents returned |
| Validation | Completed | Validation Manager | All validation cases approved |
| Completed | Archived | Operations Manager | Final report delivered, client acknowledged |

**Forbidden transitions:** Skip stages (e.g., Draft to Execution), reverse transitions without approval, archive an incomplete project.

**Exception transitions:**
- Any active stage to Pending (when blocked by client or external factor)
- Completed back to Validation (if quality issues found post-closure)

**Events raised:** ProjectCreated, ProjectBranchesLoaded, ProjectMovedToPlanning, ProjectMovedToScheduling, ProjectMovedToExecution, ProjectMovedToValidation, ProjectCompleted, ProjectArchived, ProjectBlocked

### 2.7 Business Rules

| Rule ID | Rule | Type |
|---------|------|------|
| BR-P01 | A project belongs to exactly one client | Mandatory |
| BR-P02 | Project number must be unique across all clients | Mandatory |
| BR-P03 | A client can have multiple projects but only one active at a time per branch | Conditional |
| BR-P04 | A project cannot enter Execution until all branches are assigned or exception-documented | Mandatory |
| BR-P05 | A project cannot enter Completed until all branches are validated | Mandatory |
| BR-P06 | Once Archived, a project is read-only | Mandatory |
| BR-P07 | Branches from different clients cannot be in the same project | Mandatory |
| BR-P08 | A project must have a defined start and end date | Conditional |
| BR-P09 | Project priority can be changed during Planning but not after Execution begins | Conditional |

### 2.8 Relationships

| Domain | Relationship | Business Meaning |
|--------|-------------|-----------------|
| Client | Many-to-one | Many projects belong to one client |
| ProjectBranch | One-to-many | A project contains many branch assignments |
| Assignment | One-to-many | A project has many assayer assignments |
| Document | One-to-many | A project generates many documents |
| Report | One-to-many | A project produces one or more reports |
| Coverage | One-to-one | A project has calculated coverage |
| Zone | Many-to-many | A project uses zones for organization |

### 2.9 Business Data

- Project identity (number, name, description)
- Client reference
- Date range (start, end, deadlines)
- Priority and status
- Branch and assignment summaries
- Coverage metrics
- Timeline and milestone dates
- Notes and remarks

### 2.10 Business Operations

- **Create:** Start new project for a client
- **Load Branches:** Import branch list into project
- **Plan:** Organize branches, set priorities, define zones
- **Transition:** Move project to next lifecycle stage
- **Monitor:** Review coverage, progress, deadlines
- **Block:** Pause project due to external factors
- **Complete:** Finalize project when all work is done
- **Archive:** Close project for historical retention

### 2.11 Validation Rules

- Client must be Active (not Suspended/Inactive)
- Project number must be unique
- Date range must be logical (start before end)
- Branches cannot be loaded from a different client
- Lifecycle transitions must follow defined order
- A project cannot be archived with pending validation cases

### 2.12 KPIs

- Project cycle time (draft to completed)
- Branch coverage percentage per project
- Time spent in each lifecycle stage
- Number of projects per Operations Executive
- On-time completion rate

### 2.13 SLA Impact

SLA-01 (branch list processing), SLA-02 (assignment), SLA-03 (dispatch), SLA-04 (validation), SLA-05 (report delivery)

### 2.14 Risks

- Scope creep (client adds branches mid-project)
- Delay in client providing customer master data
- Assayer shortage affecting coverage
- External factors (weather, holidays) delaying fieldwork

---

## Domain 3: Branch

### 3.1 Business Purpose

The Branch domain represents the physical bank branch locations that are the subject of audits. Branches are permanent master data that persist across multiple projects. The company must maintain accurate branch information including geographic location for planning and assayer matching.

### 3.2 Business Definition

A branch is a physical location of a banking client where audits are performed. Each branch has a unique identifier within the client's network, a physical address, and geographic coordinates. Branches may appear in multiple projects over time (e.g., quarterly audits).

### 3.3 Business Owner

- **Department:** Operations
- **Accountable:** Operations Manager
- **Maintained by:** Operations Executive

### 3.4 Primary Actors

| Action | Role |
|--------|------|
| Create | Operations Executive (via import) |
| Update | Operations Executive |
| Validate | Operations Executive |
| Geocode | Operations Executive (or automated process) |
| View | Operations, Validation, Document, Admin |
| Deactivate | Operations Manager |

### 3.5 Lifecycle

| Stage | Description |
|-------|-------------|
| Imported | Received from client, basic record created |
| Validated | Address and geography verified |
| Geocoded | Coordinates determined |
| Active | Available for project inclusion |
| Inactive | Removed from client's network (branch closure) |

### 3.6 State Transition Matrix

| From | To | Who | Precondition |
|------|----|-----|--------------|
| Imported | Validated | Operations Executive | Required fields complete, geography valid |
| Validated | Geocoded | System/Operations | Coordinates determined |
| Geocoded | Active | Operations Executive | Ready for use |
| Active | Inactive | Operations Manager | Branch permanently closed |

**Events raised:** BranchImported, BranchValidated, BranchGeocoded, BranchActivated, BranchDeactivated

### 3.7 Business Rules

| Rule ID | Rule | Type |
|---------|------|------|
| BR-B01 | Branch code is unique within a client | Mandatory |
| BR-B02 | Branch address, state, district, and city are mandatory | Mandatory |
| BR-B03 | State, district, and city must exist in geographic reference data | Mandatory |
| BR-B04 | A branch cannot appear in two active projects simultaneously | Mandatory |
| BR-B05 | Branches cannot be physically deleted | Mandatory |
| BR-B06 | A branch belongs to exactly one client | Mandatory |

### 3.8 Relationships

| Domain | Relationship | Business Meaning |
|--------|-------------|-----------------|
| Client | Many-to-one | Many branches belong to one client |
| ProjectBranch | One-to-many | A branch participates in many projects over time |
| Assignment | One-to-many (indirect) | A branch may have many assignments across projects |

### 3.9 Business Data

- Branch identity (code, name within client's network)
- Physical address (street, city, district, state, pincode)
- Geographic location (coordinates)
- Client reference
- Status and lifecycle history
- Audit history (past projects participated in)
- Notes

### 3.10 Business Operations

- **Import:** Create branch from client data
- **Validate:** Verify address and geography
- **Geocode:** Determine geographic coordinates
- **Update:** Correct or enhance branch information
- **Merge:** Resolve duplicate branch records
- **Deactivate:** Mark branch as no longer in client's network

### 3.11 Validation Rules

- Required fields: branch code, name, address, state, district, city
- Geography must match reference data
- Branch code + client combination must be unique
- Coordinates must be within valid range if provided

### 3.12 KPIs

- Percentage of branches with valid coordinates
- Duplicate branch rate
- Branch data completeness score

### 3.13 SLA Impact

SLA-01 (branch list processing time depends on data quality)

### 3.14 Risks

- Inaccurate branch addresses causing assayer travel issues
- Duplicate branches causing confusion
- Branch closures not communicated by client
- Incomplete geographic data affecting recommendation accuracy

---

## Domain 4: ProjectBranch

### 4.1 Business Purpose

ProjectBranch exists to represent a specific branch's participation in a specific project. It is the intersection of a branch and a project. This domain carries the branch's status within the project lifecycle distinctly from the branch's master record.

### 4.2 Business Definition

A ProjectBranch is a branch as it exists within a particular project. It tracks the branch's planning status, assignment status, scheduling, and results for that project. A single branch may have many ProjectBranch records across different projects over time.

### 4.3 Business Owner

- **Department:** Operations
- **Accountable:** Operations Manager
- **Maintained by:** Operations Executive

### 4.4 Primary Actors

| Action | Role |
|--------|------|
| Create | Operations Executive (via branch import) |
| Plan | Operations Executive |
| Assign | Operations Executive |
| Complete | Operations Executive (via assignment status) |
| Exception | Operations Manager |
| View | All operational roles |

### 4.5 Lifecycle

| Stage | Description |
|-------|-------------|
| Imported | Branch loaded into project, not yet planned |
| Planning | Being evaluated for assignment |
| CandidateSearch | Looking for suitable assayers |
| ContactInitiated | Assayer(s) being contacted |
| Negotiation | Fee and availability discussion in progress |
| AssignmentConfirmed | Assayer accepted, assignment created |
| Scheduled | Audit date confirmed |
| AuditCompleted | Fieldwork finished, documents returned |
| ValidationCompleted | Validation review done |
| Closed | Finalized in project |
| UnableToCover | Cannot find assayer — formally excepted |
| OnHold | Temporarily paused (client request, external factor) |
| Cancelled | Removed from project scope |

### 4.6 State Transition Matrix

| From | To | Who | Precondition |
|------|----|-----|--------------|
| Imported | Planning | Operations Executive | Branch validated |
| Planning | CandidateSearch | Operations Executive | Ready for assignment |
| CandidateSearch | ContactInitiated | Operations Executive | Candidate(s) identified |
| ContactInitiated | Negotiation | Operations Executive | Assayer expressed interest |
| ContactInitiated | CandidateSearch | Operations Executive | Assayer declined |
| Negotiation | AssignmentConfirmed | Operations Executive | Fee and date agreed |
| Negotiation | CandidateSearch | Operations Executive | Negotiation failed |
| AssignmentConfirmed | Scheduled | Operations Executive | Date confirmed, holiday-checked |
| Scheduled | AuditCompleted | Operations Executive | Documents returned |
| AuditCompleted | ValidationCompleted | Validator | Validation approved |
| ValidationCompleted | Closed | Operations Manager | Finalized |
| CandidateSearch | UnableToCover | Operations Manager | No candidate found |
| Any except Closed | OnHold | Operations Manager | External blocker |
| OnHold | (prior state) | Operations Manager | Blocker resolved |
| Any except Closed | Cancelled | Operations Manager | Branch removed from scope |
| UnableToCover | Planning | Operations Manager | New option available |

**Forbidden transitions:** Closed to any state (terminal). Cancelled to any state except Planning (with re-evaluation).

**Events raised:** ProjectBranchImported, ProjectBranchPlanned, CandidateSearchStarted, AssayerContacted, NegotiationStarted, AssignmentConfirmed, AuditScheduled, AuditCompleted, ValidationCompleted, BranchClosed, BranchUnableToCover, BranchOnHold, BranchCancelled

### 4.7 Business Rules

| Rule ID | Rule | Type |
|---------|------|------|
| BR-PB01 | A ProjectBranch exists for exactly one branch in exactly one project | Mandatory |
| BR-PB02 | A branch cannot appear in two active projects simultaneously | Mandatory |
| BR-PB03 | A ProjectBranch cannot be scheduled without a confirmed assignment | Mandatory |
| BR-PB04 | A ProjectBranch cannot be closed without completed validation | Mandatory |
| BR-PB05 | An UnableToCover decision requires Operations Manager approval | Mandatory |
| BR-PB06 | A Cancelled ProjectBranch cannot be re-activated without re-import | Conditional |

### 4.8 Relationships

| Domain | Relationship | Business Meaning |
|--------|-------------|-----------------|
| Project | Many-to-one | Many branches in one project |
| Branch | Many-to-one | Many project participations for one branch |
| Assignment | One-to-one (optional) | A ProjectBranch may have zero or one assignment |
| Document | One-to-many | Documents generated for this branch's audit |
| ValidationCase | One-to-one (optional) | A completed audit may have a validation case |

### 4.9 Business Data

- Project reference
- Branch reference
- Status within project
- Priority for this project
- Zone assignment
- Scheduled date
- Assignment reference (if assigned)
- Remarks and notes
- State transition history

### 4.10 Business Operations

- **Import:** Create from branch import
- **Plan:** Set priority, assign to zone
- **Search:** Initiate candidate search
- **Assign:** Link to assignment when accepted
- **Schedule:** Set audit date
- **Complete:** Mark branch audit done
- **Exception:** Flag as unable to cover
- **Hold:** Pause processing
- **Cancel:** Remove from project

### 4.11 Validation Rules

- Branch must belong to the project's client
- Branch cannot already be in another active project
- Status transitions must follow defined sequence
- Assignment is optional until AssignmentConfirmed
- An UnableToCover requires documented reason and approval

### 4.12 KPIs

- Planning cycle time (Imported to AssignmentConfirmed per branch)
- Coverage breakdown by status
- UnableToCover rate
- Re-cancellation rate

### 4.13 SLA Impact

SLA-02 (assignment) directly tracks ProjectBranch status progression.

### 4.14 Risks

- Branches taking too long in Negotiation
- High UnableToCover rate damaging client relationships
- Over-assignment of popular assayers causing delays

---

## Domain 5: Assayer

### 5.1 Business Purpose

The Assayer domain represents the independent field auditors who perform branch audits. Assayers are the primary workforce of the company's service delivery. Their availability, capability, and willingness to accept assignments directly determine the company's ability to deliver.

### 5.2 Business Definition

An assayer is an independent contractor who performs physical audits of bank branches. Each assayer has a geographic home location, professional credentials, banking information for payment, and a status indicating their current availability for work.

### 5.3 Business Owner

- **Department:** Administration & Finance (onboarding), Operations (engagement)
- **Accountable:** Administrator (records), Operations Manager (engagement)
- **Maintained by:** Administrator

### 5.4 Primary Actors

| Action | Role |
|--------|------|
| Onboard | Administrator |
| Update profile | Administrator (personal data), Operations Executive (operational) |
| View | Administrator, Operations Executive, Operations Manager |
| Contact | Operations Executive |
| Assign | Operations Executive |
| Suspend | Operations Manager |
| Process payment | Administrator |

### 5.5 Lifecycle

| Stage | Description |
|-------|-------------|
| Registered | Application received, basic information collected |
| Verified | KYC completed, credentials verified |
| Active | Qualified and available for assignments |
| Busy | Currently has active assignments, limited availability |
| Inactive | Temporarily unavailable (personal reasons, other commitments) |
| Suspended | Removed from active pool (quality issues, compliance) |

### 5.6 State Transition Matrix

| From | To | Who | Precondition |
|------|----|-----|--------------|
| Registered | Verified | Administrator | KYC documents verified, bank details confirmed |
| Verified | Active | Administrator | Ready for work |
| Active | Busy | System | Assigned to active assignments |
| Busy | Active | System | Assignments completed |
| Active | Inactive | Administrator | Assayer request or 90 days no activity |
| Inactive | Active | Administrator | Assayer confirms availability |
| Active/Busy | Suspended | Operations Manager | Quality issue, compliance violation |
| Suspended | Active | Operations Manager | Issue resolved |

**Events raised:** AssayerRegistered, AssayerVerified, AssayerActivated, AssayerBecameBusy, AssayerBecameAvailable, AssayerDeactivated, AssayerSuspended, AssayerReinstated

### 5.7 Business Rules

| Rule ID | Rule | Type |
|---------|------|------|
| BR-AS01 | Assayer code must be unique | Mandatory |
| BR-AS02 | Only Active assayers can receive assignment offers | Mandatory |
| BR-AS03 | A Suspended assayer cannot be assigned | Mandatory |
| BR-AS04 | KYC verification is mandatory before first assignment | Mandatory |
| BR-AS05 | Bank account and PAN details are mandatory for payment | Mandatory |
| BR-AS06 | Assayer status changes must be logged | Mandatory |

### 5.8 Relationships

| Domain | Relationship | Business Meaning |
|--------|-------------|-----------------|
| Assignment | One-to-many | An assayer may have many assignments across projects |
| Payment | One-to-many | An assayer receives many payments |
| Communication | One-to-many (indirect) | An assayer has many logged interactions |

### 5.9 Business Data

- Personal identity (name, contact details, address)
- Professional credentials (qualifications, certifications)
- Geographic home location (state, district, city, coordinates)
- Banking information (PAN, account number, IFSC)
- Status and availability history
- Assignment history (what they have done)
- Performance metrics (acceptance rate, quality score, timeliness)
- Notes and remarks

### 5.10 Business Operations

- **Onboard:** Register assayer, collect KYC, verify credentials
- **Update:** Modify profile information
- **Activate:** Make available for assignments
- **Suspend:** Remove from active pool
- **Reinstate:** Return to active pool
- **View History:** Review past assignments, communications, payments
- **Search:** Find suitable assayers for a branch

### 5.11 Validation Rules

- Assayer code must be unique
- Phone number and email must be provided
- Address must include state, district, city
- PAN number must follow format
- Banking information must be provided before first payment
- Status transition from Suspended to Active requires documented approval

### 5.12 KPIs

- Assayer utilization rate
- Assignment acceptance rate
- Average assignments per month
- Quality score (validation error rate)
- Timeliness score (on-time completion rate)
- Retention rate (active after 6 months, 12 months)

### 5.13 SLA Impact

SLA-02 (assignment) depends on assayer availability and responsiveness. SLA-07 (assayer query response) measures how quickly the company responds to assayers.

### 5.14 Risks

- Assayer shortage during peak periods
- Key assayer dependency (relying heavily on few individuals)
- Quality inconsistency across assayers
- Assayer churn (leaving for competitors or other work)
- Compliance risk (unverified credentials)
- Payment disputes

---

## Domain 6: Assignment

### 6.1 Business Purpose

The Assignment domain is the operational heart of the business. It represents the commitment between the company and an assayer to audit a specific branch. The assignment lifecycle governs the most complex business workflow — from candidate identification through negotiation, acceptance, execution, and closure.

### 6.2 Business Definition

An assignment is a formal commitment for a specific assayer to audit a specific branch within a specific project for an agreed fee on an agreed date. It represents the point at which planning becomes operational commitment. Until an assignment is accepted, no commitment exists.

### 6.3 Business Owner

- **Department:** Operations
- **Accountable:** Operations Manager
- **Maintained by:** Operations Executive

### 6.4 Primary Actors

| Action | Role |
|--------|------|
| Create candidate | Operations Executive |
| Initiate contact | Operations Executive |
| Negotiate | Operations Executive |
| Accept | Operations Executive (standard), Operations Manager (exception) |
| Schedule | Operations Executive |
| Cancel | Operations Manager |
| Complete | Assayer (fieldwork), Operations Executive (documentation) |
| Close | Operations Executive |

### 6.5 Lifecycle

| Stage | Description |
|-------|-------------|
| Created | Candidate identified for a branch, initial record |
| CandidateSelected | Specific assayer chosen as preferred candidate |
| ContactInitiated | First contact made with assayer |
| Negotiation | Fee and availability discussion in progress |
| Accepted | Assayer agreed, commitment established |
| Scheduled | Specific audit date confirmed |
| AuditPerformed | Field audit completed |
| DocumentsReturned | Completed documents received |
| Closed | Assignment finalized, payment due |

**Alternative terminal states:**
| Stage | Description |
|-------|-------------|
| Rejected | Assayer declined the offer |
| Cancelled | Accepted assignment cancelled (by either party) |
| Expired | Offer not responded to within SLA timeframe |

### 6.6 State Transition Matrix

| From | To | Who | Precondition |
|------|----|-----|--------------|
| Created | CandidateSelected | Operations Executive | Candidate assayer identified |
| CandidateSelected | ContactInitiated | Operations Executive | Contact details confirmed |
| ContactInitiated | Negotiation | Operations Executive | Assayer expressed interest |
| ContactInitiated | CandidateSelected | Operations Executive | Assayer not reached, try alternative |
| Negotiation | Accepted | Operations Executive | Fee agreed, availability confirmed |
| Negotiation | Rejected | Operations Executive | Assayer declined |
| Negotiation | CandidateSelected | Operations Executive | Negotiation failed, try alternative |
| Accepted | Scheduled | Operations Executive | Date confirmed, holiday-checked, double-booking checked |
| Scheduled | AuditPerformed | Assayer | Audit completed |
| AuditPerformed | DocumentsReturned | Document Executive | Documents received and logged |
| DocumentsReturned | Closed | Operations Executive | Validation completed |
| Accepted | Cancelled | Operations Manager | Reason documented |
| Scheduled | Cancelled | Operations Manager | Reason documented (urgent — assayer/company initiated) |
| (any pre-Accepted) | Cancelled | Operations Executive | No longer needed |

**Forbidden transitions:** Closed to any state (terminal). Rejected to Accepted (must create new assignment). Cancelled to Accepted.

**Events raised:** AssignmentCreated, CandidateSelected, ContactInitiated, NegotiationStarted, AssignmentAccepted, AssignmentRejected, AssignmentScheduled, AuditPerformed, DocumentsReturned, AssignmentClosed, AssignmentCancelled, AssignmentExpired

### 6.7 Business Rules

| Rule ID | Rule | Type |
|---------|------|------|
| BR-A01 | An assignment links one assayer to one ProjectBranch | Mandatory |
| BR-A02 | A ProjectBranch can have at most one accepted assignment at a time | Mandatory |
| BR-A03 | An assayer cannot have two accepted or scheduled assignments on the same date | Mandatory |
| BR-A04 | Assignments cannot be scheduled on holidays (national, regional, or bank) | Mandatory |
| BR-A05 | Only active assayers can receive assignment offers | Mandatory |
| BR-A06 | Once accepted, an assignment cannot be modified — must cancel and recreate | Mandatory |
| BR-A07 | A cancelled assignment requires documented reason | Mandatory |
| BR-A08 | Fee agreements must be within client rate card range | Conditional |
| BR-A09 | Fee exceptions require Operations Manager approval | Mandatory |
| BR-A10 | Every assignment status change must be audited | Mandatory |

### 6.8 Relationships

| Domain | Relationship | Business Meaning |
|--------|-------------|-----------------|
| ProjectBranch | One-to-one | An assignment is for exactly one branch in one project |
| Assayer | Many-to-one | Many assignments belong to one assayer |
| Schedule | One-to-one (optional) | An assignment may have a confirmed schedule |
| Communication | One-to-many | An assignment has many logged interactions |
| Document | One-to-many | An assignment generates and receives documents |

### 6.9 Business Data

- Assignment identity (unique number)
- Project and branch references
- Assayer reference
- Fee information (proposed, agreed)
- Date information (scheduled, completed)
- Status and lifecycle history
- Communication summary
- Documents associated
- Cancellation/rejection reasons
- Notes and remarks

### 6.10 Business Operations

- **Identify Candidate:** Select potential assayer for a branch
- **Initiate Contact:** Log first contact with assayer
- **Negotiate:** Discuss and record fee/availability discussions (may have multiple rounds)
- **Accept:** Confirm assignment when fee and date agreed
- **Schedule:** Set specific audit date
- **Cancel:** Terminate accepted assignment (with reason)
- **Record Completion:** Mark audit as performed
- **Return Documents:** Log receipt of completed documents
- **Close:** Finalize assignment
- **View History:** Review full assignment timeline

### 6.11 Validation Rules

- Branch must not already be assigned in this project
- Assayer must be Active (not Busy counts as available)
- Proposed fee must be within client rate card (or exception approved)
- Scheduled date must not be a holiday for the branch's state
- Assayer must not have another assignment on the same date
- Cancellation requires documented reason
- Assignment cannot be closed without documents returned

### 6.12 KPIs

- Time from Created to Accepted
- Negotiation cycle time (ContactInitiated to Accepted)
- Acceptance rate (Accepted / Contacted)
- Average fee per assignment
- Cancellation rate
- Time from Accepted to Scheduled
- Time from AuditPerformed to DocumentsReturned

### 6.13 SLA Impact

SLA-02 (assignment), SLA-03 (dispatch - depends on scheduling), SLA-07 (assayer query response)

### 6.14 Risks

- Negotiation failure leading to extended cycle time
- Assayer cancellation close to audit date
- Fee disputes
- Over-promising to client (assignments that cannot be fulfilled)
- Single assayer holding many assignments (key-person risk)

---

## Domain 7: Schedule

### 7.1 Business Purpose

The Schedule domain exists to formally record confirmed audit dates and manage rescheduling. It separates the scheduling concern from the assignment to allow independent management of date changes, conflict resolution, and calendar visibility.

### 7.2 Business Definition

A schedule is the confirmed date and logistical plan for a field audit. It is created after an assignment is accepted and the specific date is agreed between the Operations Executive and the Assayer. A schedule can be rescheduled if needed, with the complete change history preserved.

### 7.3 Business Owner

- **Department:** Operations
- **Accountable:** Operations Manager
- **Maintained by:** Operations Executive

### 7.4 Primary Actors

| Action | Role |
|--------|------|
| Propose date | Operations Executive |
| Confirm date | Operations Executive |
| Reschedule | Operations Executive |
| Approve reschedule | Operations Manager (if within 48 hours of audit) |
| View | Operations, Document, Validation, Assayer |

### 7.5 Lifecycle

| Stage | Description |
|-------|-------------|
| Tentative | Proposed date, not yet confirmed |
| Confirmed | Firm date agreed by both parties |
| InProgress | Audit in progress on this date |
| Completed | Audit performed on this date |
| Rescheduled | Date was changed, new schedule exists |

### 7.6 State Transition Matrix

| From | To | Who | Precondition |
|------|----|-----|--------------|
| Tentative | Confirmed | Operations Executive | Holiday check, double-booking check, assayer confirmed |
| Confirmed | InProgress | System | Date reached |
| InProgress | Completed | Assayer/Operations | Audit performed |
| Confirmed | Rescheduled | Operations Executive | New date proposed and agreed |
| Rescheduled | Confirmed | Operations Executive | New date confirmed |
| Rescheduled | Rescheduled | Operations Executive | Multiple reschedules possible |

**Events raised:** ScheduleProposed, ScheduleConfirmed, ScheduleRescheduled, ScheduleCompleted

### 7.7 Business Rules

| Rule ID | Rule | Type |
|---------|------|------|
| BR-SC01 | A schedule belongs to exactly one assignment | Mandatory |
| BR-SC02 | A schedule cannot be created without an accepted assignment | Mandatory |
| BR-SC03 | Scheduled date must not be a holiday (national/regional/bank) | Mandatory |
| BR-SC04 | An assayer cannot have concurrent schedules on the same date | Mandatory |
| BR-SC05 | Rescheduling within 48 hours of audit requires Operations Manager approval | Conditional |
| BR-SC06 | All schedule changes must be logged with reason | Mandatory |
| BR-SC07 | Documents must be dispatched by T-1 relative to scheduled date | Mandatory |

### 7.8 Relationships

| Domain | Relationship | Business Meaning |
|--------|-------------|-----------------|
| Assignment | One-to-one | A schedule exists for one assignment |
| Holiday | Many-to-many (validation) | Schedule must avoid holidays |

### 7.9 Business Data

- Assignment reference
- Scheduled date
- Previous schedule (for reschedule chain)
- Status
- Confirmed by (who agreed the date)
- Remarks and rescheduling reasons
- Date change history

### 7.10 Business Operations

- **Propose:** Suggest a date for the audit
- **Confirm:** Finalize the date after checks
- **Reschedule:** Change the confirmed date
- **View Schedule:** See calendar of upcoming audits
- **View Conflicts:** Check assayer and date availability

### 7.11 Validation Rules

- Date must be in the future (for new schedules)
- Date must not be a holiday
- Assayer must not already be booked on this date
- Assignment must be in Accepted state (or later)
- Rescheduling within 48 hours requires escalation

### 7.12 KPIs

- Schedule adherence (percentage of audits on original date)
- Rescheduling frequency
- Time from acceptance to schedule confirmation
- Emergency reschedule rate (within 48 hours)

### 7.13 SLA Impact

SLA-03 (dispatch is T-1 relative to schedule)

### 7.14 Risks

- Frequent rescheduling causing dispatch delays
- Last-minute cancellations after documents dispatched
- Holiday calendar not up-to-date
- Assayer double-booking not caught

---

## Domain 8: Communication

### 8.1 Business Purpose

The Communication domain exists to create a permanent, auditable record of every interaction between the company and assayers (and, where relevant, clients). This serves operational continuity (anyone can pick up where another left off), dispute resolution, and compliance.

### 8.2 Business Definition

A communication is a recorded interaction between an Operations Executive (or other company representative) and an assayer regarding an assignment. Communications include phone calls, WhatsApp messages, emails, SMS, and in-person conversations. Each communication captures the date, channel, participants, outcome, and discussion notes.

### 8.3 Business Owner

- **Department:** Operations
- **Accountable:** Operations Manager
- **Maintained by:** Operations Executive

### 8.4 Primary Actors

| Action | Role |
|--------|------|
| Create | Operations Executive |
| View | Operations Executive, Operations Manager |
| Archive | Administrator (after retention period) |

### 8.5 Lifecycle

| Stage | Description |
|-------|-------------|
| Recorded | Interaction logged |
| Referenced | Used in decision, negotiation, or dispute |
| Archived | Retention period met |

### 8.6 State Transition Matrix

Communications are append-only. Once recorded, they are never modified.

| From | To | Who | Precondition |
|------|----|-----|--------------|
| Recorded | Archived | Administrator | Retention period met |

**Events raised:** CommunicationRecorded

### 8.7 Business Rules

| Rule ID | Rule | Type |
|---------|------|------|
| BR-C01 | Every outbound contact with an assayer must be logged | Mandatory |
| BR-C02 | Communications are immutable once recorded | Mandatory |
| BR-C03 | Fee discussions must record specific numbers discussed | Mandatory |
| BR-C04 | If an assayer rejects an offer, the reason must be recorded | Mandatory |
| BR-C05 | Communication records cannot be deleted | Mandatory |

### 8.8 Relationships

| Domain | Relationship | Business Meaning |
|--------|-------------|-----------------|
| Assignment | Many-to-one | Many communications relate to one assignment |

### 8.9 Business Data

- Assignment reference
- Communication channel (phone, WhatsApp, email, SMS, in-person)
- Direction (inbound, outbound)
- Date and time
- Duration (for calls)
- Participants
- Subject
- Discussion notes
- Outcome (reached, not reached, follow-up required)
- Next steps

### 8.10 Business Operations

- **Log Call:** Record phone conversation details
- **Log Message:** Record WhatsApp/email/SMS exchange
- **Log Meeting:** Record in-person interaction
- **View History:** Review all communications for an assignment

### 8.11 Validation Rules

- Communication must be linked to an assignment
- Channel, direction, date, and notes are mandatory
- Once created, cannot be edited or deleted

### 8.12 KPIs

- Communications per assignment
- Average response time to assayer communications
- Contact attempt success rate

### 8.13 SLA Impact

SLA-07 (assayer query response time)

### 8.14 Risks

- Communications not logged (information loss)
- Inaccurate or incomplete notes
- Reliance on verbal-only communication without logging

---

## Domain 9: Document

### 9.1 Business Purpose

The Document domain manages all files that flow through the audit lifecycle — from client-submitted branch lists and customer master data to generated PDF audit packages, returned completed documents, and final reports. Document tracking ensures no file is lost, every version is preserved, and chain of custody is maintained.

### 9.2 Business Definition

A document is any file that is created, received, or exchanged as part of the audit process. Documents have a type (what they are), a status (where they are in their lifecycle), and versioning (changes over time). Documents are associated with projects, branches, and assignments.

### 9.3 Business Owner

- **Department:** Document Management
- **Accountable:** Document Executive (Lead)
- **Maintained by:** Document Executive

### 9.4 Primary Actors

| Action | Role |
|--------|------|
| Upload | Client User, Document Executive |
| Generate | Document Executive |
| Dispatch | Document Executive |
| Receive | Document Executive |
| Verify | Operations Executive |
| Process | Validator |
| View | Operations, Validation, Document, Administrator |

### 9.5 Lifecycle

| Stage | Description |
|-------|-------------|
| Uploaded | File received from external source |
| Processed | File verified and registered |
| Generated | System-generated document created |
| Dispatched | Sent to assayer |
| Received | Acknowledged by recipient |
| Returned | Completed document received back |
| Verified | Checked for completeness |
| Archived | Retained for compliance |

### 9.6 State Transition Matrix

| From | To | Who | Precondition |
|------|----|-----|--------------|
| Uploaded | Processed | Document Executive | File verified, metadata recorded |
| Processed | Generated | Document Executive/System | Customer master data available |
| Generated | Dispatched | Document Executive | Assignment accepted and scheduled |
| Dispatched | Received | Assayer/Courier | Delivery confirmation |
| Received | Returned | Document Executive | Assayer submits completed document |
| Returned | Verified | Document Executive | Completeness checked |
| Verified | Archived | Document Executive | Project completed, retention period met |

**Events raised:** DocumentUploaded, DocumentProcessed, DocumentGenerated, DocumentDispatched, DocumentReceived, DocumentReturned, DocumentVerified, DocumentArchived

### 9.7 Business Rules

| Rule ID | Rule | Type |
|---------|------|------|
| BR-D01 | Documents cannot be deleted — only versioned and archived | Mandatory |
| BR-D02 | Every document dispatch must have a receipt confirmation | Mandatory |
| BR-D03 | Documents must be dispatched by T-1 before scheduled audit | Mandatory |
| BR-D04 | Customer master data must be received before PDF generation | Mandatory |
| BR-D05 | Document uploads must pass file type and size validation | Mandatory |
| BR-D06 | Each document version must be independently retrievable | Mandatory |
| BR-D07 | Completed documents cannot be dispatched (they must return) | Mandatory |

### 9.8 Relationships

| Domain | Relationship | Business Meaning |
|--------|-------------|-----------------|
| Project | Many-to-one | A project has many documents |
| Assignment | Many-to-one | An assignment has associated documents |
| ProjectBranch | Many-to-one | Documents are per-branch within a project |
| ValidationCase | One-to-one (optional) | A validated case references a completed document |

### 9.9 Business Data

- File metadata (name, type, size, format)
- Document type (branch list, customer data, audit PDF, completed audit, report)
- Status and lifecycle history
- Version number
- Parent document (for version chains)
- Ownership (who uploaded/generated)
- Dispatch tracking (date sent, method, recipient, confirmation)
- Return tracking (date received, condition)
- Notes

### 9.10 Business Operations

- **Upload:** Receive file from client or assayer
- **Generate:** Create PDF audit package
- **Dispatch:** Send document to assayer
- **Confirm Receipt:** Log delivery confirmation
- **Receive Return:** Log returned completed documents
- **Verify:** Check completeness and legibility
- **Archive:** Move to long-term retention
- **View Versions:** Browse document revision history

### 9.11 Validation Rules

- File type must be in allowed list
- File size must be within limits
- Document type must be valid for current workflow stage
- Dispatch requires accepted assignment and confirmed schedule
- Returned document must match dispatched document (version tracking)

### 9.12 KPIs

- Dispatch timeliness (percentage dispatched by T-1)
- Document return rate within SLA
- Document loss rate
- Average document processing time

### 9.13 SLA Impact

SLA-03 (dispatch), SLA-04 (validation — depends on document return)

### 9.14 Risks

- Document loss in transit
- Document damage or illegibility
- Late dispatch causing audit delays
- Unreturned documents causing incomplete validation
- Storage capacity and retention policy violations

---

## Domain 10: ValidationCase

### 10.1 Business Purpose

The ValidationCase domain exists to manage the quality review of completed audits. It ensures that every returned audit document is checked for accuracy, completeness, and compliance before being included in the final client report.

### 10.2 Business Definition

A validation case is a quality review instance created when completed audit documents are returned from an assayer. It tracks the review process through OCR processing, human verification, correction (if needed), and final approval. Validation is the last quality gate before results are delivered to the client.

### 10.3 Business Owner

- **Department:** Quality & Validation
- **Accountable:** Validation Manager
- **Maintained by:** Validator

### 10.4 Primary Actors

| Action | Role |
|--------|------|
| Create | Validation Manager |
| Assign | Validation Manager |
| Review | Validator |
| Correct | Validator |
| Approve | Validation Manager |
| View | Operations Manager (read), Operations Executive (read) |

### 10.5 Lifecycle

| Stage | Description |
|-------|-------------|
| Pending | Created, awaiting assignment to validator |
| Assigned | Validator assigned but review not started |
| OCRProcessing | Document being machine-processed |
| HumanReview | Validator reviewing OCR output against original |
| CorrectionRequired | Errors found, being corrected |
| Approved | Review passed, awaiting final sign-off |
| Submitted | Final approval given, case closed |

### 10.6 State Transition Matrix

| From | To | Who | Precondition |
|------|----|-----|--------------|
| Pending | Assigned | Validation Manager | Validator available |
| Assigned | OCRProcessing | System/Validator | Document ready |
| OCRProcessing | HumanReview | Validator | OCR output generated |
| HumanReview | Approved | Validator | No errors found |
| HumanReview | CorrectionRequired | Validator | Errors identified |
| CorrectionRequired | HumanReview | Validator | Corrections made, re-review needed |
| Approved | Submitted | Validation Manager | Final quality check passed |

**Forbidden transitions:** Skip OCRProcessing. Submitted to any other state (terminal). Approve without review.

**Events raised:** ValidationCaseCreated, ValidatorAssigned, OCRProcessingStarted, HumanReviewStarted, ValidationApproved, CorrectionRequired, ValidationSubmitted

### 10.7 Business Rules

| Rule ID | Rule | Type |
|---------|------|------|
| BR-V01 | Every completed assignment must have a validation case | Mandatory |
| BR-V02 | A validator cannot validate an assignment they were involved in planning | Mandatory |
| BR-V03 | Correction-required cases must be re-reviewed after correction | Mandatory |
| BR-V04 | Only the Validation Manager can submit a case | Mandatory |
| BR-V05 | Validation must be completed within SLA timeline | Conditional |

### 10.8 Relationships

| Domain | Relationship | Business Meaning |
|--------|-------------|-----------------|
| ProjectBranch | One-to-one (optional) | A validation case reviews one branch's audit |
| Document | One-to-many | A case references the completed document and its versions |
| User (Validator) | Many-to-one | Cases are assigned to a specific validator |
| User (Approver) | Many-to-one | Cases are approved by a Validation Manager |

### 10.9 Business Data

- Project and branch reference
- Document reference
- Assigned validator
- OCR processing results
- Human review notes
- Correction records
- Approval records
- Status and lifecycle history

### 10.10 Business Operations

- **Create Case:** Initiate validation when documents returned
- **Assign:** Allocate case to a specific validator
- **Process OCR:** Run optical character recognition
- **Review:** Compare OCR output to original documents
- **Flag Correction:** Identify and record errors
- **Approve:** Confirm review passed
- **Submit:** Final approval and closure

### 10.11 Validation Rules

- Validator must not have been involved in the assignment's planning
- Document must be marked as Returned before validation can start
- Correction requires re-review by the same or different validator
- Only Validation Manager can override a correction-required decision
- Validation cannot be submitted without approved review

### 10.12 KPIs

- Validation throughput (cases per validator per day)
- Correction rate (percentage requiring correction)
- Average time from assignment to validation completion
- Re-audit rate (cases failing post-validation audit)

### 10.13 SLA Impact

SLA-04 (validation completion), SLA-05 (report delivery depends on validation)

### 10.14 Risks

- Validator shortage causing backlog
- Quality escapes (errors not caught in review)
- Correction workflow causing delays
- OCR accuracy affecting review time
- Disagreements between validator and operations on quality standards

---

## Domain 11: Coverage

### 11.1 Business Purpose

The Coverage domain provides visibility into audit progress across projects, zones, states, and clients. It answers the fundamental operational question: "What percentage of branches are covered?" Coverage is the primary metric by which project health is measured.

### 11.2 Business Definition

Coverage is the calculated percentage of branches in a project that have progressed through the assignment lifecycle. It is measured at multiple levels and in multiple tiers:

- **Planned Coverage:** Branches in Planning or CandidateSearch status
- **Confirmed Coverage:** Branches with accepted assignments
- **Completed Coverage:** Branches with completed audits and validated results

### 11.3 Business Owner

- **Department:** Operations
- **Accountable:** Operations Manager
- **Maintained by:** System (automated calculation)

### 11.4 Primary Actors

| Action | Role |
|--------|------|
| View | Operations Manager, Operations Executive, Client User |
| Analyze | Operations Manager |
| Report | Operations Manager |
| Act on | Operations Manager (low coverage → intervene) |

### 11.5 Lifecycle

Coverage is a calculated metric, not a stateful entity. It is recalculated whenever:
- A ProjectBranch changes status
- Branches are added to or removed from a project
- On a scheduled basis for trend tracking

### 11.6 Business Rules

| Rule ID | Rule | Type |
|---------|------|------|
| BR-COV01 | Coverage is calculated at project, zone, state, and client levels | Mandatory |
| BR-COV02 | Coverage has three tiers: planned, confirmed, completed | Mandatory |
| BR-COV03 | Coverage calculation must be triggered by relevant state changes | Mandatory |
| BR-COV04 | Coverage results are cached and not computed on every view | Conditional |

### 11.7 Relationships

| Domain | Relationship | Business Meaning |
|--------|-------------|-----------------|
| Project | One-to-one | Each project has coverage metrics |
| ProjectBranch | Aggregation | Coverage is derived from branch statuses |

### 11.8 Business Data

- Total branches in scope
- Branches by status (planned, assigned, scheduled, completed, unable to cover)
- Coverage percentages (planned, confirmed, completed)
- Breakdown by zone, state, client
- Trend data over time

### 11.9 Business Operations

- **View Coverage:** See current coverage at any level
- **Analyze Coverage:** Identify gaps, bottlenecks, trends
- **Alert on Threshold:** Notify when coverage drops below target

### 11.10 KPIs

See section 18 of Business Operating Model (coverage percentage is primary KPI).

### 11.11 SLA Impact

Coverage percentage is the primary client-facing SLA metric.

### 11.12 Risks

- Stale coverage data (not recalculated promptly)
- Misleading coverage if branches are in UnableToCover status without visibility
- Over-reliance on coverage without considering quality

---

## Domain 12: Report

### 12.1 Business Purpose

The Report domain exists to compile and deliver audit results to clients. Reports are the final deliverable that clients pay for. They transform individual validation cases into a coherent project-level summary.

### 12.2 Business Definition

A report is a compiled document (or set of documents) that presents the results of a completed audit project to the client. It includes per-branch audit findings, validation results, coverage summary, and any exception notes.

### 12.3 Business Owner

- **Department:** Document Management
- **Accountable:** Document Executive (Lead)
- **Maintained by:** Document Executive

### 12.4 Primary Actors

| Action | Role |
|--------|------|
| Compile | Document Executive |
| Verify | Validation Manager |
| Approve | Operations Manager |
| Deliver | Document Executive |
| Receive | Client User |

### 12.5 Lifecycle

| Stage | Description |
|-------|-------------|
| Draft | Being compiled from validated cases |
| Verified | Accuracy confirmed by Validation Manager |
| Approved | Ready for delivery |
| Delivered | Sent to client |
| Acknowledged | Client confirmed receipt |
| Archived | Retention period met |

### 12.6 Business Rules

| Rule ID | Rule | Type |
|---------|------|------|
| BR-R01 | A report can only be compiled after all validation cases are approved | Mandatory |
| BR-R02 | Reports must be verified by Validation Manager before delivery | Mandatory |
| BR-R03 | Reports must be approved by Operations Manager before delivery | Mandatory |
| BR-R04 | Delivered reports are immutable — corrections require a supplement | Mandatory |

### 12.7 Relationships

| Domain | Relationship |
|--------|-------------|
| Project | One-to-one (typically one final report per project) |
| ValidationCase | Aggregation (report summarizes all cases) |
| Document | One-to-many (report may include supporting documents) |

### 12.8 Business Data

- Project reference
- Report generation date
- Delivery date and method
- Client acknowledgment
- Summary statistics (branches in scope, covered, exceptions)
- Per-branch audit results
- Validation outcomes

---

## Domain 13: Payment

### 13.1 Business Purpose

The Payment domain manages compensation to assayers for completed assignments. Timely and accurate payment is essential for assayer retention and satisfaction.

### 13.2 Business Definition

A payment is the financial compensation due to an assayer upon successful completion of an assignment. Payment is based on the agreed fee recorded in the assignment. Payments are processed after the assignment is closed.

### 13.3 Business Owner

- **Department:** Administration & Finance
- **Accountable:** Administrator
- **Maintained by:** Administrator

### 13.4 Lifecycle

| Stage | Description |
|-------|-------------|
| Due | Assignment closed, payment pending |
| Processed | Payment instruction sent to finance/bank |
| Paid | Funds transferred to assayer |
| Disputed | Assayer disputes amount or timing |
| Resolved | Dispute resolved |

### 13.5 Business Rules

| Rule ID | Rule | Type |
|---------|------|------|
| BR-PM01 | Payment is due within 30 days of assignment closure | SLA |
| BR-PM02 | Payment amount must match the agreed fee on the assignment | Mandatory |
| BR-PM03 | Payment cannot be processed without verified bank details | Mandatory |
| BR-PM04 | Disputed payments must be investigated within 5 business days | Conditional |

### 13.6 Relationships

| Domain | Relationship |
|--------|-------------|
| Assignment | One-to-one (one payment per completed assignment) |
| Assayer | Many-to-one (many payments to one assayer) |

---

## Domain 14: Notification

### 14.1 Business Purpose

Notifications keep users informed of important events without requiring them to poll the system. They reduce response time, improve operational efficiency, and prevent SLA breaches.

### 14.2 Business Definition

A notification is an alert delivered to a user about a relevant business event. Notifications may be in-app (visible when using the system) and eventually via email, SMS, or WhatsApp.

### 14.3 Business Owner

- **Department:** Operations
- **Accountable:** Operations Manager

### 14.4 Trigger Events

- Assignment accepted → notify Operations Manager, Assayer
- Schedule confirmed → notify Assayer, Document Executive
- Schedule rescheduled → notify relevant parties
- T-1 dispatch deadline approaching → notify Document Executive
- Coverage below threshold → notify Operations Manager
- Validation overdue → notify Validation Manager
- SLA breach → notify Operations Manager, Administrator

---

## Domain 15: Holiday

### 15.1 Business Purpose

Holidays define dates when audits cannot be scheduled. They are essential for operational planning and scheduling accuracy.

### 15.2 Business Definition

A holiday is a date on which field audits should not be scheduled. Holidays can be national (applicable everywhere), regional (specific states), bank (financial institution holidays), or client-specific (custom dates).

### 15.3 Business Owner

- **Department:** Administration
- **Accountable:** Administrator

### 15.4 Business Rules

| Rule ID | Rule | Type |
|---------|------|------|
| BR-H01 | National holidays apply to all clients and all states | Mandatory |
| BR-H02 | Regional holidays apply to specific states | Mandatory |
| BR-H03 | A schedule must not fall on any applicable holiday | Mandatory |
| BR-H04 | Holiday calendar should be maintained before each project cycle | Conditional |

---

## Domain 16: Zone

### 16.1 Business Purpose

Zones organize branches into geographic groups for operational planning efficiency. They allow operations executives to manage related branches together and optimize assayer travel.

### 16.2 Business Definition

A zone is an operational grouping of branches based on geographic proximity or administrative convenience. Zones are defined per client and may correspond to regions, districts, or custom groupings.

### 16.3 Business Owner

- **Department:** Operations
- **Accountable:** Operations Manager

### 16.4 Relationships

| Domain | Relationship |
|--------|-------------|
| Client | Many-to-one (zones are per-client) |
| ProjectBranch | Many-to-one (branches are assigned to zones within a project) |

---

## Domain 17: User

### 17.1 Business Purpose

Users represent people who interact with the system. They need appropriate access based on their role and responsibilities.

### 17.2 Business Definition

A user is an individual with access to the system. Users are either internal (company employees) or external (client users, assayers — future).

### 17.3 Business Owner

- **Department:** Administration
- **Accountable:** Administrator

### 17.4 Lifecycle

| Stage | Description |
|-------|-------------|
| Invited | Account created, awaiting activation |
| Active | Can access system |
| Suspended | Access temporarily revoked |
| Locked | Too many failed login attempts |
| Disabled | Access permanently revoked |
| Archived | Former user, record retained |

---

## Domain 18: Role

### 18.1 Business Purpose

Roles define what categories of users exist and what they are authorized to do. They implement the principle of least privilege.

### 18.2 Business Definition

A role is a named collection of permissions that represents a job function. Each user is assigned one or more roles.

### 18.3 Roles (from Business Operating Model)

| Role | Department |
|------|------------|
| Super Administrator | Administration |
| Administrator | Administration |
| Operations Manager | Operations |
| Operations Executive | Operations |
| Validation Manager | Quality & Validation |
| Validator | Quality & Validation |
| Document Executive | Document Management |
| Assayer | External Contractor |
| Client User | External (Client) |
| Read-Only Auditor | Compliance |

---

## Domain 19: Permission

### 19.1 Business Purpose

Permissions provide fine-grained control over what actions each role can perform on each type of business object.

### 19.2 Business Definition

A permission is the authorization to perform a specific action (view, create, edit, delete, approve, etc.) on a specific business domain (project, assignment, branch, etc.) within a specific scope (own records, team, region, client, platform).

---

## Domain 20: Configuration

### 20.1 Business Purpose

Configuration allows business rules and operational parameters to be maintained without changing processes or systems.

### 20.2 Business Definition

Configuration is the set of business parameters that control how the company operates. This includes client-specific settings (rate cards, SLAs, working days, import mappings), global settings (default radius, notification templates), and operational thresholds (SLA targets, escalation triggers).

---

## Domain 21: ReferenceData

### 21.1 Business Purpose

Reference data provides the standard lists and hierarchies that ensure consistency across all operations — primarily geographic information (states, districts, cities) used for branch and assayer location validation.

### 21.2 Business Definition

Reference data is the authoritative set of standard values used throughout operations. Geographic reference data (states, districts, cities) is the primary example, ensuring that all branches and assayers can be located and matched.

---

# 3. Domain Relationship Map

## Primary Operational Flow

```
Client (source)
    │
    │  initiates
    ▼
Project (container)
    │
    │  organizes
    ▼
ProjectBranch (scope) ───────── Branch (master record)
    │
    │  may lead to
    ▼
Assignment (commitment) ──────── Assayer (contractor)
    │
    ├── Schedule (date confirmation)
    ├── Communication (interaction log)
    │
    │  generates
    ▼
Document (artifacts)
    │
    │  reviewed in
    ▼
ValidationCase (quality gate)
    │
    │  compiled into
    ▼
Report (deliverable) ─────────── Client (consumer)
```

## Supporting Domains

```
Zone ─────────────> organizes ProjectBranch into groups
Holiday ──────────> constrains Schedule dates
Coverage ─────────> calculated from ProjectBranch statuses
Payment ──────────> settles completed Assignment
Notification ─────> triggered by domain events
Configuration ────> controls business parameters
ReferenceData ────> validates geography (Branch, Assayer)
User/Role/Permission ──> authorizes all operations
```

## Relationship Summary

| Relationship | Type | Business Meaning |
|-------------|------|------------------|
| Client → Project | Strong (one-to-many) | Client owns projects |
| Client → Branch | Strong (one-to-many) | Client owns branches |
| Client → Zone | Weak (one-to-many) | Client may define zones |
| Project → ProjectBranch | Composition (one-to-many) | ProjectBranch exists only within a project |
| Project → Report | Weak (one-to-one) | Project may produce a report |
| Branch → ProjectBranch | Reference (one-to-many) | Branch participates in many projects |
| ProjectBranch → Assignment | Optional (one-to-one) | May have an assignment |
| ProjectBranch → Document | Weak (one-to-many) | Documents reference the branch/project |
| ProjectBranch → ValidationCase | Optional (one-to-one) | Completed audits have validation |
| Assayer → Assignment | Strong (one-to-many) | Assayer takes assignments |
| Assignment → Schedule | Optional (one-to-one) | May have a confirmed date |
| Assignment → Communication | Composition (one-to-many) | Comms exist only for an assignment |
| Assignment → Payment | Optional (one-to-one) | Completed assignments may be paid |

---

# 4. Business Aggregates

## Aggregate 1: Client

| Role | Entity |
|------|--------|
| **Aggregate Root** | Client |
| Owned Entities | ClientConfiguration |
| Referenced Entities | (none) |
| Invariant | Client must be Active before projects can be created |
| Invariant | Client code must be unique |
| Consistency Boundary | All client configuration changes are within this aggregate |

## Aggregate 2: Project

| Role | Entity |
|------|--------|
| **Aggregate Root** | Project |
| Owned Entities | ProjectBranch |
| Referenced Entities | Client (by identity), Zone (by identity) |
| Invariant | Project lifecycle follows defined state sequence |
| Invariant | Cannot enter Execution without all branches assigned or excepted |
| Invariant | Cannot complete without all branches validated |
| Consistency Boundary | Project and its ProjectBranches are updated together |

## Aggregate 3: Branch

| Role | Entity |
|------|--------|
| **Aggregate Root** | Branch |
| Owned Entities | (none — branch is standalone master data) |
| Referenced Entities | Client (by identity) |
| Invariant | Branch code is unique within client |
| Invariant | Branch geography must match reference data |
| Consistency Boundary | Branch data is independently maintained |

## Aggregate 4: Assayer

| Role | Entity |
|------|--------|
| **Aggregate Root** | Assayer |
| Owned Entities | (none — assayer is standalone master data) |
| Referenced Entities | (none) |
| Invariant | Only Active assayers can be offered assignments |
| Invariant | Assayer code must be unique |
| Consistency Boundary | Assayer data is independently maintained |

## Aggregate 5: Assignment

| Role | Entity |
|------|--------|
| **Aggregate Root** | Assignment |
| Owned Entities | Schedule, Communication |
| Referenced Entities | ProjectBranch (by identity), Assayer (by identity) |
| Invariant | Assignment lifecycle follows defined state sequence |
| Invariant | Cannot be Accepted without agreed fee |
| Invariant | Cannot be Scheduled on a holiday |
| Invariant | Assayer cannot have two accepted schedules on same date |
| Consistency Boundary | All assignment state changes, schedule changes, and communication records are within this aggregate |

## Aggregate 6: ValidationCase

| Role | Entity |
|------|--------|
| **Aggregate Root** | ValidationCase |
| Owned Entities | (none — case is self-contained) |
| Referenced Entities | ProjectBranch (by identity), Document (by identity), User/Validator (by identity) |
| Invariant | Validator must not have planned the assignment |
| Invariant | Corrections require re-review |
| Consistency Boundary | Validation case is independently maintained once created |

## Aggregate 7: Document

| Role | Entity |
|------|--------|
| **Aggregate Root** | Document |
| Owned Entities | DocumentVersion |
| Referenced Entities | Project (by identity), Assignment (by identity), ProjectBranch (by identity) |
| Invariant | Documents cannot be deleted |
| Invariant | Dispatch requires accepted assignment |
| Consistency Boundary | Document versions form a chain within this aggregate |

---

# 5. Domain Events Catalog

## Client Events

| Event | Trigger | Consumer | Business Outcome |
|-------|---------|----------|------------------|
| ClientOnboarded | Configuration complete | Operations | Ready to create projects |
| ClientSuspended | Payment/contract issue | Operations | Projects cannot continue |
| ClientReactivated | Issue resolved | Operations | Operations resume |
| ClientDeactivated | Contract ended | Operations, Archive | Data retained for compliance |

## Project Events

| Event | Trigger | Consumer | Business Outcome |
|-------|---------|----------|------------------|
| ProjectCreated | Operations Manager action | Operations | Planning can begin |
| ProjectBranchesLoaded | Branch import | Operations | Branches ready for planning |
| ProjectMovedToPlanning | Lifecycle transition | Operations, Coverage | Planning phase active |
| ProjectMovedToScheduling | Lifecycle transition | Operations, Coverage | Scheduling phase active |
| ProjectMovedToExecution | Lifecycle transition | Operations, Document | Document dispatch window |
| ProjectMovedToValidation | Lifecycle transition | Validation | Validation queue populated |
| ProjectCompleted | All validation done | Operations, Client | Report compilation starts |
| ProjectArchived | Project closed | Archive | Historical record |

## ProjectBranch Events

| Event | Trigger | Consumer | Outcome |
|-------|---------|----------|---------|
| ProjectBranchImported | Branch load | Coverage | Increment total count |
| ProjectBranchPlanned | Status change | Coverage | Track planning progress |
| CandidateSearchStarted | Search initiated | Assignment | Candidate list generated |
| AssayerContacted | Contact logged | Communication | Contact record created |
| NegotiationStarted | Fee discussion | Assignment, Communication | Negotiation in progress |
| AssignmentConfirmed | Assayer accepted | Assignment, Coverage | Increment assigned count |
| AuditScheduled | Date confirmed | Scheduling, Document | Dispatch timer starts |
| AuditCompleted | Documents returned | Coverage | Increment completed count |
| ValidationCompleted | Case approved | Coverage, Validation | Branch ready for reporting |
| BranchClosed | Finalized | Coverage, Project | Branch fully processed |
| BranchUnableToCover | Exception approved | Coverage, Project | Branch formally excepted |

## Assignment Events

| Event | Trigger | Consumer | Outcome |
|-------|---------|----------|---------|
| AssignmentCreated | Candidate identified | Assignment | New assignment record |
| CandidateSelected | Assayer chosen | Assignment, Communication | Contact can begin |
| ContactInitiated | First contact | Communication | Communication log created |
| NegotiationStarted | Fee discussion | Assignment | Fee/date negotiation |
| AssignmentAccepted | Both parties agree | Assignment, Notification | Commitment established |
| AssignmentRejected | Assayer declines | Assignment | Return to candidate search |
| AssignmentScheduled | Date confirmed | Scheduling, Document | Document dispatch timer starts |
| AuditPerformed | Fieldwork done | Assignment | Awaiting document return |
| DocumentsReturned | Completed docs received | Validation | Validation case can be created |
| AssignmentClosed | Finalized | Assignment, Payment | Payment due |
| AssignmentCancelled | Agreement terminated | Assignment | Branch returns to pool |

## Schedule Events

| Event | Trigger | Consumer | Outcome |
|-------|---------|----------|---------|
| ScheduleProposed | Date suggested | Scheduling | Tentative date recorded |
| ScheduleConfirmed | Date agreed | Assignment, Notification | Dispatch deadline set |
| ScheduleRescheduled | Date changed | Scheduling, Notification | New deadline set |
| ScheduleCompleted | Audit performed | Assignment | Schedule fulfilled |

## Document Events

| Event | Trigger | Consumer | Outcome |
|-------|---------|----------|---------|
| DocumentUploaded | File received | Document | Document registered |
| DocumentProcessed | Verification done | Document | Ready for generation |
| DocumentGenerated | PDF created | Document | Ready for dispatch |
| DocumentDispatched | Sent to assayer | Document, Notification | Awaiting receipt |
| DocumentReceived | Delivery confirmed | Document | Assayer has package |
| DocumentReturned | Completed back | Validation | Validation can start |
| DocumentVerified | Completeness check | Document, Validation | Forward to validation |
| DocumentArchived | Retention met | Archive | Long-term storage |

## Validation Events

| Event | Trigger | Consumer | Outcome |
|-------|---------|----------|---------|
| ValidationCaseCreated | Documents returned | Validation, Coverage | Case in queue |
| ValidatorAssigned | Allocation | Validation | Work assigned |
| OCRProcessingStarted | Machine review | Validation | Technology processing |
| HumanReviewStarted | Manual review | Validation | Quality check in progress |
| ValidationApproved | No errors | Validation, Coverage | Branch validated |
| CorrectionRequired | Errors found | Validation | Rework needed |
| ValidationSubmitted | Final approval | Project, Report | Report compilation can start |

## Coverage Events

| Event | Trigger | Consumer | Outcome |
|-------|---------|----------|---------|
| CoverageChanged | Branch status change | Dashboard, Notifications | Display updated |
| CoverageThresholdBreached | Below target | Notifications, Operations Manager | Alert generated |
| CoverageTargetMet | Above target | Notifications, Operations Manager | Positive notification |

---

# 6. Domain Dependencies

## Foundational Domains (Must Exist First)

| Domain | Depended On By | Why |
|--------|---------------|-----|
| ReferenceData | Branch, Assayer | Geography validation |
| Client | Project, Branch, Zone, Configuration | All client operations depend on client records |
| User | All domains | All operations are performed by users |
| Role, Permission | All domains | Authorization depends on roles |
| Configuration | Client, Project, Assignment | Business parameters drive behavior |

## Dependent Domains

| Domain | Depends On | Nature of Dependency |
|--------|-----------|---------------------|
| Project | Client | Project cannot exist without a client |
| Branch | Client, ReferenceData | Branch belongs to a client and has geographic data |
| ProjectBranch | Project, Branch | Exists only as intersection of project and branch |
| Assignment | ProjectBranch, Assayer | Links a branch in a project to an assayer |
| Schedule | Assignment | Exists only for an accepted assignment |
| Communication | Assignment | Logged against a specific assignment |
| Document | Project, Assignment (optional), ProjectBranch | References the operational context |
| ValidationCase | ProjectBranch, Document | Reviews a completed branch audit |
| Report | Project, ValidationCase | Compiles validated results for a project |
| Payment | Assignment, Assayer | Pays for a completed assignment |
| Coverage | ProjectBranch | Calculated from branch statuses |
| Notification | All domains (events) | Triggered by domain events |

## Mutually Independent Domains

| Domain Pair | Why Independent |
|-------------|----------------|
| Branch and Assayer | Branches don't depend on assayers; assayers don't depend on branches. They meet through assignments. |
| Holiday and Project | Holidays exist independently; projects consult them for scheduling. |
| Zone and Assignment | Zones organize branches; assignments use zones only through branches. |

## Reference-Only Relationships

| Domain Pair | Nature |
|-------------|--------|
| ValidationCase → ProjectBranch | References the branch but does not depend on its continued existence |
| Document → Assignment | References the assignment context |
| Payment → Assignment | References the completed assignment |

---

# 7. Boundary Analysis

## Core Domains

| Domain | Why Core |
|--------|----------|
| **Project** | The operational container that defines the company's service delivery. Without projects, there is no work to organize. |
| **ProjectBranch** | The unit of operational tracking. Every branch in every project must be tracked through its lifecycle. |
| **Assignment** | The operational heart of the business. The assignment lifecycle represents the company's primary value-creation process. |
| **ValidationCase** | The quality gate that differentiates the company from uncoordinated audit services. Validation ensures reliable deliverables. |
| **Coverage** | The primary operational metric. Coverage visibility is a key value proposition to clients and management. |

## Supporting Domains

| Domain | Why Supporting |
|--------|----------------|
| **Client** | Essential but well-understood. Client management is standard business practice. |
| **Branch** | Essential master data. Branch management is a prerequisite but not the differentiator. |
| **Assayer** | Essential workforce data. Assayer management is necessary but not the company's unique capability. |
| **Schedule** | Supports assignments with date management. Important but procedural. |
| **Communication** | Supports assignments with interaction logging. Important for audit but not the core value. |
| **Document** | Essential for the document pipeline but the process is well-defined and operational. |
| **Report** | The final deliverable. Important but the value is in the content (from validation), not the report format. |
| **Payment** | Financial settlement. Necessary but entirely standard. |
| **Zone** | Operational convenience. Organizes work but does not drive strategy. |
| **Holiday** | Calendar reference data. Simple and stable. |

## Generic Domains

| Domain | Why Generic |
|--------|-------------|
| **User** | Standard identity and access management pattern |
| **Role** | Standard RBAC pattern |
| **Permission** | Standard authorization pattern |
| **Configuration** | Standard parameter management pattern |
| **ReferenceData** | Standard lookup/list management pattern |
| **Notification** | Standard event-notification pattern |

---

# 8. Consistency Rules (Invariants)

## Organizational Invariants

These rules are always true and must never be violated, regardless of software or process:

| ID | Invariant | Domains Affected | Business Justification |
|----|-----------|------------------|----------------------|
| INV-01 | A branch cannot be in two active projects for the same client simultaneously | Branch, ProjectBranch, Project | A branch cannot be audited twice at the same time |
| INV-02 | An assayer cannot have two accepted or scheduled assignments on the same date | Assayer, Assignment, Schedule | An assayer can only be at one branch per day |
| INV-03 | A validator cannot validate their own planned assignment | ValidationCase, Assignment, User | Separation of duties — prevents conflicts of interest |
| INV-04 | An assignment cannot be scheduled on an applicable holiday | Schedule, Holiday, Assignment | Branches are closed on holidays |
| INV-05 | Once archived, a project and all its data are read-only | Project, ProjectBranch, Assignment, Document, ValidationCase | Business history is immutable |
| INV-06 | A document cannot be dispatched before its assignment is accepted | Document, Assignment | No point sending documents for an unconfirmed audit |
| INV-07 | A completed document cannot be re-dispatched (it must be returned) | Document | Standard document lifecycle integrity |
| INV-08 | A project cannot close with uncompleted assignments or unapproved validation cases | Project, ProjectBranch, ValidationCase | Incomplete projects cannot be finalized |
| INV-09 | An assignment cannot transition to accepted without an agreed fee | Assignment | A commitment requires financial agreement |
| INV-10 | A cancelled or rejected assignment cannot be re-activated | Assignment | Terminal states are final |
| INV-11 | Assignment fees must be within the client's agreed rate card (unless exception approved) | Assignment, Client, Configuration | Contractual pricing integrity |
| INV-12 | Only active assayers may be offered assignments | Assayer, Assignment | Operational readiness |
| INV-13 | A suspended client cannot initiate new projects | Client, Project | Contractual hold |
| INV-14 | All business state transitions must be audited with timestamp, actor, and previous state | All domains | Compliance and traceability |

## Conditional Invariants (Client-Specific or Configurable)

| ID | Invariant | Condition |
|----|-----------|-----------|
| INV-15 | A project cannot enter Execution unless all branches are assigned or exception-documented | Configurable per client |
| INV-16 | Dispatch must occur by T-1 before scheduled audit | Configurable per client |
| INV-17 | Validation must be completed within N days of document receipt | Configurable per client |

---

# 9. Domain Maturity Assessment

## Maturity Scale

| Level | Definition |
|-------|------------|
| 5 - Optimized | Domain is complete, enforced, and measured |
| 4 - Managed | Domain is defined and consistently executed |
| 3 - Defined | Domain is documented but execution varies |
| 2 - Repeatable | Domain exists but is inconsistently applied |
| 1 - Initial | Domain is recognized but not formalized |
| 0 - Missing | Domain is not recognized or practiced |

## Assessment

| Domain | Current Maturity | Target Maturity | Gap |
|--------|-----------------|-----------------|-----|
| Client | 3 (Defined) | 4 (Managed) | Configuration management informal |
| Project | 2 (Repeatable) | 4 (Managed) | Lifecycle enforcement missing |
| Branch | 3 (Defined) | 4 (Managed) | Geocoding process informal |
| ProjectBranch | 1 (Initial) | 4 (Managed) | Lifecycle largely manual |
| Assayer | 3 (Defined) | 4 (Managed) | Performance tracking informal |
| Assignment | 1 (Initial) | 4 (Managed) | Current process bypasses negotiation |
| Schedule | 1 (Initial) | 3 (Defined) | No formal schedule management |
| Communication | 0 (Missing) | 3 (Defined) | No structured communication tracking |
| Document | 1 (Initial) | 4 (Managed) | Document pipeline manual |
| ValidationCase | 0 (Missing) | 4 (Managed) | No formal validation process |
| Coverage | 0 (Missing) | 4 (Managed) | No coverage measurement |
| Report | 1 (Initial) | 3 (Defined) | Report generation ad-hoc |
| Payment | 2 (Repeatable) | 3 (Defined) | Payment tracking informal |
| Notification | 0 (Missing) | 2 (Repeatable) | No notification system |
| Holiday | 2 (Repeatable) | 3 (Defined) | Calendar maintained manually |
| Zone | 2 (Repeatable) | 3 (Defined) | Zone definitions ad-hoc |
| User | 3 (Defined) | 4 (Managed) | Lifecycle management basic |
| Role | 3 (Defined) | 4 (Managed) | Role definitions exist but not fully enforced |
| Permission | 2 (Repeatable) | 4 (Managed) | Permissions defined but not enforced |
| Configuration | 1 (Initial) | 3 (Defined) | No centralized configuration |
| ReferenceData | 3 (Defined) | 3 (Defined) | Adequate for current needs |

## Overall Maturity: **1.7 / 5 (Initial to Repeatable)**

## Missing Domains

| Domain | Priority | Reason |
|--------|----------|--------|
| **ServiceLevelAgreement** | Medium | SLA definitions exist as parameters but not as a formal domain with monitoring and escalation |
| **Escalation** | Medium | Escalation paths exist informally but are not formalized as a domain |
| **ComplianceAudit** | Medium | Compliance requirements exist but no formal audit domain |
| **Training** | Low | Validator and Operations Executive training is not modeled |
| **Feedback** | Low | Client and assayer feedback is not formally captured |

## Overlapping Responsibilities

| Overlap | Risk | Resolution |
|---------|------|------------|
| Document status partially overlaps with validation | Document may be in "returned" state while validation is in "pending" | Clear: Document handles physical file state; ValidationCase handles quality review state |
| Branch address is owned by Branch but also needed by Assignment | Address changes could affect active assignments | Branch address changes should not affect active assignments (snapshot at assignment time) |
| Fee information exists on both Assignment and Payment | Fee may differ if payment adjustments are made | Assignment records agreed fee; Payment records actual fee (should match but may differ with adjustments) |

## Ambiguous Business Concepts

| Concept | Ambiguity | Resolution Needed |
|---------|-----------|-------------------|
| "Assayer availability" | Is it binary (available/busy) or nuanced (available with constraints)? | Define availability model: time-based, location-based, capacity-based |
| "Fee negotiation" | Is it single-round (offer/accept/reject) or multi-round (offer/counter/accept)? | Business Operating Model suggests multi-round |
| "Coverage" | Planned vs Confirmed vs Completed — which is the primary metric? | All three are valid for different audiences. Client sees confirmed. Operations sees all three. |
| "Unable to Cover" | Is this a permanent or temporary status? | Temporary — can re-enter Planning if new assayer becomes available |
| "Report" | Is it one PDF or a collection? Per-branch or per-project? | Per-project compilation of per-branch results |
| "Zone" | Operational vs geographic vs administrative? | Currently all three — needs clarity on zone purpose per client |

## Potential Future Domains

| Domain | Trigger for Introduction |
|--------|------------------------|
| **AssayerNetwork** | When assayer pool exceeds 200 and self-service features are introduced |
| **ClientPortal** | When client self-service features are introduced |
| **MobileAssignment** | When assayer mobile app is developed |
| **Analytics** | When advanced reporting and trend analysis are needed |
| **Invoice** | When billing and invoicing is automated |
| **Contract** | When contract lifecycle management is formalized |
| **QualityScore** | When formal assayer quality scoring is implemented |
| **GeographicRegion** | When multi-state operations require regional management structures |

## Recommended Refinements

1. **Assignment lifecycle must be redesigned** to reflect the full negotiation workflow (current implementation skips from Created to Accepted). This is the highest-priority domain correction.

2. **ProjectBranch status model should be consolidated** to a single canonical set of states. Three different state models currently exist in specifications and code.

3. **Client Configuration should be elevated** to a first-class concern with formal versioning and effective-dating (effective_from / effective_to already exist in the codebase but are not used as a business workflow).

4. **Coverage should be formalized as a calculated domain** with defined trigger events and caching strategy, rather than computed on-demand.

5. **Communication should be promoted** from an informal practice to a mandatory operational procedure with structured logging requirements.

6. **Document and ValidationCase should be explicitly separated** — Document handles file lifecycle; ValidationCase handles quality review lifecycle.

## Questions for Product Owner Clarification

1. **Assayer availability model:** Is availability binary (Active/Busy) or should we support constraints (available on certain days, within certain distances, for certain fee ranges)?

2. **Negotiation workflow depth:** Is negotiation typically single-round (offer, accept/reject) or multi-round with counter-offers? How many rounds are typical?

3. **Fee authority:** Can Operations Executives accept fees up to a certain limit, or must all fees be manager-approved? Is there a defined threshold?

4. **Unable to Cover handling:** When a branch cannot be covered, what is the process? Does the client get a discount? Is there a substitute service?

5. **Report format and content:** Does each client have a preferred report format, or is it standardized? What information must every report contain?

6. **Holiday maintenance:** Who maintains the holiday calendar? How often is it updated? Is there a source of truth (government calendar, client-provided)?

7. **Cross-state assayers:** Can an assayer serve branches in a different state? If so, what distance or travel time limit applies?

8. **Document return method:** How are completed documents returned? Physical courier? Electronic upload? Email? This affects the Document domain's dispatch/receipt model.

9. **Validation depth:** What percentage of documents are fully verified versus spot-checked? Is OCR considered sufficient, or is human review mandatory for every case?

10. **Project overlap:** Can a client have two overlapping projects (e.g., different regions, different audit types)? If so, can a branch appear in both?

---

*End of Business Domain Model*
