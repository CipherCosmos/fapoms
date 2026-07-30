# FAPOMS — Full System Analysis

## Project Structure

```
/Users/deepstacker/WorkSpace/dupcq/gssAutomation/
├── .github/workflows/ci.yml
├── docker-compose.yml          # postgres (PostGIS), redis, backend, frontend, mobile
├── docker/
├── docs/
├── evidence/
├── k6/scripts/load-test.js
├── packages/
│   ├── backend/      # NestJS API server (port 3000)
│   ├── frontend/     # Vite + React web admin panel (port 5173)
│   ├── mobile/       # Expo React Native assayer app (port 8081)
│   ├── shared/       # Enums, interfaces, state machines
│   └── uploads/
├── playwright.config.ts
├── scripts/sql/
├── tests/e2e/
└── package.json
```

---

## Backend Modules (26 modules)

### 2.1 Auth Module
**Routes:**
| Method | Path |
|--------|------|
| GET | /api/v1/auth/status |
| POST | /api/v1/auth/login |
| POST | /api/v1/auth/biometric-login |
| POST | /api/v1/auth/refresh |
| POST | /api/v1/auth/logout |

**Entities:** RefreshTokenEntity (refresh_tokens)

### 2.2 User Module
**Routes:**
| Method | Path |
|--------|------|
| GET | /api/v1/users/me |
| POST | /api/v1/users |
| GET | /api/v1/users |
| GET | /api/v1/users/roles |
| GET | /api/v1/users/:id |
| PUT | /api/v1/users/:id |
| PUT | /api/v1/users/:id/roles |

**System Dashboard:** GET /api/v1/system-dashboard/metrics

**Entities:** UserEntity, RoleEntity, PermissionEntity, ResponsibilityEntity, CapabilityEntity + junction tables

### 2.3 Organization Module
| POST | /api/v1/organizations |
| GET | /api/v1/organizations |
| GET | /api/v1/organizations/:id |
| PUT | /api/v1/organizations/:id |
| DELETE | /api/v1/organizations/:id |

### 2.4 Client Module
| POST/GET | /api/v1/clients |
| GET/PUT/DELETE | /api/v1/clients/:id |
| PATCH | /api/v1/clients/:id/lifecycle |
| CRUD | /api/v1/clients/:id/contacts |
| CRUD | /api/v1/clients/:id/contracts |
| GET/PUT | /api/v1/clients/:id/billing |

**Entities:** ClientEntity, ClientContactEntity, ClientContractEntity, ClientBillingEntity, ClientConfigurationEntity

### 2.5 Branch Module
| CRUD | /api/v1/branches |
| CRUD | /api/v1/branches/:id/contacts |
| CRUD | /api/v1/branches/:id/documents |
| POST | /api/v1/branches/import/:clientId |

**Entities:** BranchEntity (with operatingHours jsonb, geometry location), BranchContactEntity, BranchDocumentEntity

### 2.6 Project Module
| CRUD | /api/v1/projects |
| GET/POST/DELETE | /api/v1/projects/:id/branches |
| POST | /api/v1/projects/:id/branches/upload |
| GET | /api/v1/projects/:id/branches/template |

**Entities:** ProjectEntity, ProjectBranchEntity (status, priority, zoneId, scheduledDate, packetCount)

### 2.7 Assayer Module
**Entities:** AssayerEntity (extensive), AssayerDocumentEntity, AssayerGovernmentDocumentEntity, AssayerRemarkEntity, AssayerActivityEntity, AssayerCommercialProfileEntity (baseFee, hourlyRate, dailyRate, travelReimbursement, accommodationAllowance, mealAllowance), WorkforceAttributeEntity (SKILL/CERTIFICATION/LANGUAGE)

### 2.8 Assignment Module
**Routes:**
| GET | /api/v1/assignments/assayer/:assayerId |
| POST | /api/v1/assignments/:id/check-in |
| POST | /api/v1/assignments |
| GET | /api/v1/assignments |
| GET | /api/v1/assignments/dashboard/summary |
| GET | /api/v1/assignments/:id |
| PUT | /api/v1/assignments/:id |
| POST | /api/v1/assignments/:id/transition |
| GET | /api/v1/assignments/:id/timeline |
| POST | /api/v1/assignments/:id/comments |

**Entities:** AssignmentEntity (assignmentNumber, projectBranchId, projectId, assayerId, status, proposedFee, agreedFee, scheduledDate, slaDueDate, slaStatus, executionGroupId...), AssignmentCommentEntity

### 2.9 Scheduling Module
| POST | /api/v1/schedules |
| GET | /api/v1/schedules |
| GET | /api/v1/schedules/:id |
| POST | /api/v1/schedules/:id/transition |
| GET | /api/v1/schedules/assayer-workload |
| GET | /api/v1/schedules/:id/timeline |

**Entities:** ScheduleEntity (assignmentId, projectId, assayerId, scheduledDate, status: TENTATIVE/CONFIRMED/RESCHEDULED/COMPLETED)

### 2.10 Document Module
| POST | /api/v1/documents/upload |
| POST | /api/v1/documents/mobile-upload |
| POST | /api/v1/documents/validate-customer-excel |
| GET | /api/v1/documents/:id |
| GET | /api/v1/documents/:id/download |
| PATCH | /api/v1/documents/:id/status |
| GET | /api/v1/documents/project-branch/:projectBranchId |

**Entities:** DocumentEntity (type: BRANCH_LIST/CUSTOMER_MASTER_DATA/GENERATED_PDF/RETURNED_AUDIT_PDF/GENERATED_EXCEL/FINAL_REPORT, status: UPLOADED/PROCESSED/GENERATED/DISPATCHED/RECEIVED/ARCHIVED)

### 2.11 Validation Module
| POST | /api/v1/validation |
| GET | /api/v1/validation |
| GET | /api/v1/validation/:id |
| POST | /api/v1/validation/:id/assign |
| POST | /api/v1/validation/:id/transition |

**Entities:** ValidationCaseEntity (status: PENDING/ASSIGNED/OCR_PROCESSING/HUMAN_REVIEW/CORRECTION_REQUIRED/APPROVED/SUBMITTED)

### 2.12 Validation Query Module
| POST | /api/v1/validation-queries |
| POST | /api/v1/validation-queries/:id/respond |
| POST | /api/v1/validation-queries/:id/resolve |
| GET | /api/v1/validation-queries/validation-case/:validationCaseId |
| GET | /api/v1/validation-queries/assayer/:assayerId |

**Entities:** ValidationQueryEntity (status: OPEN/RESPONDED/RESOLVED)

### 2.13 Customer Master Module
| POST | /api/v1/customer-master/upload |
| POST | /api/v1/customer-master/versions/:versionId/approve |
| GET | /api/v1/customer-master/projects/:projectId/versions |
| GET | /api/v1/customer-master/versions/:versionId/records |

**Entities:** CustomerMasterVersionEntity (status: DRAFT/RECONCILED/APPROVED/SUPERSEDED/REJECTED), CustomerRecordEntity (branchId, accountNumber, customerName, packetCount, declaredWeightGrams)

### 2.14 Communication Module
| POST | /api/v1/communications |
| GET | /api/v1/communications/assignment/:assignmentId |

**Entities:** CommunicationEntity (type: PHONE/WHATSAPP/EMAIL/SYSTEM)

### 2.15 Holiday Module
| CRUD | /api/v1/holidays |
| GET | /api/v1/holidays/check |

**Entities:** HolidayEntity

### 2.16 Zone Module
| CRUD | /api/v1/zones |

**Entities:** ZoneEntity (name, states[], districts[])

### 2.17 Geo Module
| GET | /api/v1/geo/states |
| GET | /api/v1/geo/states/:stateId/districts |
| GET | /api/v1/geo/districts/:districtId/cities |
| POST | /api/v1/geo/route/optimize |

### 2.18 Search Module — GET /api/v1/search?q=

### 2.19 Planning Module (Operations Planning)
**Routes — Field Visits:**
| POST | /api/v1/planning/field/visits |
| PUT | /api/v1/planning/field/visits/:visitId/status |
| POST | /api/v1/planning/field/visits/:visitId/incidents |
| PUT | /api/v1/planning/field/incidents/:incidentId/resolve |
| GET | /api/v1/planning/field/visits/:visitId/handover |
| GET | /api/v1/planning/field/dashboards/:coveragePlanId |

**Routes — Execution:**
| POST | /api/v1/planning/execution/packages |
| POST | /api/v1/planning/execution/packages/:groupId/conversations |
| GET | /api/v1/planning/execution/packages/:groupId/readiness |

**Routes — Control Center:**
| GET | /api/v1/planning/control-center/dashboard |
| POST | /api/v1/planning/control-center/tasks |
| PUT | /api/v1/planning/control-center/tasks/:taskId/resolve |
| POST | /api/v1/planning/control-center/exceptions |
| PUT | /api/v1/planning/control-center/exceptions/:exceptionId/resolve |

**Routes — Coverage:**
| GET | /api/v1/planning/projects/:projectId/coverage |
| GET | /api/v1/planning/projects/:projectId/coverage-plan |
| POST | /api/v1/planning/projects/:projectId/coverage-plan |
| PUT | /api/v1/planning/coverage-plans/:planId/transition |
| POST | /api/v1/planning/coverage-plans/:planId/execute |
| GET | /api/v1/planning/projects/:projectId/candidates |
| POST | /api/v1/planning/projects/:projectId/optimize |
| POST | /api/v1/planning/scenarios/simulate |
| GET | /api/v1/planning/recommendations |
| GET | /api/v1/planning/projects/:projectId/day-plans |

**Routes — Rules:**
| CRUD | /api/v1/planning/rules |

**Entities:**
- CoveragePlanEntity (status: DRAFT/GENERATED/UNDER_REVIEW/APPROVED/LOCKED/DEPLOYED/ARCHIVED)
- CoveragePlanVersionEntity (planData jsonb, overrides jsonb)
- OperationsExecutionGroupEntity (assayerId, status: DRAFT/DISPATCHED/ACCEPTED/DECLINED/CONFIRMED/READY/COMPLETED/CANCELLED, totalFee, logisticsPreferences)
- OperationsTaskEntity
- OperationsExceptionEntity (category: UNCOVERABLE_BRANCH/CAPACITY_EXCEEDED/SCHEDULE_CONFLICT/COMMERCIAL_DISCREPANCY/CERTIFICATION_EXPIRED/ROUTE_UNREACHABLE)
- OperationsExecutionConversationEntity (sender: OPERATIONS/ASSAYER/SYSTEM, proposedFeeOverride, proposedDateOverride)
- FieldVisitEntity (status: READY/DISPATCHED/TRAVELLING/ARRIVED/AUDIT_STARTED/EVIDENCE_COLLECTION/AUDIT_COMPLETED/DELIVERABLE_PREPARATION/SUBMITTED/HANDOVER_READY)
- FieldIncidentEntity

### 2.20 Billing Module
| POST | /api/v1/billing |
| GET | /api/v1/billing/assayer/:assayerId |

**Entities:** BillingRecord (assayer_billing_records): baseFee, travelAllowance, penalties, gst, tds, netPayable

### 2.21 Ledger Module
| POST | /api/v1/ledger |
| GET | /api/v1/ledger/assayer/:assayerId |

**Entities:** LedgerEntry (assayer_financial_ledger): CREDIT/DEBIT, runningBalance

### 2.22 Audit Module
| POST | /api/v1/audits/start |
| POST | /api/v1/audits/:id/close |

**Entities:** AuditEntity

### 2.23 Audit History Module
**Entities:** AuditHistoryRecord, AuditEvidence (gpsCoordinates jsonb, ocrResult jsonb)

### 2.24 Notifications Module
| GET | /api/v1/notifications |
| POST | /api/v1/notifications/:id/read |
| POST | /api/v1/notifications/device-token |
| POST | /api/v1/notifications/device-token/unregister |

**Entities:** DeviceTokenEntity

### 2.25 Realtime Module (Socket.IO /events)
**Events:** assignment:status-changed, assignment:created, assignment:fee-updated, schedule:created, schedule:updated, notification:new, comment:added, query:raised, query:responded, document:uploaded, document:status-changed, communication:created, billing:created, branch:* client:* org:* user:* assayer:* project:* audit:* holiday:* zone:*

### 2.26 Platform Module
**Entities:** BusinessRuleEntity, WorkflowHistoryEntity, AuditLogEntity
**Services:** RuleEngine, WorkflowEngine, AuthorizationService, ConfigurationService, EventDispatcherService, ObservabilityService, QueueManagerService, TenantResolverService

---

## Infrastructure

### OCR Pipeline
Bull queue `ocr`, worker `ocr.worker.ts`, controller `ocr-boundary`
| POST | /api/v1/ocr-boundary/jobs (create) |
| POST | /api/v1/ocr-boundary/jobs/:id/results (callback) |
| GET | /api/v1/ocr-boundary/jobs/:id |
| POST | /api/v1/ocr-boundary/jobs/:id/retry |

**Entities:** OcrJobEntity (status: PENDING/PROCESSING/COMPLETED/FAILED/DEAD_LETTER)

### Storage
StorageEngine interface → LocalStorageService | S3StorageService

### Notifications / FCM
PushProvider interface → FcmProvider (firebase-admin)

### Scheduler
SlaScannerWorker (Bull queue `sla-scanner`)

---

## Frontend Routes
| Path | Component | Roles |
|------|-----------|-------|
| /login | Login | Public |
| /dashboard | Dashboard | ALL |
| /executive-map | ExecutiveMap | SUPER_ADMIN, ADMIN, OPS_MANAGER, READ_ONLY_AUDITOR |
| /projects | Projects | SUPER_ADMIN, ADMIN, OPS_MANAGER, OPS_EXECUTIVE, READ_ONLY_AUDITOR |
| /planning | PlanningWorkspace | SUPER_ADMIN, ADMIN, OPS_MANAGER |
| /assignments | Assignments | SUPER_ADMIN, ADMIN, OPS_MANAGER |
| /scheduling | Scheduling | SUPER_ADMIN, ADMIN, OPS_MANAGER, OPS_EXECUTIVE |
| /clients | Clients | SUPER_ADMIN, ADMIN, CLIENT_USER |
| /branches | Branches | SUPER_ADMIN, ADMIN, OPS_MANAGER, READ_ONLY_AUDITOR |
| /assayers | Assayers | SUPER_ADMIN, ADMIN, OPS_MANAGER, ASSAYER, READ_ONLY_AUDITOR |
| /assayers/:id | AssayerProfile | (various) |
| /documents | Documents | SUPER_ADMIN, ADMIN, OPS_MANAGER, DOC_EXECUTIVE, VAL_MANAGER, VALIDATOR |
| /validation | Validation | SUPER_ADMIN, ADMIN, VAL_MANAGER, VALIDATOR |
| /rules | Rules | SUPER_ADMIN, ADMIN |
| /users | Users | SUPER_ADMIN, ADMIN |
| /notifications | Notifications | ALL |

---

## Mobile App (Assayer)
**Tabs:** SCHEDULE, PDF_DOCUMENTS, QUERIES, EARNINGS, PERFORMANCE, NOTIFICATIONS, MY_PROFILE

**Services:** api.service.ts (MobileApiService), notification.service.ts, socket.ts
**Types:** AssayerAssignment, CustomerRecord, ValidationQuery, AssayerExpense (TRAVEL_KM/TOLL/FOOD/OTHER, PENDING/APPROVED/REJECTED), AppNotification

---

## Enums (Shared Package)

| Enum | Values |
|------|--------|
| ProjectStatus | DRAFT, PLANNING, SCHEDULING, EXECUTION, VALIDATION, COMPLETED, ARCHIVED, CANCELLED, ON_HOLD |
| ProjectBranchStatus | IMPORTED, PLANNING, CANDIDATE_SEARCH, CONTACT_INITIATED, NEGOTIATION, ASSIGNMENT_CONFIRMED, SCHEDULED, AUDIT_COMPLETED, VALIDATION_COMPLETED, CLOSED, UNABLE_TO_COVER, ON_HOLD, CANCELLED |
| AssignmentStatus | PENDING, ACCEPTED, REJECTED, CANCELLED |
| ScheduleStatus | TENTATIVE, CONFIRMED, RESCHEDULED, COMPLETED |
| DocumentStatus | UPLOADED, PROCESSED, GENERATED, DISPATCHED, RECEIVED, ARCHIVED |
| DocumentType | BRANCH_LIST, CUSTOMER_MASTER_DATA, GENERATED_PDF, RETURNED_AUDIT_PDF, GENERATED_EXCEL, FINAL_REPORT |
| ValidationStatus | PENDING, ASSIGNED, OCR_PROCESSING, HUMAN_REVIEW, CORRECTION_REQUIRED, APPROVED, SUBMITTED |
| CustomerMasterStatus | DRAFT, RECONCILED, APPROVED, SUPERSEDED, REJECTED |
| ValidationQueryStatus | OPEN, RESPONDED, RESOLVED |
| AssayerStatus | ACTIVE, INACTIVE, SUSPENDED |
| AssayerLifecycleStatus | INVITED, DOCUMENT_VERIFICATION, BACKGROUND_VERIFICATION, TRAINING, ACTIVE, ON_LEAVE, SUSPENDED, INACTIVE, RESIGNED, TERMINATED, ARCHIVED |
| UserStatus | INVITED, ACTIVE, SUSPENDED, LOCKED, DISABLED, ARCHIVED |
| SystemRole | SUPER_ADMINISTRATOR, ADMINISTRATOR, OPERATIONS_MANAGER, OPERATIONS_EXECUTIVE, VALIDATION_MANAGER, VALIDATOR, DOCUMENT_EXECUTIVE, ASSAYER, CLIENT_USER, READ_ONLY_AUDITOR |
| CommunicationType | PHONE, WHATSAPP, EMAIL, SYSTEM |
| TravelMode | CAR, TRAIN, BUS, FLIGHT, TWO_WHEELER, OTHER |
| ClientLifecycleStatus | PROSPECT, ONBOARDING, ACTIVE, SUSPENDED, UNDER_REVIEW, INACTIVE, TERMINATED, ARCHIVED |
| ClientType | BANK, NBFC, MICROFINANCE, INSURANCE, CORPORATE, GOVERNMENT, OTHER |
| ContractStatus | DRAFT, ACTIVE, EXPIRED, TERMINATED, RENEWED |
| Priority | LOW, MEDIUM, HIGH, CRITICAL |

---

## State Machines

### Project Transitions
DRAFT -> PLANNING
PLANNING -> SCHEDULING | CANCELLED
SCHEDULING -> EXECUTION | ON_HOLD
EXECUTION -> VALIDATION | ON_HOLD
VALIDATION -> COMPLETED
COMPLETED -> ARCHIVED
ON_HOLD -> SCHEDULING | EXECUTION

### ProjectBranch Transitions
IMPORTED -> PLANNING
PLANNING -> CANDIDATE_SEARCH | UNABLE_TO_COVER
CANDIDATE_SEARCH -> CONTACT_INITIATED | UNABLE_TO_COVER
CONTACT_INITIATED -> NEGOTIATION | CANDIDATE_SEARCH
NEGOTIATION -> ASSIGNMENT_CONFIRMED | CANDIDATE_SEARCH
ASSIGNMENT_CONFIRMED -> SCHEDULED
SCHEDULED -> AUDIT_COMPLETED
AUDIT_COMPLETED -> VALIDATION_COMPLETED
VALIDATION_COMPLETED -> CLOSED
UNABLE_TO_COVER -> PLANNING
ON_HOLD -> PLANNING

### Assignment Transitions
PENDING -> ACCEPTED | REJECTED | CANCELLED
ACCEPTED -> CANCELLED

### Schedule Transitions
TENTATIVE -> CONFIRMED
CONFIRMED -> RESCHEDULED | COMPLETED
RESCHEDULED -> CONFIRMED

### Validation Transitions
PENDING -> ASSIGNED
ASSIGNED -> OCR_PROCESSING
OCR_PROCESSING -> HUMAN_REVIEW
HUMAN_REVIEW -> APPROVED | CORRECTION_REQUIRED
CORRECTION_REQUIRED -> HUMAN_REVIEW
APPROVED -> SUBMITTED

---

## End-to-End Business Workflow

### Actors
- **Client (Bank)**: Has branches across India, gives monthly audit contracts
- **Our Organization**: FAPOMS operator, manages the entire audit pipeline
- **Assayer**: Field auditor who visits bank branches, performs audit, returns PDF
- **Regional Operator (Upraiser)**: Handles specific regions, contacts/coordinates with assayers
- **Data Entry Team**: OCR processing, human validation, report generation
- **Client Portal**: External system where clients upload customer data and receive final reports

### WF-0: End-to-End Pipeline

**Phase 1 — Contract & Branch Intake**
1. Client (bank) gives a monthly audit contract → creates a **Project**
2. Client sends a list of branches (with packet counts) where audit is required
3. System feeds branch list under the project
4. For each branch: check if already in DB → if yes, use existing; if no → geo-resolve coordinates → save under client

**Phase 2 — Planning & Assayer Matching** (Page: Planning)
5. Select project → lists all branches on map with assayer recommendations
6. Recommendation criteria: distance, SLA, fees, time, workload, schedule, etc.
7. Team initiates calls to suitable assayers per branch
8. Assayer can: negotiate fees/allowances, accept, or reject
9. If accepted → mark branch as covered (`ASSIGNMENT_CONFIRMED`). If rejected/fails → find next candidate
10. Goal: maximize coverage across all branches
11. Schedule date with assayer during this phase too

**Phase 3 — Coverage Report** (after planning completes)
12. Generate coverage report (covered + uncovered branches)
13. Send report to client (bank) via their portal

**Phase 4 — Customer Data & PDF Generation** (1 day before audit)
14. Client uploads customer master data for the covered branches (1 day before scheduled audit)
15. System downloads customer data → uploads to external OCR application
16. External OCR generates PDF per branch: customer records + empty columns for manual audit entry
17. System receives generated PDFs

**Phase 5 — PDF Distribution**
18. System forwards PDFs via email to regional operators (each handles specific regions)
19. Regional operators send PDFs to their assigned assayers with bank details

**Phase 6 — Field Audit Execution** (Page: Assignments, Mobile)
20. Assayer visits bank branch, performs manual audit
21. Assayer scans each page of the completed audit PDF
22. Assayer sends scanned PDF back to their regional operator (upraiser)

**Phase 7 — Data Entry & Validation** (Page: Validation)
23. Regional operator forwards scanned PDFs to data entry team
24. Data entry team uploads PDF to external OCR application (which holds all records)
25. OCR processes each page → human-in-the-loop validation
26. After all pages processed → system generates Excel report for that branch
27. Data entry team downloads Excel, opens to check for issues
28. If issues found (e.g. handwriting unclear) → contact assayer for clarification via **Validation Queries**

**Phase 8 — Final Report**
29. Finalized report sent to data entry head for review
30. Data entry head sends final report to client's banking portal

---

## Workflow Mapping to System Features

### WF-1: Project Lifecycle
Admin creates project → DRAFT → PLANNING → SCHEDULING → EXECUTION → VALIDATION → COMPLETED → ARCHIVED

### WF-2: Branch Import & Geo-Resolution
Upload branch Excel or feed list → Check existing DB / geo-resolve new → ProjectBranch with IMPORTED status
Pages: Projects, Branches

### WF-3: Planning & Assayer Matching (see Phase 2 above)
ProjectBranch: CANDIDATE_SEARCH → CONTACT_INITIATED → NEGOTIATION → ASSIGNMENT_CONFIRMED
Assignment: PENDING → ACCEPTED (or REJECTED → CANCELLED → new candidate)
Pages: Planning

### WF-4: Scheduling
ProjectBranch at ASSIGNMENT_CONFIRMED → Schedule record created → date assigned → ProjectBranch → SCHEDULED
Pages: Scheduling

### WF-5: Field Execution (Mobile)
Assayer dispatched → ProjectBranch SCHEDULED → check-in via mobile → scan PDF → upload → ProjectBranch AUDIT_COMPLETED
Mobile tabs: Schedule, PDF, Queries, Earnings

### WF-6: Customer Master & PDF Generation
Client uploads customer Excel → CustomerMasterVersion (DRAFT → APPROVED) → External OCR generates PDFs → Documents (GENERATED_PDF)

### WF-7: PDF Distribution & Return
GENERATED_PDF → DISPATCHED to operator → forwarded to assayer → RETURNED_AUDIT_PDF (scanned copy) → RECEIVED

### WF-8: Document & OCR Pipeline
Scanned PDF uploaded → Document RECEIVED → External OCR processes → Validation workflow begins

### WF-9: Validation
ValidationCase PENDING → ASSIGNED → OCR_PROCESSING → HUMAN_REVIEW → APPROVED → SUBMITTED
During HUMAN_REVIEW: if issues → ValidationQuery OPEN → RESPONDED (by assayer) → RESOLVED → continue review

### WF-10: Report Generation
Validation complete → Generate Excel report (GENERATED_EXCEL) → Final review → FINAL_REPORT → Send to client portal

### WF-11: Billing & Ledger
Audit closed → Billing record (GST/TDS) → Ledger entry → Running balance

### WF-12: Assayer Lifecycle
INVITED → ... → ACTIVE → ... → ARCHIVED

### WF-13: Client Lifecycle
PROSPECT → ... → ACTIVE → ... → ARCHIVED

### WF-14: SLA Monitoring
Periodic scan → Check slaDueDate → Flag breaches

---

## External Integrations
- OCR: Bull queue + external OCR engine callback
- Push Notifications: FCM (firebase-admin)
- File Storage: S3 or Local
- PDF/Excel: SheetJS (xlsx)
- Geospatial: PostGIS, Haversine
- Real-time: Socket.IO
- Job Queue: Bull (Redis)
