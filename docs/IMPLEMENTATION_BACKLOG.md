# FAPOMS Consolidated Implementation Backlog

This backlog is the single source of truth for all remaining implementation work. It is generated from the approved specifications, current repository status, and code quality audits.

---

## 1. Backlog Items (Dependency-Ordered)

### BL-SEC-01: Production JWT Verification Enforcer
- **Title:** Block insecure JWT secret fallback in production
- **Business Capability:** System Security
- **Module:** AuthModule
- **Business Value:** Prevents weak key exploits during staging/production deployments.
- **Specification References:** `08_Identity_Authorization.md`
- **Related Database Objects:** None
- **Related Backend Modules:** AuthModule (`main.ts`)
- **Related Frontend Pages:** None
- **Related APIs:** None
- **Related Roles:** Super Administrator
- **Dependencies:** None
- **Acceptance Criteria:** Backend throws error and halts bootstrap if `NODE_ENV === 'production'` and `JWT_SECRET === 'dev-secret'`.
- **Current Status:** Complete
- **Priority:** Critical
- **Estimated Complexity:** Small

### BL-AUTH-01: Deactivated User Session Invalidation
- **Title:** Evict active sessions of deactivated users
- **Business Capability:** Authentication Security
- **Module:** AuthModule
- **Business Value:** Ensures immediate block of access after status deactivation.
- **Specification References:** `08_Identity_Authorization.md`
- **Related Database Objects:** `refresh_tokens`, `users`
- **Related Backend Modules:** AuthModule, UserModule
- **Related Frontend Pages:** Users
- **Related APIs:** `PUT /api/v1/users/:id`
- **Related Roles:** Super Administrator
- **Dependencies:** None
- **Acceptance Criteria:** Deactivating a user removes their active refresh tokens from the DB and invalidates the active access token payload during Strategy checking.
- **Current Status:** Not Started
- **Priority:** High
- **Estimated Complexity:** Medium

### BL-USER-01: User Directory Search & Filtering UI
- **Title:** Add search, sorting, and role filters to User page
- **Business Capability:** System Administration
- **Module:** UserModule
- **Business Value:** Enables administrators to navigate users easily.
- **Specification References:** `08_Identity_Authorization.md`
- **Related Database Objects:** `users`
- **Related Backend Modules:** UserModule
- **Related Frontend Pages:** Users
- **Related APIs:** `GET /api/v1/users`
- **Related Roles:** Super Administrator, Administrator
- **Dependencies:** None
- **Acceptance Criteria:** Frontend user list table supports search inputs, status selectors, and role checkbox filters.
- **Current Status:** Not Started
- **Priority:** Medium
- **Estimated Complexity:** Medium

### BL-CLIENT-01: Client Profile CRUD & SLA Editor
- **Title:** Create client admin workspace
- **Business Capability:** Client Administration
- **Module:** ClientModule
- **Business Value:** Centralizes banking client profiles and SLA config editing.
- **Specification References:** `01_Product_Vision.md`, `03_Functional_Modules.md`
- **Related Database Objects:** `clients`, `client_configurations`
- **Related Backend Modules:** ClientModule
- **Related Frontend Pages:** Clients
- **Related APIs:** `POST /api/v1/clients`, `PUT /api/v1/clients/:id`
- **Related Roles:** Super Administrator, Administrator
- **Dependencies:** None
- **Acceptance Criteria:** UI supports listing, creating, and editing client profiles and JSONB SLA rule parameters.
- **Current Status:** Not Started
- **Priority:** High
- **Estimated Complexity:** Large

### BL-BRANCH-01: Branch Master CRUD & normalization
- **Title:** Add branch editing and address verification
- **Business Capability:** Master Data Management
- **Module:** BranchModule
- **Business Value:** Prevents incorrect scheduling coordinates.
- **Specification References:** `03_Functional_Modules.md`, `09_Assignment_Planning.md`
- **Related Database Objects:** `branches`
- **Related Backend Modules:** BranchModule
- **Related Frontend Pages:** Branches
- **Related APIs:** `PUT /api/v1/branches/:id`, `DELETE /api/v1/branches/:id`
- **Related Roles:** Operations Manager
- **Dependencies:** None
- **Acceptance Criteria:** Enforce validation that addresses map to proper state/district hierarchies.
- **Current Status:** Not Started
- **Priority:** Medium
- **Estimated Complexity:** Medium

### BL-PLAN-01: Recommendation Engine multi-factor Scoring
- **Title:** Enforce travel cost and workload scoring
- **Business Capability:** Assignment Planning
- **Module:** PlanningModule
- **Business Value:** Provides cost-efficient assayer recommendations.
- **Specification References:** `09_Assignment_Planning.md`
- **Related Database Objects:** `assayers`, `branches`, `assignments`
- **Related Backend Modules:** PlanningModule
- **Related Frontend Pages:** PlanningWorkspace
- **Related APIs:** `GET /api/v1/planning/recommend`
- **Related Roles:** Operations Manager, Operations Executive
- **Dependencies:** None
- **Acceptance Criteria:** Recommendations return sorted scores combining PostGIS distance, active workload counts, and past assignment success rates.
- **Current Status:** Not Started
- **Priority:** High
- **Estimated Complexity:** Large

### BL-DOC-01: Automated PDF Pack Generator
- **Title:** Generate branch audit checklist packages
- **Business Capability:** Document Management
- **Module:** DocumentModule
- **Business Value:** Replaces manual package collection for assayers.
- **Specification References:** `03_Functional_Modules.md`
- **Related Database Objects:** `documents`
- **Related Backend Modules:** DocumentModule
- **Related Frontend Pages:** Documents
- **Related APIs:** `POST /api/v1/documents/generate`
- **Related Roles:** Document Executive
- **Dependencies:** None
- **Acceptance Criteria:** Automatically builds PDF packs matching branch specifications and links them to assignments.
- **Current Status:** Not Started
- **Priority:** Medium
- **Estimated Complexity:** Large
