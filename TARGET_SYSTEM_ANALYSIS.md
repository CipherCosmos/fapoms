# FAPOMS — Target System Analysis

**Field Audit Planning & Operations Management System**
**Document Type:** Enterprise Architecture Blueprint
**Author:** Principal Architect
**Date:** 2026-07-21
**Status:** Planning — Awaiting Approval

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Business Vision](#2-business-vision)
3. [Business Capability Map](#3-business-capability-map)
4. [Domain Review](#4-domain-review)
5. [Role & Responsibility Matrix](#5-role--responsibility-matrix)
6. [Workflow Review](#6-workflow-review)
7. [Module Evolution Plan](#7-module-evolution-plan)
8. [Database Evolution](#8-database-evolution)
9. [API Evolution](#9-api-evolution)
10. [Frontend Evolution](#10-frontend-evolution)
11. [Enterprise Concerns](#11-enterprise-concerns)
12. [Implementation Roadmap](#12-implementation-roadmap)
13. [Architecture Risks](#13-architecture-risks)
14. [Questions for Product Owner](#14-questions-for-product-owner)

---

# 1. Executive Summary

## What FAPOMS Should Become

FAPOMS should become a **complete enterprise operations platform** that manages the end-to-end lifecycle of field audit operations for banking clients. It will evolve from a data management tool with basic recommendations into a **decision-support and coordination backbone** that centralizes:

- Master data management — Clients, branches, assayers, users, zones
- Project lifecycle — From branch list receipt through planning, scheduling, execution, validation, and reporting
- Assignment lifecycle — From candidate identification through negotiation, scheduling, audit completion, and closure
- Recommendation engine — Multi-factor intelligent assayer matching (proximity, workload, history, specialization)
- Coverage intelligence — Real-time branch coverage visibility at project/zone/state/client level
- Document pipeline — Import, PDF generation, dispatch, receipt, and archive tracking
- Validation coordination — OCR integration + human review workflow
- Communication log — Structured tracking of all assayer interactions (phone, WhatsApp, email)
- Operational dashboards — Role-specific real-time views into workload, coverage, deadlines, and escalations
- Audit and compliance — Immutable append-only audit trail with full history reconstruction

The platform serves operational staff (planners, validators, document executives), management (operations managers, validation managers), field auditors (assayers), external clients (bank users), and compliance/audit stakeholders.

## Architectural Philosophy

- Modular monolith with DDD boundaries — preserved from the current architecture
- API-first — every capability exposed through REST APIs
- Event-driven — state transitions publish domain events that trigger downstream effects
- Configuration-driven — business rules are configurable, not hardcoded
- Immutable history — business history is never rewritten
- Human decision support — the system recommends, humans decide

## Current State Summary

The project is approximately 35% complete. The foundation is solid: auth, RBAC, audit trail, master data CRUD, PostGIS spatial queries, Excel import, and a polished dark-theme frontend shell. What is missing is the core business workflow enforcement (state machines), the full negotiation/scheduling/document/validation pipeline, coverage intelligence, notifications, dashboards, and all production hardening (tests, migrations, CI/CD, Docker).

---

# 2. Business Vision

## Complete Business Scope

FAPOMS manages the operational workflow for a company that provides field audit services to financial institutions. The core business operates as follows:

### The Business Model

A banking client (e.g., SBI, HDFC, ICICI) contracts the FAPOMS-operating company to audit their branch network. Each month (or quarter), the client submits a list of branches requiring audit. The company operations team:

1. Organizes branches into operational zones for planning efficiency
2. Identifies suitable external auditors (Assayers) near each branch
3. Contacts and negotiates with assayers — fees, availability, dates
4. Confirms assignments and schedules audit dates
5. Receives customer master data from the client for each branch
6. Generates and dispatches PDF audit documents to assayers (typically T-1)
7. Tracks field audit execution
8. Manages return of completed documents
9. Coordinates validation: OCR scanning + human review
10. Delivers final audit reports to the client

### Future Business Evolution

The architecture must anticipate:

- Multi-tenant operation — The platform may be licensed to other audit firms
- Multiple clients per organization — Already partially supported
- Multiple audit types — Beyond branch audits (e.g., thematic audits, compliance checks)
- Assayer mobile app — Field assayers managing their assignments, uploading documents, marking completion
- Client self-service portal — Clients submitting branch lists, tracking progress, downloading reports
- Integration ecosystem — PDF generation service, OCR service, email/SMS/WhatsApp gateways, geocoding API
- Internationalization — Multi-language, multi-currency, multi-date-format support

## Target Success Criteria

| Criterion | Target |
|-----------|--------|
| Branch coverage visibility | Real-time, multi-level (project/zone/state/client) |
| Planning cycle time | Reduce from days to hours |
| Assayer recommendation accuracy | >90% acceptance rate on first recommendation |
| Audit trail completeness | Every business state transition recorded, immutable |
| User adoption | Operations team prefers platform over Excel/phone/WhatsApp |
| System availability | 99.5% during business hours |
| Data accuracy | No duplicate branches, no scheduling conflicts, no lost documents |

---

# 3. Business Capability Map

## Legend

| Icon | Meaning |
|------|---------|
| K | Already Implemented (80-100%) |
| P | Partially Implemented (20-80%) |
| M | Missing (0-20%) |
| R | Needs Redesign |
| F | Future Phase (not in V2 scope) |

### 3.1 Core Infrastructure

| Capability | Status | Notes |
|-----------|--------|-------|
| Authentication (JWT + refresh) | K | Production-ready. Preserve as-is. |
| RBAC Authorization | K | Preserve. Add @Roles to missing controllers. |
| ABAC Authorization | P | PermissionsGuard exists but unused. Wire into controllers. |
| Audit Trail | K | Append-only, global, works. Preserve. |
| Soft Delete | K | Consistent across all entities. Preserve. |
| Optimistic Locking | K | Version column present. Preserve. |
| Database Migrations | M | Must replace synchronize=true with proper migrations. |
| Docker + Compose | M | Must add for local development parity. |
| CI/CD Pipeline | M | Must add for automated testing and deployment. |
| Testing Framework | M | Zero tests exist — must build from scratch. |

### 3.2 Master Data Management

| Capability | Status | Notes |
|-----------|--------|-------|
| User Management | K | CRUD + roles + audit. No frontend. |
| Client Management | K | CRUD + per-client config + audit. No frontend. |
| Branch Management | P | CRUD + Excel import + PostGIS. Missing update/delete. |
| Assayer Management | P | CRUD + PostGIS + status. Missing frontend. |
| Holiday Calendar | P | CRUD + date check + state-aware. Missing update. |
| Zone Management | K | CRUD + per-client scoping. No frontend. |
| Geo Reference Data | P | Entities exist. No CRUD APIs. No frontend. |
| Configuration Management | M | No global configuration system. |

### 3.3 Core Business Operations

| Capability | Status | Notes |
|-----------|--------|-------|
| Project Lifecycle | P | Create + list only. No state transitions. |
| Project Branch Import | P | Via Excel, but no add-to-project workflow. |
| Candidate Recommendation | P | PostGIS proximity only. Missing scoring factors. |
| Assignment Negotiation | R | Currently auto-accepts. Needs full negotiation. |
| Assignment Lifecycle | M | Reject, cancel, complete, close all missing. |
| Scheduling | M | No Schedule entity. No calendar view. |
| Communication Tracking | M | No phone/WhatsApp/email logging. |
| Document Management | M | No file upload, versioning, dispatch. |
| Coverage Analysis | M | No coverage service. Client-side only. |
| Validation Coordination | M | No validation queue or OCR integration. |
| Dashboard & Analytics | M | Frontend dashboard is entirely mock data. |
| Report Generation | M | No report generation capability. |

### 3.4 Cross-Cutting Capabilities

| Capability | Status | Notes |
|-----------|--------|-------|
| Notification Service | M | No in-app, email, or WhatsApp notifications. |
| Background Job Processing | M | No Bull/BullMQ. Imports run synchronously. |
| Event Bus / Domain Events | M | State machines defined but no event system. |
| Global Search | M | No cross-entity search. |
| Bulk Operations | M | Contracts defined but never implemented. |
| File Storage | M | Config exists but no FileStorageService. |
| Export / Data Download | M | CSV export button does nothing. |
| Audit Trail UI | M | Events recorded but never displayed. |

### 3.5 Future Capabilities

| Capability | Phase |
|-----------|-------|
| Assayer Mobile App | Future |
| Client Self-Service Portal | Future |
| Multi-Tenant Organization Support | Future |
| PDF Generation Service Integration | Future |
| OCR Service Integration | Future |
| Email / SMS / WhatsApp Gateway | Future |
| Internationalization (i18n) | Future |
| Geocoding API Integration | Future |

---

# 4. Domain Review

## 4.1 Existing Domain Assessment

### Auth Domain
**Assessment:** CORRECT — Keep as-is
**Rationale:** JWT + refresh token rotation + account lockout is production-grade. Only gap: PermissionsGuard is defined but never wired.

### User Domain
**Assessment:** CORRECT — Keep as-is
**Rationale:** User, role, permission entities, M2M relationships, RBAC guards — all correctly modeled.

### Client Domain
**Assessment:** CORRECT — Keep as-is
**Rationale:** Client entity with per-client JSONB configuration is the right approach. String resolver for circular refs is acceptable.

### Branch Domain
**Assessment:** CORRECT — Minor improvements
**Rationale:** PostGIS Point, geography validation, per-client ownership — all correct. Missing update/delete endpoints.

### Assayer Domain
**Assessment:** CORRECT — Keep as-is
**Rationale:** PostGIS location, banking details, status management — all correct.

### Project Domain
**Assessment:** NEEDS EVOLUTION
**Gaps:** Status defaults to PLANNING (should be DRAFT). No lifecycle enforcement. No update/archive. ProjectBranch has no independent management.

### Assignment Domain
**Assessment:** NEEDS REDESIGN
**Critical gap:** Service bypasses entire negotiation workflow. Creates directly in ACCEPTED status. The state machine defines 10 statuses — only 1 is used.

### Planning Domain
**Assessment:** CORRECT — Needs extension
**Missing:** Multi-factor scoring, configurable radius, batch pre-computation.

### Holiday Domain
**Assessment:** CORRECT — Keep as-is
**Rationale:** NATIONAL/REGIONAL/BANK/CUSTOM types, state-aware checking — complete.

### Zone Domain
**Assessment:** CORRECT — Keep as-is
**Minor gap:** No duplicate name validation.

### Geo Domain
**Assessment:** CORRECT — Needs extension
**Missing:** CRUD APIs. Standalone GeoModule for import by other modules.

## 4.2 New Domains Required

| Domain | Entity | Module | Priority | Why Needed |
|--------|--------|--------|----------|------------|
| Schedule | ScheduleEntity | scheduling | High | Tracks confirmed dates, supports rescheduling, holiday-aware |
| Communication | CommunicationEntity | communication | High | Tracks phone/WhatsApp/email interactions per assignment |
| Document | DocumentEntity | document | High | Lifecycle tracking: upload, dispatch, receipt, archive |
| ValidationCase | ValidationCaseEntity | validation | High | OCR + human review workflow, quality tracking |
| Coverage | (calculated) | coverage | Medium | Multi-tier coverage at project/zone/state/client levels |
| Notification | NotificationEntity | notification | Medium | In-app notifications, templates, subscriptions |
| Analytics | (aggregated) | analytics | Medium | Dashboards, trends, utilization metrics |
| Workflow | (orchestration) | workflow | Medium | Multi-step workflow coordination, SLA enforcement |

---

# 5. Role & Responsibility Matrix

## 5.1 Complete Role Model

| Role | Responsibility | Key Permissions | Workspace |
|------|---------------|-----------------|-----------|
| Super Administrator | Platform config, org management | All actions, all resources | Admin |
| Administrator | Operational config, user management | Full CRUD on master data | Admin, Master Data |
| Operations Manager | Planning strategy, coverage monitoring | Project CRUD, assignment approve, coverage view | Planning, Dashboard |
| Operations Executive | Day-to-day execution, contact assayers | View master data, manage assignments, log comms | Planning, Assignments |
| Validation Manager | Validation workflow, quality monitoring | Assign validators, approve/reject reviews | Validation |
| Validator | OCR review, manual corrections | View assigned cases, submit review | Validation |
| Document Executive | Import, generate PDFs, dispatch | Upload, generate, dispatch, track documents | Documents |
| Assayer | View work, submit completed docs | View own assignments, update status | Assayer Portal |
| Client User | Track projects, download reports | View own client data, download reports | Client Portal |
| Read-Only Auditor | Compliance, audit history | View all data, access audit logs | Audit |

## 5.2 Permission Model Evolution

The current `resource:action:scope` model is **correct**. Required changes:

1. Wire PermissionsGuard into all 10 controllers (currently only RolesGuard is used)
2. Create permission seed data for all 10 roles (currently only 4 have permissions)
3. Add frontend permission-based rendering (sidebar, buttons, pages)
4. Add ABAC rule evaluation (attribute-based conditions)

---

# 6. Workflow Review

## 6.1 Existing Workflow Assessment

| Workflow | Status | Assessment |
|----------|--------|------------|
| User Login | Complete | Production-ready. No changes. |
| User Logout | Complete | Production-ready. No changes. |
| Create User | Backend only | Frontend missing. |
| Create Client | Backend only | Frontend missing. |
| Create Branch | Partial | Missing update/delete. Frontend list exists. |
| Import Branches (Excel) | Partial | Synchronous — should be async job. |
| Create Assayer | Backend only | Frontend missing. |
| Create Holiday | Backend only | Frontend missing. |
| Create Zone | Backend only | Frontend missing. |
| Create Project | Partial | Missing update/delete/archive. |
| Candidate Recommendation | Partial | Distance-only. Needs multi-factor scoring. |
| Create Assignment | INCORRECT | Skips negotiation. Auto-accepts. |

## 6.2 Workflows Needing Correction

### Assignment Lifecycle
**Current:** CREATED to ACCEPTED (directly)
**Target:** CREATED to CANDIDATE_SELECTED to CONTACT_INITIATED to NEGOTIATION to ACCEPTED to SCHEDULED to AUDIT_COMPLETED to CLOSED
**Impact:** AssignmentService.create must be redesigned. Frontend negotiation modal must pass through states.

### Project Lifecycle
**Current:** No lifecycle enforcement. Status defaults to PLANNING.
**Target:** DRAFT to PLANNING to SCHEDULING to EXECUTION to VALIDATION to COMPLETED to ARCHIVED
**Impact:** ProjectService needs state machine enforcement. Transition endpoints needed.

## 6.3 Missing Workflows

### Scheduling Workflow
Assignment ACCEPTED to Propose dates to Check holiday/availability/double-booking to Confirm date to Create Schedule record. Conflict resolution for overlapping dates.

### Communication Logging Workflow
Initiate contact to Record attempt (phone/WhatsApp/email) to Log outcome (reached/not reached) to Record notes to Log against Assignment.

### Document Pipeline Workflow
Client uploads data to Trigger PDF generation to Dispatch to Assayer (T-1) to Track receipt to Mark return to Forward to Validation.

### Validation Workflow
Documents received to Create validation cases to Assign to validators to OCR processing to Human review to Corrections loop to Approval to Closure.

### Coverage Calculation Workflow
Assignment state change triggers recalculation at project level, rolls up to zone/state/client. Results cached and pushed via WebSocket.

### Notification Workflow
State transitions trigger notifications: assignment confirmed, schedule set, T-1 deadline, document overdue, SLA breach.

### Bulk Operations Workflow
Bulk update status, bulk reschedule, bulk zone assignment. Per-record audit trail.

---

# 7. Module Evolution Plan

## 7.1 Existing Module Decisions

| Module | Decision | Rationale |
|--------|----------|-----------|
| AuthModule | KEEP | Production-grade |
| UserModule | KEEP | Correctly modeled. Add frontend. |
| AuditModule | KEEP | Global, immutable, perfect. |
| ClientModule | KEEP | Correct. Add frontend. |
| BranchModule | EXTEND | Add update/delete. Move geo validation to GeoModule. |
| AssayerModule | KEEP | Correct. Add frontend. |
| HolidayModule | KEEP | Correct. Add update + frontend. |
| ZoneModule | KEEP | Add duplicate name check. Add frontend. |
| PlanningModule | EXTEND | Multi-factor scoring, configurable radius. |
| ProjectModule | EXTEND | State machine, update/archive, branch management. |
| AssignmentModule | REDESIGN | Full negotiation workflow. |
| GeoModule | SPLIT | Extract standalone module from BranchModule. |

## 7.2 New Modules

| Module | Priority | Dependencies | Key Capabilities |
|--------|----------|-------------|------------------|
| Scheduling | High | Assignment, Holiday | Schedule CRUD, conflict detection, rescheduling |
| Communication | High | Assignment | Communication CRUD, multi-channel, interaction history |
| Document | High | Project, Assignment, FileStorage | CRUD, versioning, status lifecycle, dispatch |
| Validation | High | Document, Project | Case creation, OCR interface, review workflow |
| Coverage | Medium | Project, Assignment | Multi-level calculation, caching, real-time push |
| Notification | Medium | Core (event bus) | In-app notifications, templates, subscriptions |
| Analytics | Medium | All modules | Aggregated metrics, trend data, dashboards |
| Workflow | Medium | Core | Orchestration, state enforcement, SLA tracking |
| FileStorage | High | Core (infrastructure) | Filesystem abstraction, cloud-ready |
| ConfigService | Medium | Core (infrastructure) | Global key-value config, typed schemas |

## 7.3 Target Module Dependency Map

```
                    Core (Auth, Audit, Config, Events, Base)
                            |
         +------------------+------------------+
         |                  |                  |
    Master Data          Geo Module       File Storage
    (Client, Branch,     (State/Dist/     (Local/Cloud
     Assayer, Zone,       City CRUD)       abstraction)
     Holiday, User)
         |                  |
         +------------------+
         |
    +---------+---------+---------+---------+
    |         |         |         |         |
  Project  Planning  Assignment  Holiday  Scheduling
    |         |         |    |        |        |
    +---------+---------+    |        +--------+
              |              |
         Communication    Schedule
              |              |
              +-------+------+
                      |
                  Document
                      |
                Validation
                      |
              Coverage/Analytics
                      |
             Notification/Workflow
```

---

# 8. Database Evolution

## 8.1 Existing Schema Assessment

**Verdict:** The existing 19-table schema is a solid foundation. Approximately 60% of the target schema exists.

**Preserve without changes:** users, roles, permissions, refresh_tokens, audit_events, geo_states, geo_districts, geo_cities

**Minor changes needed:** clients, client_configurations, branches, assayers, zones, holidays

**Needs evolution:** projects (status default), project_branches (relationship refinement), assignments (full lifecycle support)

## 8.2 New Tables Required

| Table | Module | Key Columns | Purpose |
|-------|--------|-------------|---------|
| schedules | scheduling | assignment_id (FK), scheduled_date, status, rescheduled_from_id, remarks, confirmed_by | Audit date tracking with rescheduling support |
| communications | communication | assignment_id (FK), type, direction, subject, notes, contacted_at, contacted_by, outcome, next_steps | Interaction logging per assignment |
| documents | document | project_branch_id (FK nullable), project_id (FK nullable), type, status, file_name, file_path, file_size, mime_type, version_number, parent_document_id (FK self), dispatched_at, received_at | Full document lifecycle |
| validation_cases | validation | project_branch_id (FK), document_id (FK), status, assigned_to (FK user), ocr_result (JSONB), review_notes, corrections (JSONB), approved_by, approved_at | OCR + human review |
| notifications | notification | user_id (FK), type, title, body, is_read, read_at, entity_type, entity_id, metadata (JSONB) | In-app notification records |
| coverage_snapshots | coverage | project_id (FK), zone_id (FK nullable), client_id (FK), total_branches, assigned_branches, scheduled_branches, completed_branches, calculated_at | Materialized coverage metrics |
| configuration | config (infra) | key, value (JSONB), type, description, is_system, effective_from, effective_to | Global configuration store |
| background_jobs | core | job_type, status, payload (JSONB), progress, result (JSONB), error, started_at, completed_at | Job tracking |

## 8.3 Missing Relationships

| Relationship | Current | Target |
|-------------|---------|--------|
| Branch to Geo | String fields (state, district, city) | FK to geo tables (optional, for referential integrity) |
| ProjectBranch to Schedule | No link | FK to schedules table |
| Assignment to Schedule | scheduled_date column | OneToOne to Schedule entity |
| Assignment to Communications | No link | OneToMany to communications |
| ProjectBranch to Documents | No link | OneToMany to documents |
| ProjectBranch to ValidationCase | No link | OneToOne to validation_cases |
| User to Notifications | No link | OneToMany to notifications |

## 8.4 Migration Strategy

1. Convert from `synchronize: true` to TypeORM migrations
2. Generate initial migration from current entities
3. Add new tables via new migrations
4. Never use destructive migrations in shared environments

---

# 9. API Evolution

## 9.1 Existing API Assessment

**Verdict:** The 36 existing endpoints are well-structured. 58% have RBAC. Key gaps:

1. Project, Assignment, Planning controllers have NO @Roles — must add RBAC
2. Branch module missing PUT and DELETE endpoints
3. Holiday module missing PUT endpoint
4. Geo reference data has zero CRUD endpoints
5. 25 of 36 endpoints (69%) are never called from the frontend

## 9.2 New APIs Required

| Module | New Endpoints | Purpose |
|--------|--------------|---------|
| Branch | PUT /branches/:id, DELETE /branches/:id | Complete branch CRUD |
| Holiday | PUT /holidays/:id | Complete holiday CRUD |
| Project | PUT /projects/:id, DELETE /projects/:id, POST /projects/:id/transition | Full project lifecycle |
| Assignment | PUT /assignments/:id/status, PUT /assignments/:id/cancel, POST /assignments/:id/negotiate, PUT /assignments/:id/fee | Full assignment lifecycle |
| Geo | GET /geo/states, GET /geo/states/:id/districts, GET /geo/districts/:id/cities | Geography reference |
| Scheduling | POST /schedules, GET /schedules, PUT /schedules/:id, GET /schedules/conflicts | Schedule management |
| Communication | POST /communications, GET /communications, GET /communications/assignment/:id | Communication tracking |
| Document | POST /documents, GET /documents, PUT /documents/:id/status, PUT /documents/:id/version | Document management |
| Validation | POST /validation-cases, GET /validation-cases, PUT /validation-cases/:id | Validation workflow |
| Coverage | GET /coverage/project/:id, GET /coverage/client/:id | Coverage metrics |
| Notifications | GET /notifications, PUT /notifications/:id/read | In-app notifications |

## 9.3 API Versioning Strategy

**Current:** `/api/v1/...` (URI path versioning)
**Target:** Continue with URI path versioning. When breaking changes are needed, increment to `/api/v2/...`

## 9.4 API Contract Improvements

1. Standardize pagination metadata across all list endpoints (hasNext/hasPrevious must be universal)
2. Standardize error response format (code, message, details, traceId — already partially done)
3. Add OpenAPI/Swagger documentation for all new endpoints
4. Add rate limiting headers to all public endpoints

---

# 10. Frontend Evolution

## 10.1 Required Workspaces

| Workspace | Routes | Role Access | Priority | Current State |
|-----------|--------|-------------|----------|---------------|
| Login | /login | All | High | 90% done |
| Dashboard | /dashboard | All | High | 5% (mock) |
| Projects | /projects, /projects/:id | Ops + Admin | High | 40% |
| Branches | /branches | Ops + Admin | High | 50% |
| Assayers | /assayers | Ops + Admin | High | Not started |
| Planning Workspace | /planning | Ops | High | 40% |
| Assignments | /assignments, /assignments/:id | Ops | High | Placeholder |
| Scheduling | /scheduling | Ops | High | Placeholder |
| Documents | /documents | Doc Exec | High | Placeholder |
| Validation | /validation | Validators | High | Placeholder |
| Reports | /reports | Ops + Admin | Medium | Placeholder |
| Admin: Users | /admin/users | Super Admin, Admin | Medium | Not started |
| Admin: Clients | /admin/clients | Admin | Medium | Not started |
| Admin: Zones/Holidays | /admin/settings | Admin | Medium | Not started |
| Admin: Config | /admin/config | Super Admin | Low | Not started |
| Audit Log | /audit | Super Admin, Auditor | Low | Not started |

## 10.2 Navigation Evolution (Target)

```
Dashboard
├── Overview (/)
├── Projects (/projects)
├── Branches (/branches)
├── Assayers (/assayers)
Operations
├── Assignment Planning (/planning)
├── Assignments (/assignments)
├── Scheduling (/scheduling)
├── Documents (/documents)
Quality
├── Validation (/validation)
├── Reports (/reports)
Admin
├── Users (/admin/users)
├── Clients (/admin/clients)
├── Settings (/admin/settings)
├── Audit Log (/audit)
```

## 10.3 Frontend Technical Evolution

| Concern | Current | Target |
|---------|---------|--------|
| State Management | Raw useState/useEffect | TanStack Query (already configured but unused) |
| API Client | Dual mock/live with fetch | Remove all mock fallbacks. Use proper error handling. |
| Auth State | localStorage token | Use React Context for auth state, role/permission checks |
| Permission UI | None | Sidebar/button visibility based on user permissions |
| Error Boundaries | None | Add ErrorBoundary per workspace |
| Loading States | Basic "Loading..." | Skeleton screens, proper Suspense |
| Routing | Inline in App.tsx | Separate router config file |
| Forms | Raw controlled inputs | React Hook Form |
| WebSocket | None | Real-time coverage, notifications |
| Lazy Loading | None | Per-route code splitting |

---

# 11. Enterprise Concerns

## 11.1 Security

| Concern | Current State | Target |
|---------|--------------|--------|
| JWT Secret | Hardcoded and committed | Environment variable only, rotated regularly |
| Password Hashing | bcrypt (inconsistent: 10 vs 12 rounds) | Standardize on 12 rounds |
| Rate Limiting | Not implemented | Per-user and per-IP rate limiting on auth endpoints |
| CORS | Basic (FRONTEND_URL) | Whitelist maintained in config |
| SQL Injection | TypeORM parameterized | Verified by removing any raw query usage (PlanningService has raw SQL) |
| File Upload Security | No validation | File type, size, and scan validation |
| Audit Trail | Append-only | Add database-level protections (triggers, restricted roles) |
| Secrets in Code | .env committed | Remove from VCS, use secrets manager |

## 11.2 Scalability

| Concern | Current | Target |
|---------|---------|--------|
| Architecture | Modular monolith | Modular monolith (preserve) |
| Database | Single instance | Read replicas for analytics queries |
| Background Jobs | Synchronous | Bull/BullMQ with Redis |
| File Storage | Local disk | Abstracted (local -> S3/GCS) |
| Search | PostgreSQL LIKE | PostgreSQL full-text (Tier 1), Elasticsearch (Tier 2) |
| Caching | None | Redis for reference data, materialized views for coverage |
| Horizontal Scaling | Stateless API | Containerized, load-balanced |
| Database Connection Pool | Max 20 | Monitor and adjust based on load |

## 11.3 Performance

| Concern | Target |
|---------|--------|
| List pages | <500ms p95 |
| Search | <1s p95 |
| Recommendation | <3s p95 |
| Coverage calculation | Async, cached, <5s |
| Excel import (10k rows) | Background job, <30s |
| Dashboard load | <2s p95 |

## 11.4 Maintainability

| Concern | Current | Target |
|---------|---------|--------|
| Tests | Zero | Unit tests for all services, integration for workflows |
| Code Organization | Clean modular structure | Preserve and extend pattern |
| Shared Package | 60% unused | Audit and remove unused exports |
| TypeORM Entities vs Shared Interfaces | Duplicated | Keep entities as ORM-sourced truth (shared interfaces are aspirational references) |
| Inconsistent Patterns | 3 identified | Standardize: pagination, error handling, audit format |
| Documentation | Swagger for existing APIs | Maintain for all endpoints |

## 11.5 Configuration

| Requirement | Solution |
|------------|----------|
| Per-client settings | JSONB on client_configurations (existing — keep) |
| Global system config | New configuration table with key-value + JSONB |
| SLA rules | Configurable per-client (JSONB slot exists) |
| Fee structure | New fee_configuration table or JSONB per client |
| Notification templates | JSONB configuration |
| Workflow rules | Configurable state transition rules |
| Distance thresholds | Per-client defaultRadius (exists) + configurable |

## 11.6 Multi-tenancy

The architecture already anticipates multi-tenancy via:
- organization_id columns ready on relevant tables
- Authorization scopes include ORGANIZATION level
- Client configuration is per-client

**Not yet needed for V2** but the design must not preclude it.

## 11.7 Observability

| Concern | Current | Target |
|---------|---------|--------|
| Structured Logging | Console only | JSON-structured logging with correlation IDs |
| Health Checks | /auth/status only | /health (DB, Redis, FileStorage status) |
| Metrics | None | Request rate, latency, error rate, business metrics |
| Audit Events | 100% | Preserve and extend to all new modules |
| Error Tracking | None | Integration with Sentry or similar |

## 11.8 Background Jobs

| Job | Trigger | Priority | Target Implementation |
|-----|---------|----------|----------------------|
| Branch Excel Import | User upload | High | Bull queue with progress reporting |
| Coverage Recalculation | Assignment state change | High | Async event-driven |
| Candidate Pre-computation | On-demand + schedule | Medium | Batch nearest-assayer computation |
| PDF Generation | Assignment scheduled | High | External service integration via queue |
| Report Generation | On-demand | Medium | Bull queue |
| Schedule Reminder | Cron (daily) | Medium | Bull repeatable job |
| Analytics Aggregation | Cron (nightly) | Low | Bull repeatable job |

## 11.9 Eventing

**Target:** In-process domain event bus with persisted event log.

Every state transition publishes a domain event. Subscribers handle:
- Coverage recalculation
- Notification dispatch
- Analytics aggregation
- Audit recording (already done)

The event bus can be replaced with an external broker (RabbitMQ/Kafka) when scaling requires it, without changing event producers.

## 11.10 Notifications

**V1:** In-app notifications via WebSocket push to connected clients + persistent notification records.
**V2:** Email gateway integration.
**V3:** SMS/WhatsApp Business API integration.

Notification templates are configuration-driven with support for dynamic field substitution.

---

# 12. Implementation Roadmap

## Phase 1: Foundation Hardening (Current + 4 weeks)

**Objective:** Close critical infrastructure gaps before adding new features.

| Item | Effort | Dependencies |
|------|--------|-------------|
| Add database migrations (replace synchronize=true) | 2 days | — |
| Add Docker + docker-compose (Postgres + PostGIS + Redis) | 2 days | — |
| Add CI/CD pipeline (lint, test, build) | 2 days | — |
| Add Jest configuration, write unit tests for existing services | 2 weeks | All existing modules |
| Add RBAC to Project, Assignment, Planning controllers | 1 day | — |
| Add PUT/DELETE for Branch, PUT for Holiday | 1 day | — |
| Create GeoModule with CRUD, extract from BranchModule | 2 days | — |
| Standardize pagination metadata across all list endpoints | 1 day | — |
| Remove .env from VCS, move to env vars | 1 day | — |
| Standardize bcrypt rounds to 12 | 0.5 day | — |

**Deliverable:** Production-hardened foundation. All existing modules fully tested and correctly RBAC-guarded.

## Phase 2: Core Workflow Enforcement (4 weeks)

**Objective:** Wire the state machines that drive business workflows.

| Item | Effort | Dependencies |
|------|--------|-------------|
| Refactor ProjectService with state machine enforcement | 3 days | Phase 1 |
| Add project transition endpoints (POST /projects/:id/transition) | 2 days | Above |
| Refactor AssignmentService with full negotiation workflow | 5 days | Phase 1 |
| Add assignment transition endpoints | 3 days | Above |
| Add frontend negotiation workflow (multi-step modal) | 5 days | Above |
| Add frontend project detail page with lifecycle controls | 3 days | Above |
| Wire state machine validator from @fapoms/shared into services | 2 days | — |
| Fix PlanningModule to import BranchModule/AssayerModule (not direct repos) | 1 day | Phase 1 |

**Deliverable:** Project and assignment lifecycles are enforced by state machines. Frontend supports full negotiation workflow.

## Phase 3: Scheduling + Communication (3 weeks)

**Objective:** Add operational scheduling and communication tracking.

| Item | Effort | Dependencies |
|------|--------|-------------|
| Create Schedule entity, service, controller | 3 days | Phase 2 |
| Add holiday-aware conflict detection | 2 days | Above |
| Add scheduling UI (calendar view) | 5 days | Above |
| Create Communication entity, service, controller | 2 days | Phase 2 |
| Add communication log UI per assignment | 3 days | Above |
| Add assayer availability model | 2 days | Phase 2 |
| Add basic in-app notification service | 3 days | Above |

**Deliverable:** Assignments can be scheduled with conflict detection. All interactions with assayers are logged.

## Phase 4: Document Management (3 weeks)

**Objective:** Full document lifecycle tracking.

| Item | Effort | Dependencies |
|------|--------|-------------|
| Create FileStorageService (local implementation) | 2 days | — |
| Create Document entity, service, controller | 3 days | Above |
| Add document upload UI | 2 days | Above |
| Add document dispatch/receipt tracking | 2 days | Above |
| Add document versioning | 2 days | Above |
| Add document status lifecycle enforcement | 2 days | Above |
| Add PDF generation integration contract (interface only) | 1 day | — |
| Wire document flow into project/assignment workflows | 2 days | Phase 2, 3 |

**Deliverable:** Documents flow through upload, dispatch, receipt, and archive. Integration points defined for external PDF generation.

## Phase 5: Validation Pipeline (3 weeks)

**Objective:** Post-audit validation coordination.

| Item | Effort | Dependencies |
|------|--------|-------------|
| Create ValidationCase entity, service, controller | 3 days | Phase 4 |
| Add validation queue management | 2 days | Above |
| Add validator assignment workflow | 2 days | Above |
| Add human review UI (review, approve, correct) | 5 days | Above |
| Add OCR integration contract (interface only) | 1 day | — |
| Add validation-to-report completion flow | 2 days | Above |
| Wire validation events to notifications | 1 day | Above |

**Deliverable:** Validation cases are created from received documents, assigned to validators, processed through OCR+review, and completed.

## Phase 6: Coverage + Analytics (3 weeks)

**Objective:** Operational dashboards and real-time coverage.

| Item | Effort | Dependencies |
|------|--------|-------------|
| Create CoverageService with multi-level calculation | 3 days | Phase 2, 3 |
| Add materialized view for coverage snapshots | 2 days | Above |
| Add coverage API endpoints | 1 day | Above |
| Add coverage UI widgets (gauges, charts) | 3 days | Above |
| Create AnalyticsService for trend data | 3 days | All phases |
| Replace mock dashboard with real data | 3 days | Above |
| Add WebSocket for real-time updates | 2 days | Above |
| Add report generation (CSV, basic PDF) | 3 days | Above |

**Deliverable:** Dashboards show real operational data. Coverage is visible at all levels. Reports can be generated.

## Phase 7: Optimization + Polish (3 weeks)

**Objective:** Performance, UX, and production readiness.

| Item | Effort | Dependencies |
|------|--------|-------------|
| Add Redis caching layer for reference data | 2 days | Phase 1 |
| Add background job queue (Bull/BullMQ) | 3 days | — |
| Migrate Excel import to async job | 2 days | Above |
| Add global search (PostgreSQL full-text) | 3 days | All phases |
| Add bulk operations endpoints | 3 days | Phase 2 |
| Add frontend error boundaries, loading skeletons | 2 days | — |
| Add role-based UI rendering | 2 days | Phase 1 |
| Add export functionality to all list pages | 2 days | — |
| Performance testing with realistic data volumes | 3 days | All phases |
| Security audit and penetration testing | 3 days | All phases |
| User acceptance testing preparation | 2 days | All phases |

**Deliverable:** Production-ready application with caching, async processing, search, and polished UX.

## Phase 8: Future (Beyond V2)

| Item | Timeline |
|------|----------|
| Assayer mobile app | Future |
| Client self-service portal | Future |
| Multi-tenant organization support | Future |
| Email/SMS/WhatsApp gateway integration | Future |
| PDF generation external service integration | Future |
| OCR external service integration | Future |
| Geocoding API integration | Future |
| Internationalization (i18n) | Future |

---

# 13. Architecture Risks

## 13.1 Critical Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| **State machine complexity** — 6+ entities with interconnected transition rules become error-prone | High | Medium | Use a state machine library (XState), comprehensive unit tests per transition |
| **Concurrent planning conflicts** — Two planners assign same assayer simultaneously | High | Medium | Optimistic locking + WebSocket-based real-time awareness |
| **Excel import at scale** — 10k+ rows blocking the API | High | Medium | Move to background job with progress reporting in Phase 1 |
| **Integration dependency on external services** — PDF gen and OCR are outside our control | Medium | High | Define integration contracts as abstract interfaces with circuit breakers |
| **Adoption risk** — Ops team prefers existing Excel/phone workflow | Critical | High | Invest in UX early, involve users in design, ensure system is demonstrably faster |

## 13.2 Architectural Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Module boundary erosion** — Without discipline, modules import each other's entities directly | High | Enforce module import rules in CI, code review for cross-module boundaries |
| **Monolith growth** — 20+ modules in a single deployable may become unwieldy | Medium | Modular boundaries enable future extraction. Monitor compile time. |
| **Event sourcing confusion** — Audit trail might be mistaken for event store | Medium | Clear documentation: audit trail is a log, not the source of truth |
| **Performance of raw PostGIS queries** — ST_DistanceSphere on every recommendation request | Medium | Pre-compute nearest assayers, cache results, add spatial indexes |
| **Synchronize=true in production** — Schema auto-sync could cause data loss | Critical | Phase 1 priority: replace with migrations |

## 13.3 Business Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Recommendation quality poor** — If suggestions are wrong, trust erodes | High | Start simple (distance only), iterate based on feedback, make recommendations transparent |
| **Data completeness** — System value depends on accurate branch locations | High | Validation on import, geocoding integration, progressive data enrichment |
| **Scope creep** — Downstream modules consume development capacity | Medium | Strict V2 scope boundaries, integration contracts only |
| **Team knowledge** — Single developer familiarity with codebase | Medium | Documentation, comprehensive tests, pair programming |

---

# 14. Questions for Product Owner

## 14.1 Business Process Questions

1. **What is the typical volume?** How many branches per project? How many projects concurrently? How many assayers? This drives performance targets and infrastructure sizing.

2. **What is the SLA for each workflow step?** For example: "Branches must be assigned within 3 days of project creation" or "PDFs must be dispatched by T-1 5pm." These drive notification triggers and escalation rules.

3. **What is the fee negotiation model?** Is there a standard rate card? Can assayers counter-offer? Are there travel allowances? Fee caps? The negotiation workflow design depends on this.

4. **What happens when a branch cannot be covered?** Does the client get notified? Is there a backup assayer list? Does the project proceed without that branch?

5. **How are completed documents returned?** Physically? Uploaded? Via email? The document receipt workflow depends on this.

## 14.2 Authorization Questions

6. **Should Operations Executives be able to accept assignments or only Operations Managers?** The current permission matrix suggests OPS_EXEC can negotiate but OPS_MGR must accept. Confirm this.

7. **Should the Assayer role eventually have write access to mark assignments complete and upload documents?** Or is this always mediated by Operations?

## 14.3 Integration Questions

8. **Is there an existing PDF generation system?** What format does it require? What triggers it?

9. **Is there an existing OCR system?** What format does it output? How is accuracy measured?

10. **Is the client branch list delivered as Excel only?** Or also CSV, JSON, API? This determines the import pipeline design.

## 14.4 Operational Questions

11. **Is the application expected to replace WhatsApp/phone entirely?** Or should it supplement them? This determines whether communication needs to be real-time.

12. **Should the application enforce business hours?** For example, should scheduling prevent audits on Sundays or public holidays beyond the holiday calendar?

13. **Are there any regulatory or compliance standards** (e.g., ISO, banking regulations) that impose specific audit trail or data retention requirements?

14. **What is the expected user count?** Concurrent users? This determines infrastructure sizing and licensing costs.

## 14.5 Technical Direction Questions

15. **Do you have a preferred deployment target?** Cloud provider? On-premise? This determines the Docker/K8s strategy.

16. **Is there a budget for third-party services?** Geocoding (Google Maps/Mapbox), OCR, PDF generation, SMS/WhatsApp gateways — some require paid subscriptions.

---

*End of Target System Analysis*
