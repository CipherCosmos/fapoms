# PROJECT_CONTEXT_RECONSTRUCTION.md

# FAPOMS — Complete Project Context Reconstruction

**Field Audit Planning & Operations Management System**  
**Document Type:** Session Recovery & Context Reconstruction  
**Date:** 2026-07-21  
**Authority Level:** High — Derived strictly from approved workspace specifications, [PROJECT_CONSTITUTION.md](file:///Users/deepstacker/WorkSpace/dupcq/gssAutomation/PROJECT_CONSTITUTION.md), and [GOVERNANCE_PROTOCOL.md](file:///Users/deepstacker/WorkSpace/dupcq/gssAutomation/GOVERNANCE_PROTOCOL.md)  

---

## 1. Executive Summary

This document establishes the reconstructed context for the **Field Audit Planning & Operations Management System (FAPOMS)** following a session recovery. 

FAPOMS is a specialized operations management platform designed for a company ("The Company") providing physical field audit services to banking and financial clients (e.g., SBI, HDFC, ICICI) (*Source: BUSINESS_OPERATING_MODEL.md §1*). The platform digitizes, optimizes, and coordinates the complete lifecycle of field audit operations — from branch list receipt and project setup through candidate recommendation, fee/date negotiation, scheduling, document generation/dispatch, post-audit return, OCR + human validation, and final report delivery (*Source: TARGET_SYSTEM_ANALYSIS.md §1*).

FAPOMS is not designed to automate field auditors ("Assayers") or replace human operational judgment; it acts as a decision-support and coordination backbone that empowers the Operations, Validation, Document, and Management teams (*Source: PROJECT_CONSTITUTION.md §Primary Goal, TARGET_SYSTEM_ANALYSIS.md §1*).

---

## 2. Business Objective

The primary business objectives governing FAPOMS are:

1. **Maximize Branch Audit Coverage:** Ensure that every branch submitted by a banking client is assigned and audited (*Source: BUSINESS_OPERATING_MODEL.md §2*).
2. **Minimize Operational & Coordination Costs:** Optimize travel distances, eliminate administrative overhead, and streamline assayer coordination (*Source: BUSINESS_OPERATING_MODEL.md §2*).
3. **Reduce Planning Cycle Time:** Compress the duration from branch list receipt to assignment confirmation (*Source: BUSINESS_OPERATING_MODEL.md §2*).
4. **Standardize Operational Workflows:** Centralize operations into a single platform, replacing fragmented Excel spreadsheets, phone calls, and undocumented WhatsApp interactions (*Source: BUSINESS_OPERATING_MODEL.md §2*).
5. **Provide Complete Operational Visibility:** Offer real-time, role-specific visibility into coverage metrics, assignment lifecycles, pending validations, and SLA compliance (*Source: BUSINESS_OPERATING_MODEL.md §2*).
6. **Ensure Regulatory & Compliance Rigor:** Preserve an immutable, append-only business audit trail and enforce strict separation of duties across departments (*Source: BUSINESS_OPERATING_MODEL.md §20*).

---

## 3. Product Vision

FAPOMS is designed to evolve into a multi-client, configuration-driven, multi-tenant capable enterprise operations platform (*Source: specification/01_Product_Vision.md §12*).

* **Human Decision Support:** Recommendations (distance, workload, history) assist operational decision-making; final authority always rests with authorized human users (*Source: specification/01_Product_Vision.md §10*).
* **Modular Monolith & DDD:** Built using Domain-Driven Design principles with clear bounded contexts (*Source: implementatin_plan.md §4.1*).
* **API-First & Configuration-Driven:** All core capabilities are exposed via REST APIs. Client-specific rules are stored as configuration, requiring no code modifications for new client onboarding (*Source: PROJECT_CONSTITUTION.md §Configuration over Hardcoding, implementatin_plan.md §4.1*).
* **Immutable History:** Business history is never overwritten or physically deleted. Soft deletes, explicit state machines, versioning, and append-only audit events maintain a complete chain of custody (*Source: PROJECT_CONSTITUTION.md §History is Immutable, specification/02_Domain_Model.md §18*).

---

## 4. Current System Status

Based on the thorough implementation audit (`CURRENT_IMPLEMENTATION_SPECIFICATION.md`):

* **Overall System Readiness:** **~27–35% Complete** (*Source: CURRENT_IMPLEMENTATION_SPECIFICATION.md §12.1*).
* **Repository Architecture:** Monorepo using `npm workspaces` with `@fapoms/shared`, `@fapoms/backend` (NestJS 11 + TypeORM + PostgreSQL/PostGIS), and `@fapoms/frontend` (React 19 + Vite 6) (*Source: CURRENT_IMPLEMENTATION_SPECIFICATION.md §1.2*).
* **Database & Schema:** 19 database tables created via TypeORM (`synchronize: true`). Includes PostGIS spatial indexing (`GEOMETRY(Point, 4326)`) on `branches` and `assayers` (*Source: CURRENT_IMPLEMENTATION_SPECIFICATION.md §5.1*).
* **Backend Capabilities (36 Endpoints across 10 Modules):**
  * **Complete (100%):** Authentication, User Management CRUD, Client Management CRUD & per-client JSONB configuration, Zone Management CRUD, Audit Service (*Source: CURRENT_IMPLEMENTATION_SPECIFICATION.md §2.1*).
  * **Partial (70–90%):** Branch Management (missing PUT/DELETE), Assayer Management (missing update status endpoint), Holiday Management (missing update endpoint), Candidate Recommendation Engine (PostGIS distance queries functional, but missing multi-factor scoring) (*Source: CURRENT_IMPLEMENTATION_SPECIFICATION.md §2.1*).
  * **Incomplete (30–40%):** Project Management (create + list only), Assignment Management (create + list only, currently skips negotiation states and creates as ACCEPTED directly) (*Source: CURRENT_IMPLEMENTATION_SPECIFICATION.md §2.1*).
  * **Missing (0%):** Scheduling module, Communication module, Document management, Validation coordination queue/OCR interface, Coverage analysis service, Notifications, Analytics engine (*Source: CURRENT_IMPLEMENTATION_SPECIFICATION.md §2.2*).
* **Frontend Capabilities (13 files):** Polished dark-theme SPA shell, functional Login page, Projects page (CRUD), Branches page (list + Excel upload), and 2-panel PlanningWorkspace. Dashboard page uses 100% mock data (*Source: CURRENT_IMPLEMENTATION_SPECIFICATION.md §3.2*).

---

## 5. Approved Business Decisions

1. **Client Independence:** Each banking client's operational rules, import mappings, and SLAs are isolated and configuration-driven (*Source: BUSINESS_OPERATING_MODEL.md §11, BUSINESS_DOMAIN_MODEL.md §Domain 1*).
2. **Permanent Master Data vs. Temporary Transactions:** Branches and Assayers are permanent master entities shared across projects. A `ProjectBranch` represents a specific branch's temporary participation in a single project (*Source: specification/02_Domain_Model.md §18*).
3. **Assignment Commitment Lock:** Once an assignment is ACCEPTED, it becomes operationally locked. Reassignment is prohibited without explicit cancellation (*Source: specification/02_Domain_Model.md §8*).
4. **Advisory Recommendation Engine:** The recommendation engine suggests candidate assayers based on proximity, workload, and history; it never automatically assigns work (*Source: specification/01_Product_Vision.md §10*).
5. **No Physical Deletion:** Business entities follow a soft-delete policy (`isActive` flag or lifecycle archiving/cancellation) (*Source: PROJECT_CONSTITUTION.md §Data Principles, BUSINESS_DOMAIN_MODEL.md §Domain 9*).
6. **Separation of Duties:** Operational planning and quality validation are independent. A validator cannot validate an assignment they helped plan (*Source: BUSINESS_OPERATING_MODEL.md §11 BR-V02*).
7. **Document Dispatch Timing:** PDF audit packages must be generated and dispatched to assayers by T-1 (one day prior to the scheduled audit date) (*Source: BUSINESS_OPERATING_MODEL.md §10 SOP 3*).

---

## 6. Approved Architectural Decisions

1. **Architecture Pattern:** Modular Monolith using Domain-Driven Design (DDD) boundaries (*Source: implementatin_plan.md §4.1*).
2. **Data Layer Technology:** PostgreSQL with PostGIS extension for spatial queries (SRID 4326, `ST_DistanceSphere`) (*Source: implementatin_plan.md §4.7*).
3. **Backend Stack:** Node.js with NestJS 11, TypeORM 0.3, Passport JWT, and class-validator (*Source: CURRENT_IMPLEMENTATION_SPECIFICATION.md §1.3*).
4. **Frontend Stack:** React 19 SPA with Vite 6, React Router DOM 7, Lucide React icons, and Vanilla CSS custom properties (*Source: CURRENT_IMPLEMENTATION_SPECIFICATION.md §1.3*).
5. **Shared Layer:** `@fapoms/shared` package containing canonical enums, interfaces, API contracts, and state machine transition maps (*Source: CURRENT_IMPLEMENTATION_SPECIFICATION.md §1.2*).
6. **Authentication & Authorization:** JWT with short-lived access tokens (15 min) and long-lived refresh tokens (7 days) in database (*Source: CURRENT_IMPLEMENTATION_SPECIFICATION.md §1.4*).
7. **Auditability:** Global `AuditService` writing structured, append-only audit events (`audit_events` table with JSONB metadata) for every state mutation (*Source: CURRENT_IMPLEMENTATION_SPECIFICATION.md §2.1.3*).
8. **File Storage Abstraction:** Abstract `FileStorageService` interface allowing seamless transition from local disk storage to S3/GCS (*Source: implementatin_plan.md §4.11*).

---

## 7. Approved Domain Model

The canonical domain model comprises 21 recognized domains across 7 key aggregates (*Source: BUSINESS_DOMAIN_MODEL.md §1*):

* **Client Aggregate:** Client, ClientConfiguration (*Source: BUSINESS_DOMAIN_MODEL.md §4*).
* **Project Aggregate:** Project, ProjectBranch (*Source: BUSINESS_DOMAIN_MODEL.md §4*).
* **Branch Aggregate:** Branch (*Source: BUSINESS_DOMAIN_MODEL.md §4*).
* **Assayer Aggregate:** Assayer (*Source: BUSINESS_DOMAIN_MODEL.md §4*).
* **Assignment Aggregate:** Assignment, Schedule, Communication (*Source: BUSINESS_DOMAIN_MODEL.md §4*).
* **ValidationCase Aggregate:** ValidationCase (*Source: BUSINESS_DOMAIN_MODEL.md §4*).
* **Document Aggregate:** Document, DocumentVersion (*Source: BUSINESS_DOMAIN_MODEL.md §4*).

---

## 8. Approved Business Rules

### Branch Rules
* **BR-B01:** Every branch must belong to exactly one client (*Source: BUSINESS_OPERATING_MODEL.md §11*).
* **BR-B02:** Branch code is unique within a client network (*Source: BUSINESS_OPERATING_MODEL.md §11*).
* **BR-B03:** A branch cannot appear in two active projects simultaneously (*Source: BUSINESS_OPERATING_MODEL.md §11*).
* **BR-B04:** Address, state, district, and city are mandatory for every branch (*Source: BUSINESS_OPERATING_MODEL.md §11*).
* **BR-B05:** Geographic reference data (State → District → City) must be validated (*Source: BUSINESS_OPERATING_MODEL.md §11*).

### Assignment & Scheduling Rules
* **BR-A01:** An assayer can have only one assignment per branch per project (*Source: BUSINESS_OPERATING_MODEL.md §11*).
* **BR-A02:** An assayer cannot be double-booked on the same date (*Source: BUSINESS_OPERATING_MODEL.md §11*).
* **BR-A03:** Assignments cannot be scheduled on national, regional, or bank holidays (*Source: BUSINESS_OPERATING_MODEL.md §11*).
* **BR-A04:** Only ACTIVE assayers can receive assignment offers (*Source: BUSINESS_OPERATING_MODEL.md §11*).
* **BR-A05:** Accepted assignments are locked; reassignment requires explicit cancellation (*Source: BUSINESS_OPERATING_MODEL.md §11*).
* **BR-A06:** Assignment fees must align with agreed client rate cards (*Source: BUSINESS_OPERATING_MODEL.md §11*).

### Project & Validation Rules
* **BR-P01:** Project lifecycle follows strictly: `Draft` → `Planning` → `Scheduling` → `Execution` → `Validation` → `Completed` → `Archived` (*Source: BUSINESS_DOMAIN_MODEL.md §Domain 2*).
* **BR-P02:** Execution phase cannot begin until all branches are assigned or formally excepted (*Source: BUSINESS_DOMAIN_MODEL.md §Domain 2*).
* **BR-V01:** Every completed field audit must undergo validation (*Source: BUSINESS_OPERATING_MODEL.md §11*).
* **BR-V02:** Separation of duties: a validator cannot review assignments they helped plan (*Source: BUSINESS_OPERATING_MODEL.md §11*).

---

## 9. Outstanding Design Questions

The specifications identify several design ambiguities:

1. **State Machine Granularity Mismatch (A1 / P1):**
   * *Conflict:* `02_Domain_Model.md` vs `04_Operational_Workflow.md` vs `06_State_Event_Model.md` vs `BUSINESS_DOMAIN_MODEL.md` vs implementation code present slightly different naming/granularity for Project and ProjectBranch lifecycles.
   * *Impact:* Ambiguous transition definitions in implementation.
   * *Status:* **Pending Product Owner Decision**
2. **Assayer Geographic Scope (A5):**
   * *Conflict:* `02_Domain_Model.md` states assayers live in one primary state; `09_Assignment_Planning.md` mentions service areas. It is unclear if an assayer can serve across state lines.
   * *Impact:* Proximity recommendation calculations are blockaded.
   * *Status:* **Pending Product Owner Decision**
3. **Coverage Definition Tiers (A3):**
   * *Conflict:* `04_Operational_Workflow.md` defines coverage as "Confirmed Assignments ÷ Total Project Branches" while `09_Assignment_Planning.md` lists multiple tiers of coverage metrics (Planned, Scheduled, Uncovered).
   * *Impact:* Inconsistent dashboard metrics.
   * *Status:* **Pending Product Owner Decision**
4. **Zone Scoping (A4):**
   * *Conflict:* `02_Domain_Model.md` vs `03_Functional_Modules.md` do not specify if zones are per-client or global.
   * *Impact:* Impact on how configurations organize master branch records.
   * *Status:* **Pending Product Owner Decision**
5. **Schedule Entity Relationship (A2):**
   * *Conflict:* `02_Domain_Model.md` §7 says "One Schedule belongs to One Project, One Branch, One Assayer." `07_Canonical_Data_Model.md` §5 says Schedule is owned by Assignment.
   * *Impact:* Database mapping constraints are blocked.
   * *Status:* **Pending Product Owner Decision**

---

## 10. Known Risks

1. **State Machine Complexity Risk:** Enforcing interconnected state transitions across 6+ entities without proper state machine engines can lead to inconsistent database states (*Source: TARGET_SYSTEM_ANALYSIS.md §13.1*).
2. **Excel Import Scalability:** Synchronous processing of large Excel files (10k+ rows) will block backend threads; must move to asynchronous background queues (*Source: TARGET_SYSTEM_ANALYSIS.md §13.1*).
3. **Concurrency Conflicts:** Multiple Operations Executives planning the same project concurrently could attempt to book the same Assayer on the same date (*Source: TARGET_SYSTEM_ANALYSIS.md §13.1*).
4. **Adoption Risk:** Operations staff returning to manual Excel/phone workflows if the platform UX is slow or unhelpful (*Source: TARGET_SYSTEM_ANALYSIS.md §13.1*).
5. **Technical Hardening Gaps:** Lack of database migration scripts (`synchronize: true`) and total absence of unit/integration tests pose deployment risks (*Source: CURRENT_IMPLEMENTATION_SPECIFICATION.md §10.6*).

---

## 11. Planned Next Phase

According to the target roadmap (`TARGET_SYSTEM_ANALYSIS.md` & `implementatin_plan.md`), the project will proceed in structured phases:

* **Phase 1: Foundation Hardening**
  1. Replace TypeORM `synchronize: true` with database migration scripts.
  2. Implement Docker containerization.
  3. Establish CI/CD pipeline configuration and write Jest tests.
  4. Enforce RBAC `@Roles()` guards across Project, Assignment, and Planning controllers.
  5. Add missing Branch (PUT/DELETE) and Holiday (PUT) CRUD endpoints.
  6. Standardize pagination metadata format.
  7. Extract standalone `GeoModule` from `BranchModule`.

---

## 12. Assumptions

No assumptions are made outside the explicitly defined scope of the approved documents (*Source: PROJECT_CONSTITUTION.md §Authority*).

---

## 13. Inconsistencies Discovered Between Documents

During analysis of the approved workspace documents, the following conflicts were identified:

1. **Project Initial Status**
   * *Source A:* `06_State_Event_Model.md` (Lifecycle lists initial state as `Draft`).
   * *Source B:* `projects.entity.ts` / `CURRENT_IMPLEMENTATION_SPECIFICATION.md` (Implementation defaults status to `PLANNING`).
   * *Impact:* Mismatch in DB entity defaults vs. business state transitions.
   * *Status:* **Pending Product Owner Decision**

2. **Assignment Lifecycle Execution**
   * *Source A:* `06_State_Event_Model.md` (Defines lifecycle as `Created` -> `Candidate Selected` -> `Contact Initiated` -> `Negotiation` -> `Accepted` -> `Scheduled` -> `Audit Completed` -> `Closed`).
   * *Source B:* `assignment.service.ts` / `CURRENT_IMPLEMENTATION_SPECIFICATION.md` (Auto-creates assignments directly in `ACCEPTED` status).
   * *Impact:* Complete bypass of negotiation lifecycle states in code.
   * *Status:* **Pending Product Owner Decision**

3. **Password Hashing rounds**
   * *Source A:* `user.service.ts` (Uses 12 rounds).
   * *Source B:* `auth.service.ts` (Uses 10 rounds).
   * *Impact:* Discrepancy in password hashing parameters.
   * *Status:* **Pending Product Owner Decision**

4. **Pagination Metadata**
   * *Source A:* User, Client, Branch, Assayer, Zone controllers (Return `hasNext`/`hasPrevious` fields).
   * *Source B:* Project and Assignment controllers (Return offset-based fields without `hasNext`/`hasPrevious`).
   * *Impact:* Inconsistent API contract response structure.
   * *Status:* **Pending Product Owner Decision**

5. **Local Storage Key Name**
   * *Source A:* `api.ts` (References header-based auth token extraction).
   * *Source B:* `App.tsx` (Reads `'fapoms_token'`).
   * *Impact:* Mismatch in auth local storage lookup.
   * *Status:* **Pending Product Owner Decision**

---

## CONTEXT VALIDATION

I confirm I have reconstructed the project context and will treat the approved documents as authoritative for all future work unless explicitly instructed otherwise.
