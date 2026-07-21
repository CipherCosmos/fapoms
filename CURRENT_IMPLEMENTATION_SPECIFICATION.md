# FAPOMS — Current Implementation Specification

**Field Audit Planning & Operations Management System**

**Document Type:** Reverse Engineering / Implementation Audit
**Date:** 2026-07-21
**Status:** Complete — All 15 Phases

---

## Table of Contents

1. [Repository Analysis](#phase-1-repository-analysis)
2. [Business Capability Discovery](#phase-2-business-capability-discovery)
3. [Frontend Reverse Engineering](#phase-3-frontend-reverse-engineering)
4. [Backend Reverse Engineering](#phase-4-backend-reverse-engineering)
5. [Database Reverse Engineering](#phase-5-database-reverse-engineering)
6. [API Reverse Engineering](#phase-6-api-reverse-engineering)
7. [Role & Permission Analysis](#phase-7-role--permission-analysis)
8. [Workflow Discovery](#phase-8-workflow-discovery)
9. [Specification Verification](#phase-9-specification-verification)
10. [Code Quality Discovery](#phase-10-code-quality-discovery)
11. [Dependency Analysis](#phase-11-dependency-analysis)
12. [Implementation Completeness](#phase-12-implementation-completeness)
13. [Implementation Inventory](#phase-13-implementation-inventory)
14. [Missing Pieces](#phase-14-missing-pieces)
15. [Final Summary](#phase-15-final-summary)

---

# Phase 1: Repository Analysis

## 1.1 Project Identity

- **Name:** FAPOMS (Field Audit Planning & Operations Management System)
- **Root directory:** `/Users/deepstacker/WorkSpace/dupcq/gssAutomation`
- **Type:** npm workspaces monorepo
- **Private:** true
- **Node requirement:** >=20.0.0

## 1.2 Repository Map

```
gssAutomation/
├── .git/
├── node_modules/
├── package.json                          # Root monorepo config
├── package-lock.json
├── README.md                             # Placeholder (2 lines)
├── PROJECT_CONSTITUTION.md               # 437 lines — Engineering principles
├── implementatin_plan.md                 # 1033 lines — Architecture proposal (NOT implementation)
├── specification/                        # 10 business requirement documents
│   ├── 01_Product_Vision.md
│   ├── 02_Domain_Model.md
│   ├── 03_Functional_Modules.md
│   ├── 04_Operational_Workflow.md
│   ├── 05_Business_Services.md
│   ├── 06_State_Event_Model.md
│   ├── 07_Canonical_Data_Model.md
│   ├── 08_Identity_Authorization.md
│   ├── 09_Assignment_Planning.md
│   └── 10_UI_UX_Principles.md
├── packages/
│   ├── shared/                           # @fapoms/shared — Canonical types
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── tsconfig.esm.json
│   │   └── src/
│   │       ├── index.ts                  # Barrel re-export
│   │       ├── enums.ts                  # 17 enums
│   │       ├── interfaces.ts             # 22 interfaces
│   │       ├── api-contracts.ts          # 15 API contract types
│   │       └── state-machines.ts         # 5 state machines + validator
│   ├── backend/                          # @fapoms/backend — NestJS monolith
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── nest-cli.json
│   │   ├── .env                          # Committed dev secrets
│   │   ├── .env.example
│   │   └── src/
│   │       ├── main.ts
│   │       ├── app.module.ts
│   │       ├── core/
│   │       │   ├── audit/                # Global audit module
│   │       │   └── entities/             # Base entity classes
│   │       ├── infrastructure/
│   │       │   └── database/             # TypeORM config + seed
│   │       └── modules/
│   │           ├── auth/                 # JWT + Passport authentication
│   │           ├── user/                 # User, Role, Permission management
│   │           ├── client/               # Client profile + configuration
│   │           ├── branch/               # Branch CRUD + Excel import
│   │           ├── assayer/              # Assayer CRUD
│   │           ├── holiday/              # Holiday calendar
│   │           ├── zone/                 # Operational zones
│   │           ├── planning/             # Candidate recommendation
│   │           ├── project/              # Project + ProjectBranch
│   │           └── assignment/           # Assignment management
│   └── frontend/                         # @fapoms/frontend — React SPA
│       ├── package.json
│       ├── tsconfig.json
│       ├── tsconfig.node.json
│       ├── vite.config.ts
│       └── src/
│           ├── main.tsx                  # Entry point
│           ├── App.tsx                   # Root router + auth gate
│           ├── index.css                 # Design system (CSS custom properties)
│           ├── services/
│           │   └── api.ts                # Dual-mode API client
│           ├── components/
│           │   ├── Layout.tsx            # App shell
│           │   ├── Sidebar.tsx           # Navigation
│           │   └── Header.tsx            # Global header + mode badge
│           └── pages/
│               ├── Login.tsx             # Login form
│               ├── Dashboard.tsx         # Mock dashboard
│               ├── Projects.tsx          # Project CRUD
│               ├── Branches.tsx          # Branch listing + import
│               └── PlanningWorkspace.tsx  # Planning workspace
```

## 1.3 Package Details

### Root `package.json`
- **Workspaces:** `packages/shared`, `packages/backend`, `packages/frontend`
- **Scripts:**
  - `dev:backend` — `npm run dev --workspace=packages/backend`
  - `dev:frontend` — `npm run dev --workspace=packages/frontend`
  - `build:shared` — `npm run build --workspace=packages/shared`
  - `build:backend` — `npm run build --workspace=packages/backend`
  - `build:frontend` — `npm run build --workspace=packages/frontend`
  - `lint` — runs lint in all workspaces
  - `test` — runs test in all workspaces
- **No CI/CD configuration exists**

### `@fapoms/shared` (packages/shared)
- **Type:** Dual CJS/ESM build
- **Output:** `dist/cjs/` + `dist/esm/`
- **Dependencies:** TypeScript only (dev)
- **Build:** `tsc` for CJS, `tsc -p tsconfig.esm.json` for ESM

### `@fapoms/backend` (packages/backend)
- **Framework:** NestJS 11
- **ORM:** TypeORM 0.3 with PostgreSQL (pg driver)
- **Auth:** Passport + passport-jwt + bcrypt
- **Validation:** class-validator + class-transformer
- **Docs:** Swagger (@nestjs/swagger)
- **File parsing:** xlsx (Excel import)
- **Config:** @nestjs/config (dotenv-based)
- **Testing:** Jest + ts-jest configured (ZERO test files found)
- **Migration scripts:** defined in package.json (`migration:generate`, `migration:run`, `migration:revert`) but NOT USED — DB uses `synchronize: true`

### `@fapoms/frontend` (packages/frontend)
- **Framework:** React 19 with Vite 6
- **Routing:** react-router-dom 7 (inline in App.tsx, no separate router file)
- **Data fetching:** @tanstack/react-query 5 (CONFIGURED but NEVER USED — all pages use raw useState/useEffect + manual fetch)
- **Icons:** lucide-react
- **Build:** Vite with proxy: `/api` → `http://localhost:3000`

## 1.4 Environment Configuration

**File:** `packages/backend/.env` (committed to VCS)

| Variable | Value |
|----------|-------|
| PORT | 3000 |
| NODE_ENV | development |
| FRONTEND_URL | http://localhost:5173 |
| DB_HOST | localhost |
| DB_PORT | 5432 |
| DB_USERNAME | fapoms |
| DB_PASSWORD | fapoms_dev |
| DB_DATABASE | fapoms |
| DB_SYNCHRONIZE | true |
| DB_LOGGING | false |
| JWT_SECRET | fapoms-secret-key-for-local-development-only-12345 |
| JWT_ACCESS_EXPIRATION | 900 (15 min) |
| JWT_REFRESH_EXPIRATION | 604800 (7 days) |
| FILE_STORAGE_PATH | ./uploads |
| MAX_FILE_SIZE | 52428800 (50 MB) |

**Key concern:** `JWT_SECRET` is hardcoded and committed. `DB_SYNCHRONIZE=true` is dangerous for any non-development environment.

## 1.5 Missing Infrastructure

| Item | Status |
|------|--------|
| Dockerfile | Not present |
| docker-compose.yml | Not present |
| CI/CD pipeline | Not present |
| Database migrations | Not present (uses synchronize) |
| Test files | Not present (0 spec files) |
| ESLint config (backend) | Referenced in scripts but file not confirmed |
| .gitignore | Not checked (node_modules excluded by default) |

---

# Phase 2: Business Capability Discovery

## 2.1 Implemented Business Capabilities

### 2.1.1 Authentication (100% Complete)

| Aspect | Status |
|--------|--------|
| Login (username/email + password) | Implemented |
| JWT access tokens (15 min) | Implemented |
| Refresh token rotation | Implemented |
| Token revocation (logout) | Implemented |
| Account lockout (5 failures, 15 min) | Implemented |
| Auth status health endpoint | Implemented |
| Session management via refresh_tokens table | Implemented |
| Password hashing (bcrypt, 12 rounds) | Implemented |
| JWT payload includes roles + permissions | Implemented |

**Backend:** `auth.module.ts`, `auth.controller.ts`, `auth.service.ts`, `jwt.strategy.ts`, `refresh-token.entity.ts`, `guards.ts`
**Frontend:** `Login.tsx` (with sandbox fallback for `admin/admin123`)
**APIs:** `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/status`

### 2.1.2 Authorization - RBAC (100% Complete)

| Aspect | Status |
|--------|--------|
| Role-based guards (JwtAuthGuard, RolesGuard) | Implemented |
| Permission-based guard (PermissionsGuard) | Implemented (but never applied to any controller) |
| `@Roles()` decorator | Implemented |
| `@RequirePermissions()` decorator | Implemented (but never used) |
| Hierarchical scope expansion | Implemented (PLATFORM implies all lower scopes) |
| Role ↔ Permission many-to-many | Implemented |
| User ↔ Role many-to-many | Implemented |

**Backend:** `guards.ts`, `role.entity.ts`, `permission.entity.ts`, `user.entity.ts`
**Frontend:** No permission-based UI rendering (all sidebar items rendered regardless)

### 2.1.3 Audit Trail (100% Complete)

| Aspect | Status |
|--------|--------|
| Append-only audit event table | Implemented |
| Business event recording | Implemented (in every service) |
| Entity history retrieval | Implemented |
| User activity retrieval | Implemented |
| Global injectable AuditService | Implemented |
| Structured event metadata (JSONB) | Implemented |

**Backend:** `audit.module.ts` (Global), `audit.service.ts`, `audit-event.entity.ts`
**Frontend:** Not connected (audit events not displayed in any UI)

### 2.1.4 User Management (100% Complete)

| Aspect | Status |
|--------|--------|
| User CRUD | Implemented |
| Role assignment | Implemented |
| Password enforcement (min 8 chars) | Implemented |
| Duplicate username/email check | Implemented |
| Auto-generated displayName | Implemented |
| Pagination with metadata | Implemented |
| Sanitized user responses (no password hash) | Implemented |
| User status lifecycle | Implemented (ACTIVE/SUSPENDED/LOCKED etc.) |
| "Me" endpoint (current user profile) | Implemented |

**Backend:** `user.module.ts`, `user.controller.ts`, `user.service.ts`, `user.entity.ts`
**Frontend:** `App.tsx` calls `GET /users/me` (sandbox fallback always returns "Sandbox Admin")
**APIs:** `GET /users/me`, `POST /users`, `GET /users`, `GET /users/:id`, `PUT /users/:id`, `PUT /users/:id/roles`

### 2.1.5 Client Management (100% Complete)

| Aspect | Status |
|--------|--------|
| Client CRUD | Implemented |
| Per-client configuration (JSONB) | Implemented |
| Import mapping storage | Implemented |
| Working days configuration | Implemented |
| Default radius configuration | Implemented |
| SLA rules configuration | Implemented |
| Duplicate clientCode check | Implemented |
| Soft delete | Implemented |
| Audit trail on all mutations | Implemented |

**Backend:** `client.module.ts`, `client.controller.ts`, `client.service.ts`, `client.entity.ts`, `client-configuration.entity.ts`
**Frontend:** `Projects.tsx` and `Branches.tsx` fetch clients for dropdown selectors
**APIs:** `POST /clients`, `GET /clients`, `GET /clients/:id`, `PUT /clients/:id`, `DELETE /clients/:id`

### 2.1.6 Branch Management (95% Complete)

| Aspect | Status |
|--------|--------|
| Branch CRUD | Implemented |
| PostGIS location (Point, SRID 4326) | Implemented |
| Geography validation (State→District→City) | Implemented |
| Excel import with dynamic column mapping | Implemented |
| Duplicate detection (upsert on branchCode+clientId) | Implemented |
| Client-scoped branch queries | Implemented |
| Audit trail | Implemented |

**Missing:** No branch update endpoint (`PUT /branches/:id`), no branch delete endpoint (`DELETE /branches/:id`)

**Backend:** `branch.module.ts`, `branch.controller.ts`, `branch.service.ts`, `branch.entity.ts`
**Frontend:** `Branches.tsx` — list with filters + Excel upload
**APIs:** `POST /branches`, `GET /branches`, `GET /branches/:id`, `POST /branches/import/:clientId`

### 2.1.7 Assayer Management (95% Complete)

| Aspect | Status |
|--------|--------|
| Assayer CRUD | Implemented |
| PostGIS location | Implemented |
| Bank account/PAN details | Implemented |
| Status management (REGISTERED/ACTIVE/INACTIVE/BUSY/SUSPENDED) | Implemented |
| Duplicate assayerCode check | Implemented |
| Soft delete | Implemented |
| Audit trail | Implemented |

**Missing:** No assayer update for status transitions as separate endpoint, no assayer search endpoint

**Backend:** `assayer.module.ts`, `assayer.controller.ts`, `assayer.service.ts`, `assayer.entity.ts`
**Frontend:** No dedicated assayer page (only appears in PlanningWorkspace recommendations)
**APIs:** `POST /assayers`, `GET /assayers`, `GET /assayers/:id`, `PUT /assayers/:id`, `DELETE /assayers/:id`

### 2.1.8 Holiday Calendar (95% Complete)

| Aspect | Status |
|--------|--------|
| Holiday CRUD | Implemented |
| National/Bank/Regional/Custom types | Implemented |
| Year-based filtering | Implemented |
| Date + state holiday check | Implemented |
| Audit trail | Implemented |

**Missing:** No holiday update endpoint (`PUT /holidays/:id`), bulk holiday import

**Backend:** `holiday.module.ts`, `holiday.controller.ts`, `holiday.service.ts`, `holiday.entity.ts`
**Frontend:** No holiday management page
**APIs:** `POST /holidays`, `GET /holidays`, `GET /holidays/check`, `DELETE /holidays/:id`

### 2.1.9 Zone Management (100% Complete)

| Aspect | Status |
|--------|--------|
| Zone CRUD | Implemented |
| Per-client zone scoping | Implemented |
| State/district JSONB configuration | Implemented |
| Soft delete | Implemented |
| Audit trail | Implemented |

**Issues:** No duplicate name check (possible data quality issue)

**Backend:** `zone.module.ts`, `zone.controller.ts`, `zone.service.ts`, `zone.entity.ts`
**Frontend:** No zone management page
**APIs:** `POST /zones`, `GET /zones`, `GET /zones/:id`, `PUT /zones/:id`, `DELETE /zones/:id`

### 2.1.10 Project Management (40% Complete)

| Aspect | Status |
|--------|--------|
| Project CRUD | Partially (create + list only) |
| Project branch tracking | Partially (create via assignment, list via /:id/branches) |
| Client association | Implemented |
| Status enum (ProjectStatus) | Defined but not enforced in service |
| Priority assignment | Implemented |
| Audit trail | Implemented |

**Missing:** Project update, project delete/archive, project status transitions, project lifecycle enforcement, full project detail view

**Backend:** `project.module.ts`, `project.controller.ts`, `project.service.ts`, `project.entity.ts`, `project-branch.entity.ts`
**Frontend:** `Projects.tsx` — create modal + table list
**APIs:** `POST /projects`, `GET /projects`, `GET /projects/:id/branches`

### 2.1.11 Assignment Management (30% Complete)

| Aspect | Status |
|--------|--------|
| Assignment creation | Implemented (with validation) |
| Holiday conflict detection | Implemented |
| Double-booking prevention | Implemented |
| Auto-generated assignment number | Implemented |
| Assignment listing | Implemented |
| Audit trail | Implemented |

**Missing:** Assignment update, cancellation, completion, full status lifecycle, negotiation flow, rejection flow

**Issues:** Assignments are created directly in `ACCEPTED` status (skipping CREATED → CANDIDATE_SELECTED → CONTACT_INITIATED → NEGOTIATION cycle). `agreedFee` is auto-set to `proposedFee`.

**Backend:** `assignment.module.ts`, `assignment.controller.ts`, `assignment.service.ts`, `assignment.entity.ts`
**Frontend:** `PlanningWorkspace.tsx` has a negotiation modal → creates assignment
**APIs:** `POST /assignments`, `GET /assignments`

### 2.1.12 Candidate Recommendation Engine (70% Complete)

| Aspect | Status |
|--------|--------|
| PostGIS proximity search (ST_DistanceSphere) | Implemented |
| Geographic fallback (state+district matching) | Implemented |
| ACTIVE assayers only filter | Implemented |
| Distance in kilometers (rounded) | Implemented |
| Ranked by distance ASC | Implemented |

**Missing:** Workload-aware scoring, historical performance weighting, multi-factor candidate ranking, configurable radius from client config

**Backend:** `planning.module.ts`, `planning.controller.ts`, `planning.service.ts`
**Frontend:** `PlanningWorkspace.tsx` right panel — shows candidate cards with distance, phone link, assign button
**APIs:** `GET /planning/recommendations?branchId=X`

## 2.2 Business Capabilities NOT Implemented

| Capability | Specification Reference | Status |
|-----------|----------------------|--------|
| Scheduling module | Part 3 §4, Part 5 §6 | Not started |
| Communication tracking | Part 3 §9, Part 5 §11 | Not started |
| Document management | Part 3 §8, Part 5 §10 | Not started |
| Validation coordination | Part 3 §10, Part 5 §12 | Not started |
| Coverage analysis service | Part 3 §7, Part 5 §4 | Not started |
| Dashboard & analytics | Part 3 §11, Part 5 §14 | Not started (mock-only) |
| Notification service | Part 5 §13 | Not started |
| Workflow service | Part 5 §9 | Not started |
| GIS module (map visualization) | Part 3 §6 | Not started |
| Report generation | Part 3 §12 | Not started |
| PDF generation | Part 3 §8 | Not started |
| OCR integration | Part 3 §10 | Not started |
| Communication (WhatsApp/Email) | Part 3 §9 | Not started |
| Mobile app (Assayer) | Part 1 §6 | Not started |

---

# Phase 3: Frontend Reverse Engineering

## 3.1 Frontend File Inventory

**Total source files:** 13
**Directories:** `src/services/`, `src/components/`, `src/pages/`
**Missing directories:** `src/hooks/`, `src/router/`, `src/types/`, `src/utils/`

| File | Lines | Type | Completion |
|------|-------|------|------------|
| `src/main.tsx` | 26 | Entry point | 100% |
| `src/App.tsx` | 110 | Root component | 70% |
| `src/services/api.ts` | 125 | API client | 80% |
| `src/pages/Dashboard.tsx` | 154 | Dashboard page | 5% (all mock) |
| `src/pages/Projects.tsx` | 452 | Project CRUD page | 40% |
| `src/pages/Branches.tsx` | 316 | Branch list + import | 50% |
| `src/pages/PlanningWorkspace.tsx` | 528 | Planning workspace | 40% |
| `src/pages/Login.tsx` | 193 | Login page | 90% |
| `src/components/Layout.tsx` | 44 | App shell | 100% |
| `src/components/Sidebar.tsx` | 131 | Navigation | 80% |
| `src/components/Header.tsx` | 170 | Global header | 70% |
| `src/index.css` | 243 | Design system | 90% |
| `vite.config.ts` | 25 | Build config | 100% |

## 3.2 Page-by-Page Analysis

### Login (`Login.tsx`)
- **Route:** `/login`
- **Purpose:** Authenticate users
- **Backend calls:** `POST /api/v1/auth/login` (direct fetch)
- **Sandbox mode:** Accepts `admin/admin123` with hardcoded `mock-jwt-token`
- **State:** username, password, isLoading, error
- **Components used:** None from project
- **Working:** Yes (both live and sandbox)
- **Issues:**
  - Token stored with key `'fapoms_token'` (typo: missing 'S' in FAPOMS)
  - Sandbox fallback only works for exact `admin/admin123`
  - No registration or forgot-password flow

### Dashboard (`Dashboard.tsx`)
- **Route:** `/dashboard` (root redirect)
- **Purpose:** Operational overview
- **Backend calls:** NONE — all data hardcoded
- **State:** None (all static)
- **Components used:** lucide-react icons only
- **Working:** No — 100% mock data. 4 metric cards, 3 projects, 3 activities all hardcoded arrays
- **Broken elements:** "View All" button does nothing

### Projects (`Projects.tsx`)
- **Route:** `/projects`
- **Purpose:** Project directory with CRUD
- **Backend calls:**
  - `GET /api/v1/clients` — via `api.request()` (has mock fallback)
  - `GET /api/v1/projects` — via `api.request()` (has mock fallback)
  - `POST /api/v1/projects` — **direct fetch (will fail if backend offline)**
- **State:** projects[], clients[], searchTerm, statusFilter, modal state, message
- **Components used:** `api` from services
- **Working:** Partial — reads work in sandbox, writes broken offline
- **Broken elements:**
  - "Export CSV" button does nothing
  - "Detail" button per project does nothing
  - Create project modal submits via direct fetch (no fallback)
  - `getClientName()` falls back to hardcoded `'SBI Corporate'`

### Branches (`Branches.tsx`)
- **Route:** `/branches`
- **Purpose:** Branch directory with Excel import
- **Backend calls:**
  - `GET /api/v1/clients` — via `api.request()` (has mock fallback)
  - `GET /api/v1/branches?clientId=X&limit=100` — via `api.request()` (has mock fallback)
  - `POST /api/v1/branches/import/:clientId` — **direct fetch (will fail if backend offline)**
- **State:** branches[], clients[], selectedClientId, searchTerm, stateFilter, isLoading, isUploading, message
- **Components used:** `api` from services
- **Working:** Partial — reads work in sandbox, upload broken offline
- **Broken elements:**
  - State filter options hardcoded (Maharashtra, Gujarat, Karnataka)
  - Excel import uses direct fetch (no fallback)
  - No branch delete button (not implemented in backend anyway)

### PlanningWorkspace (`PlanningWorkspace.tsx`)
- **Route:** `/planning`
- **Purpose:** Multi-panel assignment planning workspace
- **Backend calls:**
  - `GET /api/v1/projects` — via `api.request()` (has mock fallback)
  - `GET /api/v1/projects/:id/branches` — **direct fetch (will fail if backend offline)**
  - `GET /api/v1/planning/recommendations?branchId=X` — via `api.request()` (has mock fallback with 1 hardcoded candidate)
  - `POST /api/v1/assignments` — **direct fetch (will fail if backend offline)**
- **State:** projects[], selectedProjectId, branches[], selectedBranchId, candidates[], negotiation modal state, message
- **Components used:** `api` from services, `Priority` from `@fapoms/shared`
- **Working:** Partial — recommendations display in sandbox, assignment creation broken offline
- **Broken elements:**
  - Load branches fails silently if offline
  - Create assignment fails silently if offline
  - Hardcoded `distanceKm: 4.8` in mock fallback
  - Coverage percentage calculated client-side from branch statuses
  - Project dropdown populated by mock data only

## 3.3 UI Component Analysis

### Layout (`Layout.tsx`)
- Renders `<Sidebar>`, `<Header>`, and `<main>` content area
- Derives page title from `useLocation().pathname`
- Uses CSS Grid layout: `grid-template-areas: "sidebar header" / "sidebar main"`
- **No permission-based rendering** — sidebar always shows all items

### Sidebar (`Sidebar.tsx`)
- 10 navigation items: Dashboard, Projects, Branches, Assignment Planning, Assignments, Scheduling, Documents, Validation, Reports, Administration
- All items are NavLinks with lucide-react icons
- User info footer at bottom
- **All items rendered regardless of user role**
- **Unused items:** Assignments, Scheduling, Documents, Validation, Reports — all navigate to placeholder routes with "Coming in Phase X" text

### Header (`Header.tsx`)
- Page title (derived from route)
- Live/Sandbox mode badge (subscribes to `api.subscribe()`)
- Organization selector (hardcoded "Axis Bank Project" — does nothing)
- Global search input (placeholder only — no functionality)
- Notification bell (static red dot — no functionality)
- Logout button

## 3.4 Frontend Critical Issues

1. **React Query is NEVER used** — Configured in `main.tsx` but zero `useQuery` or `useMutation` calls exist. All pages use raw `useState` + `useEffect` + manual fetch
2. **Dual fetch pattern** — Some pages use `api.request()` (with mock fallback) for reads, but raw `fetch` for writes. `api.request()` mock fallback only works for GET requests
3. **No loading boundaries** — No `Suspense`, no `ErrorBoundary`, no loading skeletons. All loading states are basic "Loading..." text
4. **No error boundaries** — Runtime errors will crash the entire app
5. **No router config file** — Routing is inline in `App.tsx`
6. **No custom hooks** — Zero files in `src/hooks/`
7. **Token key typo** — `localStorage.getItem('fapoms_token')` — missing 'S'
8. **7 placeholder routes** — Assignments, Scheduling, Documents, Validation, Reports, Admin all show static text
9. **Dashboard is entirely static** — Zero backend integration
10. **`@fapoms/shared` underutilized** — Only `ProjectStatus` and `Priority` enums imported. State machines, API contracts, interfaces all unused

---

# Phase 4: Backend Reverse Engineering

## 4.1 Backend Module Inventory

**Total source files:** 50 (across 13 directories)
**Framework:** NestJS 11 with Express platform
**API prefix:** `/api/v1`
**Swagger docs:** `/api/docs`

### Module List

| Module | Files | Dependencies | Status |
|--------|-------|-------------|--------|
| Auth | 5 | User, JWT, Passport, TypeORM | Complete |
| User | 5 | Role, Permission, TypeORM | Complete |
| Audit | 3 | TypeORM | Complete (Global) |
| Client | 5 | TypeORM | Complete |
| Branch | 4 | Client, Geo entities, TypeORM, xlsx | Complete (no update/delete endpoints) |
| Assayer | 4 | TypeORM | Complete |
| Holiday | 4 | TypeORM | Complete |
| Zone | 4 | TypeORM | Complete |
| Planning | 3 | Branch, Assayer (direct repos) | Complete |
| Project | 5 | TypeORM | Partial (no update/delete) |
| Assignment | 4 | HolidayModule, TypeORM | Partial (no update/delete/transitions) |
| Geo | 1 (entities) | TypeORM | Reference data only (no CRUD) |

## 4.2 Controllers Detail

| Controller | Endpoints | RBAC Applied? | Notable Issues |
|-----------|-----------|---------------|----------------|
| AuthController | `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/status` | N/A (public) | None |
| UserController | `GET /users/me`, `POST /users`, `GET /users`, `GET /users/:id`, `PUT /users/:id`, `PUT /users/:id/roles` | SUPER_ADMIN, ADMIN on writes | None |
| ClientController | `POST /clients`, `GET /clients`, `GET /clients/:id`, `PUT /clients/:id`, `DELETE /clients/:id` | SUPER_ADMIN, ADMIN, OPS_MGR on writes | None |
| BranchController | `POST /branches`, `GET /branches`, `GET /branches/:id`, `POST /branches/import/:clientId` | SUPER_ADMIN, ADMIN, OPS_MGR on writes | No update/delete endpoints |
| AssayerController | `POST /assayers`, `GET /assayers`, `GET /assayers/:id`, `PUT /assayers/:id`, `DELETE /assayers/:id` | SUPER_ADMIN, ADMIN, OPS_MGR on writes | None |
| HolidayController | `POST /holidays`, `GET /holidays`, `GET /holidays/check`, `DELETE /holidays/:id` | SUPER_ADMIN, ADMIN on writes | No update endpoint |
| ZoneController | `POST /zones`, `GET /zones`, `GET /zones/:id`, `PUT /zones/:id`, `DELETE /zones/:id` | SUPER_ADMIN, ADMIN, OPS_MGR on writes | No duplicate name check |
| PlanningController | `GET /planning/recommendations` | NO @Roles (any authenticated user) | None |
| ProjectController | `POST /projects`, `GET /projects`, `GET /projects/:id/branches` | NO @Roles on any | Incomplete CRUD, missing RBAC |
| AssignmentController | `POST /assignments`, `GET /assignments` | NO @Roles on any | Incomplete CRUD, missing RBAC |

## 4.3 Services Detail

| Service | Methods | Business Rules | Issues |
|---------|---------|---------------|--------|
| AuthService | login, refreshAccessToken, logout, validateJwtPayload, generateTokenPair, hashToken | Lock after 5 failures (15 min), only ACTIVE users, token rotation | None |
| UserService | createUser, findById, findAll, updateUser, assignRoles | No duplicate username/email, min 8 char password, auto displayName | `findByIds` deprecated |
| ClientService | create, findOne, findAll, update, remove | Duplicate clientCode check, soft delete, default config | None |
| BranchService | create, findOne, findAll, importExcel, validateGeography | Geography validation, dynamic column mapping, upsert on duplicate | No update/delete |
| AssayerService | create, findOne, findAll, update, remove | Duplicate assayerCode, soft delete, auto displayName, auto location | None |
| HolidayService | create, findOne, findAll, isHoliday, remove | Nationwide holidays, soft delete | No update |
| ZoneService | create, findOne, findAll, update, remove | Soft delete | **No duplicate name check** |
| PlanningService | getRecommendedCandidates | Only ACTIVE assayers, distance fallback to state+district | None |
| ProjectService | create, findAll, findOne, findProjectBranches | None — no state enforcement | No update/delete |
| AssignmentService | create, findAll | Holiday check, double-booking check, auto ACCEPTED status | Skips negotiation flow |

## 4.4 Key Backend Inconsistencies

1. **Pagination format varies** — User/Client/Branch/Assayer/Holiday/Zone controllers include `hasNext`/`hasPrevious` in pagination metadata. Project/Assignment controllers lack these fields (inconsistent API contract)

2. **RBAC missing on critical modules** — ProjectController, AssignmentController, and PlanningController have **zero** `@Roles()` decorators. Any authenticated user (including an Assayer or Client User) can create assignments, create projects, and query recommendations

3. **PlanningModule bypasses module boundaries** — Instead of importing BranchModule and AssayerModule, PlanningModule directly declares their entities in `TypeOrm.forFeature()`. This breaks the module encapsulation pattern

4. **Assignment created as ACCEPTED** — The service creates assignments directly in `ACCEPTED` status, skipping the entire negotiation workflow defined in the state machines (CREATED → CANDIDATE_SELECTED → CONTACT_INITIATED → NEGOTIATION → ACCEPTED)

5. **StatefulEntity never used** — `base.entity.ts` defines `StatefulEntity` (with `previousState`, `newState`, `changeReason`) but no entity extends it

6. **Geo entities only in BranchModule** — `GeoStateEntity`, `GeoDistrictEntity`, `GeoCityEntity` are registered in BranchModule's `TypeOrm.forFeature()` but not in AppModule. This works but violates NestJS conventions

7. **PlanningService doesn't use client config** — The default radius of 50km is hardcoded in client config, but PlanningService never reads it for proximity searches

8. **`findByIds` deprecated** — Used in `user.service.ts:67` and `user.service.ts:163`. Should use `findBy({ id: In(ids) })` in modern TypeORM

---

# Phase 5: Database Reverse Engineering

## 5.1 Entity → Table Mapping

| Entity | Table | Extends | TypeORM Decorators | PostGIS |
|--------|-------|---------|-------------------|---------|
| UserEntity | users | BaseEntity | @Entity, @Index(email) | No |
| RoleEntity | roles | BaseEntity | @Entity | No |
| PermissionEntity | permissions | BaseEntity | @Entity, @Index([resource,action,scope]) unique | No |
| RefreshTokenEntity | refresh_tokens | (standalone) | @Entity, @Index([userId]), @Index([expiresAt]) | No |
| AuditEventEntity | audit_events | (standalone) | @Entity, @Index([entityType,entityId]), @Index([occurredAt]), @Index([userId]), @Index([category]) | No |
| ClientEntity | clients | BaseEntity | @Entity | No |
| ClientConfigurationEntity | client_configurations | BaseEntity | @Entity | No |
| BranchEntity | branches | BaseEntity | @Entity, @Index([branchCode]), @Index([solId]), @Index([clientId]), @Index({spatial:true, columns:['location']}) | Yes |
| AssayerEntity | assayers | BaseEntity | @Entity, @Index([assayerCode]), @Index([status]), @Index([state]), @Index({spatial:true, columns:['location']}) | Yes |
| ProjectEntity | projects | BaseEntity | @Entity, @Index([projectNumber]), @Index([clientId]) | No |
| ProjectBranchEntity | project_branches | BaseEntity | @Entity, @Index([projectId]), @Index([branchId]), @Index([status]) | No |
| AssignmentEntity | assignments | BaseEntity | @Entity, @Index([assignmentNumber]), @Index([projectBranchId]), @Index([projectId]), @Index([assayerId]) | No |
| ZoneEntity | zones | BaseEntity | @Entity, @Index([clientId]) | No |
| HolidayEntity | holidays | BaseEntity | @Entity, @Index([date]), @Index([year]) | No |
| GeoStateEntity | geo_states | BaseEntity | @Entity | No |
| GeoDistrictEntity | geo_districts | BaseEntity | @Entity, @Index([stateId]) | No |
| GeoCityEntity | geo_cities | BaseEntity | @Entity, @Index([districtId]) | No |

## 5.2 BaseEntity Columns (inherited by all except RefreshToken, AuditEvent)

| Column | Type | Description |
|--------|------|-------------|
| id | UUID (PK) | System identifier |
| createdBy | UUID (nullable) | Who created the record |
| createdAt | TIMESTAMPTZ | When created (auto-set) |
| updatedBy | UUID (nullable) | Who last updated |
| updatedAt | TIMESTAMPTZ | When last updated (auto-set) |
| version | INTEGER | Optimistic locking version |
| isActive | BOOLEAN (default true) | Soft delete flag |

## 5.3 Full Schema (19 tables)

### users
| Column | Type | Constraints |
|--------|------|-------------|
| (BaseEntity columns) | — | — |
| username | VARCHAR(100) | UNIQUE, NOT NULL |
| email | VARCHAR(255) | UNIQUE, NOT NULL, INDEXED |
| password_hash | VARCHAR(255) | NOT NULL |
| first_name | VARCHAR(100) | NOT NULL |
| last_name | VARCHAR(100) | NOT NULL |
| display_name | VARCHAR(200) | NOT NULL |
| status | VARCHAR(20) | DEFAULT 'ACTIVE' |
| department_id | UUID | NULLABLE |
| phone | VARCHAR(20) | NULLABLE |
| last_login_at | TIMESTAMPTZ | NULLABLE |
| failed_login_attempts | INTEGER | DEFAULT 0 |
| locked_until | TIMESTAMPTZ | NULLABLE |

**Join table:** `user_roles` (user_id, role_id)

### roles
| Column | Type | Constraints |
|--------|------|-------------|
| (BaseEntity columns) | — | — |
| name | VARCHAR(50) | UNIQUE, NOT NULL |
| display_name | VARCHAR(100) | NOT NULL |
| description | TEXT | NULLABLE |

**Join table:** `role_permissions` (role_id, permission_id)
**Eager loading:** Yes — `@ManyToMany(() => PermissionEntity, {eager: true})`

### permissions
| Column | Type | Constraints |
|--------|------|-------------|
| (BaseEntity columns) | — | — |
| resource | VARCHAR(50) | NOT NULL |
| action | VARCHAR(50) | NOT NULL |
| scope | VARCHAR(50) | NOT NULL |
| description | TEXT | NULLABLE |
| **Unique index** | — | (resource, action, scope) |

### refresh_tokens
| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID (PK) | — |
| user_id | UUID | NOT NULL, INDEXED |
| token_hash | VARCHAR(255) | NOT NULL |
| expires_at | TIMESTAMPTZ | NOT NULL, INDEXED |
| is_revoked | BOOLEAN | DEFAULT false |
| revoked_at | TIMESTAMPTZ | NULLABLE |
| replaced_by | UUID | NULLABLE |
| ip_address | VARCHAR(50) | NULLABLE |
| user_agent | TEXT | NULLABLE |
| created_at | TIMESTAMPTZ | NOT NULL |

### audit_events
| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID (PK) | — |
| category | VARCHAR(50) | NOT NULL, INDEXED |
| event_type | VARCHAR(100) | NOT NULL |
| entity_type | VARCHAR(100) | NOT NULL |
| entity_id | UUID | NOT NULL |
| previous_state | VARCHAR(50) | NULLABLE |
| new_state | VARCHAR(50) | NULLABLE |
| user_id | UUID | NULLABLE, INDEXED |
| user_display_name | VARCHAR(200) | NULLABLE |
| ip_address | VARCHAR(50) | NULLABLE |
| remarks | TEXT | NULLABLE |
| metadata | JSONB | NULLABLE |
| occurred_at | TIMESTAMPTZ | NOT NULL, INDEXED |
| Index (entity_type, entity_id) | — | INDEXED |

### clients
| Column | Type | Constraints |
|--------|------|-------------|
| (BaseEntity columns) | — | — |
| client_code | VARCHAR(50) | UNIQUE, NOT NULL |
| name | VARCHAR(255) | NOT NULL |
| display_name | VARCHAR(255) | NOT NULL |
| contact_person | VARCHAR(200) | NULLABLE |
| contact_email | VARCHAR(255) | NULLABLE |
| contact_phone | VARCHAR(20) | NULLABLE |
| address | TEXT | NULLABLE |

**Relation:** OneToOne → client_configurations (cascade, eager)

### client_configurations
| Column | Type | Constraints |
|--------|------|-------------|
| (BaseEntity columns) | — | — |
| client_id | UUID | NOT NULL (FK to clients) |
| import_mapping | JSONB | NULLABLE |
| working_days | JSONB | NULLABLE (default [1,2,3,4,5]) |
| default_radius | DECIMAL(5,2) | DEFAULT 50.00 |
| sla_rules | JSONB | NULLABLE |
| effective_from | TIMESTAMPTZ | NOT NULL |
| effective_to | TIMESTAMPTZ | NULLABLE |

### branches
| Column | Type | Constraints |
|--------|------|-------------|
| (BaseEntity columns) | — | — |
| branch_code | VARCHAR(50) | NOT NULL, INDEXED |
| sol_id | VARCHAR(50) | NULLABLE, INDEXED |
| name | VARCHAR(255) | NOT NULL |
| address | TEXT | NOT NULL |
| state | VARCHAR(100) | NOT NULL |
| district | VARCHAR(100) | NOT NULL |
| city | VARCHAR(100) | NOT NULL |
| pincode | VARCHAR(20) | NULLABLE |
| latitude | DECIMAL(10,7) | NULLABLE |
| longitude | DECIMAL(10,7) | NULLABLE |
| location | GEOMETRY(Point, 4326) | NULLABLE, SPATIAL INDEX |
| client_id | UUID | NULLABLE, INDEXED |

### assayers
| Column | Type | Constraints |
|--------|------|-------------|
| (BaseEntity columns) | — | — |
| assayer_code | VARCHAR(50) | UNIQUE, NOT NULL, INDEXED |
| first_name | VARCHAR(100) | NOT NULL |
| last_name | VARCHAR(100) | NOT NULL |
| display_name | VARCHAR(200) | NOT NULL |
| email | VARCHAR(255) | NULLABLE |
| phone | VARCHAR(20) | NOT NULL |
| alternate_phone | VARCHAR(20) | NULLABLE |
| address | TEXT | NOT NULL |
| state | VARCHAR(100) | NOT NULL, INDEXED |
| district | VARCHAR(100) | NOT NULL |
| city | VARCHAR(100) | NOT NULL |
| pincode | VARCHAR(20) | NULLABLE |
| latitude | DECIMAL(10,7) | NULLABLE |
| longitude | DECIMAL(10,7) | NULLABLE |
| location | GEOMETRY(Point, 4326) | NULLABLE, SPATIAL INDEX |
| status | VARCHAR(50) | DEFAULT 'REGISTERED', INDEXED |
| pan_number | VARCHAR(20) | NULLABLE |
| bank_account_number | VARCHAR(50) | NULLABLE |
| ifsc_code | VARCHAR(20) | NULLABLE |
| notes | TEXT | NULLABLE |

### projects
| Column | Type | Constraints |
|--------|------|-------------|
| (BaseEntity columns) | — | — |
| project_number | VARCHAR(50) | UNIQUE, NOT NULL, INDEXED |
| name | VARCHAR(255) | NOT NULL |
| description | TEXT | NULLABLE |
| client_id | UUID | NOT NULL, INDEXED |
| status | ENUM(ProjectStatus) | DEFAULT 'PLANNING' (note: spec says DRAFT, code defaults to PLANNING) |
| priority | ENUM(Priority) | DEFAULT 'MEDIUM' |
| start_date | DATE | NULLABLE |
| end_date | DATE | NULLABLE |

### project_branches
| Column | Type | Constraints |
|--------|------|-------------|
| (BaseEntity columns) | — | — |
| project_id | UUID | NOT NULL, INDEXED |
| branch_id | UUID | NOT NULL, INDEXED |
| status | ENUM(ProjectBranchStatus) | DEFAULT 'IMPORTED' |
| priority | ENUM(Priority) | DEFAULT 'MEDIUM' |
| zone_id | UUID | NULLABLE |
| scheduled_date | DATE | NULLABLE |
| remarks | TEXT | NULLABLE |

**Relation:** @OneToOne → AssignmentEntity (nullable)

### assignments
| Column | Type | Constraints |
|--------|------|-------------|
| (BaseEntity columns) | — | — |
| assignment_number | VARCHAR(50) | UNIQUE, NOT NULL, INDEXED |
| project_branch_id | UUID | NOT NULL, INDEXED |
| project_id | UUID | NOT NULL, INDEXED |
| assayer_id | UUID | NOT NULL, INDEXED |
| status | ENUM(AssignmentStatus) | DEFAULT 'CREATED' (but service creates as ACCEPTED) |
| proposed_fee | DECIMAL(12,2) | NULLABLE |
| agreed_fee | DECIMAL(12,2) | NULLABLE |
| scheduled_date | DATE | NULLABLE |
| completion_date | DATE | NULLABLE |
| remarks | TEXT | NULLABLE |
| cancel_reason | TEXT | NULLABLE |
| reject_reason | TEXT | NULLABLE |

### zones
| Column | Type | Constraints |
|--------|------|-------------|
| (BaseEntity columns) | — | — |
| name | VARCHAR(150) | NOT NULL |
| description | TEXT | NULLABLE |
| client_id | UUID | NULLABLE, INDEXED |
| states | JSONB | NULLABLE |
| districts | JSONB | NULLABLE |

### holidays
| Column | Type | Constraints |
|--------|------|-------------|
| (BaseEntity columns) | — | — |
| name | VARCHAR(150) | NOT NULL |
| date | DATE | NOT NULL, INDEXED |
| type | VARCHAR(20) | DEFAULT 'NATIONAL' |
| applicable_states | JSONB | NULLABLE |
| year | INTEGER | NOT NULL, INDEXED |

### geo_states
| Column | Type | Constraints |
|--------|------|-------------|
| (BaseEntity columns) | — | — |
| name | VARCHAR(100) | UNIQUE, NOT NULL |
| code | VARCHAR(10) | UNIQUE, NOT NULL |

### geo_districts
| Column | Type | Constraints |
|--------|------|-------------|
| (BaseEntity columns) | — | — |
| name | VARCHAR(100) | NOT NULL |
| state_id | UUID | NOT NULL (FK), INDEXED |

### geo_cities
| Column | Type | Constraints |
|--------|------|-------------|
| (BaseEntity columns) | — | — |
| name | VARCHAR(100) | NOT NULL |
| district_id | UUID | NOT NULL (FK), INDEXED |
| pincode | VARCHAR(10) | NULLABLE |

## 5.4 Relationship Summary

```
User *—* Role (ManyToMany via user_roles)
Role *—* Permission (ManyToMany via role_permissions)

Client 1—* Project (OneToMany)
Client 1—1 ClientConfiguration (OneToOne)

Project 1—* ProjectBranch (OneToMany)
Branch 1—* ProjectBranch (OneToMany)
ProjectBranch 1—0..1 Assignment (OneToOne)

Assignment *—1 Assayer (ManyToOne)
Assignment *—1 Project (ManyToOne)

Zone *—1 Client (ManyToOne)
Holiday (standalone)

GeoState 1—* GeoDistrict (OneToMany)
GeoDistrict 1—* GeoCity (OneToMany)
Branch *—1 Client (ManyToOne)
```

## 5.5 Database Issues

1. **No migrations** — TypeORM `synchronize: true` is used. Schema is generated from entity definitions at application startup
2. **No explicit foreign key constraints in decorators** — Relations use `onDelete: 'CASCADE'` / `'SET NULL'` but TypeORM may not generate FK constraints in all database engines (should be verified)
3. **Missing indexes** — No indexes on `assignments.scheduled_date`, `assignments.status`, `project_branches.zone_id`, `branches.state`, `branches.district`
4. **`ProjectEntity.status` default mismatch** — Code defaults to `PLANNING`, spec says project starts as `DRAFT`

## 5.6 Seed Data

The seed script (`seed.ts`) creates:
- **25 permissions** (for all role-resource-action-scope combinations)
- **4 roles:** SUPER_ADMINISTRATOR, OPERATIONS_MANAGER, OPERATIONS_EXECUTIVE, VALIDATOR
- **1 admin user:** admin / admin123
- **3 states:** Maharashtra, Gujarat, Karnataka
- **3 districts per state:** Mumbai/Pune/Nagpur, Ahmedabad/Surat/Vadodara, Bengaluru/Mysuru/Hubli
- **3 cities per district** (9 cities per state)
- **2 clients:** SBI Corporate (SBI), HDFC Bank (HDFC)
- **3 assayers:** Rajesh Sharma, Priya Patel, Amit Verma (with PostGIS locations in Maharashtra)
- **3 branches:** SBI branches in Mumbai, Pune, Nagpur (with PostGIS locations)
- **1 project:** "SBI Q2 2026 Audit Project"
- **3 project branches:** (linking the project to the 3 SBI branches)
- **3 holidays:** Republic Day (NATIONAL), Maharashtra Day (REGIONAL), Diwali (NATIONAL)

---

# Phase 6: API Reverse Engineering

## 6.1 Complete API Inventory

### Authentication (`/api/v1/auth`)

| Method | Path | Auth | Roles | Request | Response | Status | Caller |
|--------|------|------|-------|---------|----------|--------|--------|
| GET | /auth/status | None | None | — | `{status, database, timestamp}` | Live | api.ts health check |
| POST | /auth/login | None | None | `{username, password}` | `{accessToken, refreshToken, expiresIn, user}` | Live | Login.tsx |
| POST | /auth/refresh | None | None | `{refreshToken}` | `{accessToken, refreshToken, expiresIn}` | Live | Not called from FE |
| POST | /auth/logout | JWT | None | — | `{success}` | Live | Header logout button |

### Users (`/api/v1/users`)

| Method | Path | Auth | Roles | Request | Response | Status | Caller |
|--------|------|------|-------|---------|----------|--------|--------|
| GET | /users/me | JWT | Any | — | Sanitized User | Live | App.tsx |
| POST | /users | JWT | SUPER_ADMIN, ADMIN | CreateUserDto | User | Live | Not called from FE |
| GET | /users | JWT | SUPER_ADMIN, ADMIN | page, limit | Paginated Users | Live | Not called from FE |
| GET | /users/:id | JWT | Any | — | Sanitized User | Live | Not called from FE |
| PUT | /users/:id | JWT | SUPER_ADMIN, ADMIN | UpdateUserDto | User | Live | Not called from FE |
| PUT | /users/:id/roles | JWT | SUPER_ADMIN, ADMIN | `{roleIds}` | User | Live | Not called from FE |

### Clients (`/api/v1/clients`)

| Method | Path | Auth | Roles | Request | Response | Status | Caller |
|--------|------|------|-------|---------|----------|--------|--------|
| POST | /clients | JWT | ADMIN, SUPER_ADMIN, OPS_MGR | CreateClientDto | Client | Live | Not called from FE |
| GET | /clients | JWT | Any | page, limit | Paginated Clients | Live | Projects.tsx, Branches.tsx |
| GET | /clients/:id | JWT | Any | — | Client | Live | Not called from FE |
| PUT | /clients/:id | JWT | ADMIN, SUPER_ADMIN, OPS_MGR | UpdateClientDto | Client | Live | Not called from FE |
| DELETE | /clients/:id | JWT | ADMIN, SUPER_ADMIN | — | `{success}` | Live | Not called from FE |

### Branches (`/api/v1/branches`)

| Method | Path | Auth | Roles | Request | Response | Status | Caller |
|--------|------|------|-------|---------|----------|--------|--------|
| POST | /branches | JWT | ADMIN, SUPER_ADMIN, OPS_MGR | CreateBranchDto | Branch | Live | Not called from FE |
| GET | /branches | JWT | Any | page, limit, clientId | Paginated Branches | Live | Branches.tsx |
| GET | /branches/:id | JWT | Any | — | Branch | Live | Not called from FE |
| POST | /branches/import/:clientId | JWT | ADMIN, SUPER_ADMIN, OPS_MGR | Excel file (multipart) | `{importedCount, errors}` | Live | Branches.tsx |

### Assayers (`/api/v1/assayers`)

| Method | Path | Auth | Roles | Request | Response | Status | Caller |
|--------|------|------|-------|---------|----------|--------|--------|
| POST | /assayers | JWT | ADMIN, SUPER_ADMIN, OPS_MGR | CreateAssayerDto | Assayer | Live | Not called from FE |
| GET | /assayers | JWT | Any | page, limit | Paginated Assayers | Live | Not called from FE |
| GET | /assayers/:id | JWT | Any | — | Assayer | Live | Not called from FE |
| PUT | /assayers/:id | JWT | ADMIN, SUPER_ADMIN, OPS_MGR | UpdateAssayerDto | Assayer | Live | Not called from FE |
| DELETE | /assayers/:id | JWT | ADMIN, SUPER_ADMIN | — | `{success}` | Live | Not called from FE |

### Projects (`/api/v1/projects`)

| Method | Path | Auth | Roles | Request | Response | Status | Caller |
|--------|------|------|-------|---------|----------|--------|--------|
| POST | /projects | JWT | **NONE** | CreateProjectRequestDto | Project | Live | Projects.tsx |
| GET | /projects | JWT | **NONE** | page, limit | Paginated Projects | Live | Projects.tsx, PlanningWorkspace.tsx |
| GET | /projects/:id/branches | JWT | **NONE** | — | ProjectBranches[] | Live | PlanningWorkspace.tsx |

### Assignments (`/api/v1/assignments`)

| Method | Path | Auth | Roles | Request | Response | Status | Caller |
|--------|------|------|-------|---------|----------|--------|--------|
| POST | /assignments | JWT | **NONE** | CreateAssignmentDto | Assignment | Live | PlanningWorkspace.tsx |
| GET | /assignments | JWT | **NONE** | page, limit | Paginated Assignments | Live | Not called from FE |

### Planning (`/api/v1/planning`)

| Method | Path | Auth | Roles | Request | Response | Status | Caller |
|--------|------|------|-------|---------|----------|--------|--------|
| GET | /planning/recommendations | JWT | **NONE** | branchId | `AssayerRecommendation[]` | Live | PlanningWorkspace.tsx |

### Holidays (`/api/v1/holidays`)

| Method | Path | Auth | Roles | Request | Response | Status | Caller |
|--------|------|------|-------|---------|----------|--------|--------|
| POST | /holidays | JWT | ADMIN, SUPER_ADMIN | CreateHolidayDto | Holiday | Live | Not called from FE |
| GET | /holidays | JWT | Any | page, limit, year | Paginated Holidays | Live | Not called from FE |
| GET | /holidays/check | JWT | Any | date, stateCode | `{isHoliday: boolean}` | Live | AssignmentService (internal) |
| DELETE | /holidays/:id | JWT | ADMIN, SUPER_ADMIN | — | `{success}` | Live | Not called from FE |

### Zones (`/api/v1/zones`)

| Method | Path | Auth | Roles | Request | Response | Status | Caller |
|--------|------|------|-------|---------|----------|--------|--------|
| POST | /zones | JWT | ADMIN, SUPER_ADMIN, OPS_MGR | CreateZoneDto | Zone | Live | Not called from FE |
| GET | /zones | JWT | Any | page, limit, clientId | Paginated Zones | Live | Not called from FE |
| GET | /zones/:id | JWT | Any | — | Zone | Live | Not called from FE |
| PUT | /zones/:id | JWT | ADMIN, SUPER_ADMIN, OPS_MGR | UpdateZoneDto | Zone | Live | Not called from FE |
| DELETE | /zones/:id | JWT | ADMIN, SUPER_ADMIN | — | `{success}` | Live | Not called from FE |

## 6.2 API Summary

| Metric | Count |
|--------|-------|
| Total endpoints | 36 |
| Endpoints with RBAC (@Roles) | 21 (58%) |
| Endpoints WITHOUT RBAC | 15 (42%) |
| Endpoints called from frontend | 11 (31%) |
| Endpoints NOT called from frontend | 25 (69%) |
| Public endpoints (no auth) | 3 (auth/status, auth/login, auth/refresh) |
| Pagination format consistent | 6 of 8 list endpoints (75%) |

---

# Phase 7: Role & Permission Analysis

## 7.1 Implemented Roles (from seed data)

| Role | Permissions in Seed | Used in @Roles Decorators |
|------|--------------------|---------------------------|
| SUPER_ADMINISTRATOR | All 25 permissions | Yes (user, client, assayer, holiday, zone controllers) |
| ADMINISTRATOR | Not assigned in seed comment (model exists) | Yes (user, client, assayer, holiday, zone controllers) |
| OPERATIONS_MANAGER | Limited set | Yes (client, branch, assayer, zone controllers) |
| OPERATIONS_EXECUTIVE | Not assigned in seed | Not used in any @Roles decorator |
| VALIDATOR | Not assigned in seed | Not used in any @Roles decorator |
| VALIDATION_MANAGER | Not seeded | Not used |
| DOCUMENT_EXECUTIVE | Not seeded | Not used |
| ASSAYER | Not seeded | Not used |
| CLIENT_USER | Not seeded | Not used |
| READ_ONLY_AUDITOR | Not seeded | Not used |

## 7.2 Seed Permissions

The seed script creates permissions for most combinations of `PermissionResource` × `PermissionAction` × `AuthorizationScope`, but only 4 roles are created with explicit permission assignments.

## 7.3 Guards Applied to Controllers

| Controller | @Roles Used | Roles Required | Missing Roles |
|-----------|------------|---------------|---------------|
| AuthController | N/A (public) | — | — |
| UserController | YES | SUPER_ADMIN, ADMIN | — |
| ClientController | YES | SUPER_ADMIN, ADMIN, OPS_MGR | — |
| BranchController | YES | SUPER_ADMIN, ADMIN, OPS_MGR | — |
| AssayerController | YES | SUPER_ADMIN, ADMIN, OPS_MGR | — |
| HolidayController | YES | SUPER_ADMIN, ADMIN | — |
| ZoneController | YES | SUPER_ADMIN, ADMIN, OPS_MGR | — |
| **PlanningController** | **NO** | **Any authenticated** | All roles missing |
| **ProjectController** | **NO** | **Any authenticated** | All roles missing |
| **AssignmentController** | **NO** | **Any authenticated** | All roles missing |

## 7.4 Permission Model Issues

1. **`PermissionsGuard` is never used** — The `@RequirePermissions()` decorator exists but no controller endpoint uses it. Only role-level guards are applied
2. **Scope hierarchy is defined but never evaluated** — The `PermissionsGuard` has scope expansion logic (PLATFORM → ORGANIZATION → CLIENT → ... → SELF) but since no endpoint uses `@RequirePermissions`, this is dead code
3. **No frontend permission enforcement** — All sidebar items are rendered regardless of user role
4. **`PermissionsGuard` has no error handler** — If a permission check fails, it throws `ForbiddenException` with no custom message, but this is untested (never activated)

---

# Phase 8: Workflow Discovery

## 8.1 Implemented Workflows

### Workflow 1: User Login
```
[Login.tsx] → POST /auth/login → [AuthService.login] → Verify password
                                                       → Check lock status
                                                       → Generate JWT + refresh token
                                                       → Record USER_LOGIN audit
                                                       → Return tokens + user profile
                                                       → App.tsx stores token in localStorage
                                                       → Redirect to /dashboard
```
**Actors:** All users
**Completion:** 100%
**Backend:** Fully implemented
**Frontend:** Implemented (with sandbox fallback)

### Workflow 2: Create Client
```
[Not called from FE] → POST /clients → [ClientService.create] → Check duplicate clientCode
                                                               → Create client + default config
                                                               → Record CLIENT_CREATED audit
```
**Actors:** SUPER_ADMIN, ADMIN, OPERATIONS_MANAGER
**Completion:** 100% (backend only)
**Backend:** Fully implemented
**Frontend:** Not implemented (no client management page)

### Workflow 3: Create Branch
```
[Not called from FE] → POST /branches → [BranchService.create] → Validate geography
                                                                → Create PostGIS point
                                                                → Record BRANCH_CREATED audit
```
**Actors:** SUPER_ADMIN, ADMIN, OPERATIONS_MANAGER
**Completion:** 80% (backend + single branch create)
**Note:** No branch update or delete endpoints

### Workflow 4: Import Branches from Excel
```
[Branches.tsx] → POST /branches/import/:clientId (file upload)
               → [BranchService.importExcel] → Parse XLSX
                                              → Load client import mapping
                                              → Map columns dynamically
                                              → Validate geography per row
                                              → Check duplicates (upsert)
                                              → Create PostGIS points
                                              → Record BRANCHES_BULK_IMPORT audit
                                              → Return {importedCount, errors}
```
**Actors:** SUPER_ADMIN, ADMIN, OPERATIONS_MANAGER
**Completion:** 80% (backend fully implemented, frontend upload works in live mode)
**Note:** No progress reporting for large files, no async processing

### Workflow 5: Create Project
```
[Projects.tsx] → POST /projects → [ProjectService.create] → Set status PLANNING
                                                           → Record PROJECT_CREATED audit
```
**Actors:** Any authenticated user (no role restriction)
**Completion:** 30%
**Issues:** No lifecycle transitions, no branch import at project creation, no validation

### Workflow 6: Candidate Recommendation
```
[PlanningWorkspace.tsx] → GET /planning/recommendations?branchId=X
                        → [PlanningService.getRecommendedCandidates]
                            → Load branch with coordinates
                            → If coordinates exist:
                                → ST_DistanceSphere query for ACTIVE assayers
                                → Order by distance ASC
                            → Else:
                                → Match by state + district
                            → Return ranked list with distanceKm
```
**Actors:** Any authenticated user (no role restriction)
**Completion:** 70%
**Issues:** No workload-aware scoring, no configurable radius, no multi-factor ranking

### Workflow 7: Create Assignment
```
[PlanningWorkspace.tsx] → POST /assignments → [AssignmentService.create]
                                              → Load project branch with branch
                                              → Check holiday conflict (branch state)
                                              → Check assayer double-booking
                                              → Create assignment (status ACCEPTED)
                                              → Update project branch (ASSIGNMENT_CONFIRMED)
                                              → Record ASSIGNMENT_ACCEPTED audit
```
**Actors:** Any authenticated user (no role restriction)
**Completion:** 30%
**Issues:** Skips entire negotiation workflow, auto-accepts, auto-sets agreedFee

### Workflow 8: Holiday Check (Internal)
```
[AssignmentService.create] → [HolidayService.isHoliday]
                             → Check date against holidays table
                             → If state provided, check applicableStates
                             → Return boolean
```
**Actors:** Internal (called by AssignmentService)
**Completion:** 100%

## 8.2 Workflows NOT Implemented

| Workflow | Spec Reference | Status |
|---------|---------------|--------|
| Project lifecycle (DRAFT→PLANNING→...→ARCHIVED) | Part 2 §3, Part 6 §3 | Not started |
| Assignment negotiation (CREATED→CONTACTED→NEGOTIATION→ACCEPTED/REJECTED) | Part 2 §4, Part 6 §5 | Not started |
| Scheduling (date selection, conflict resolution) | Part 3 §4, Part 5 §6 | Not started |
| PDF generation & dispatch | Part 3 §8 | Not started |
| Document upload & tracking | Part 3 §8, Part 5 §10 | Not started |
| Validation workflow (OCR→Human Review→Approval) | Part 3 §10, Part 5 §12 | Not started |
| Communication tracking (phone/WhatsApp) | Part 3 §9, Part 5 §11 | Not started |
| Coverage calculation & display | Part 3 §7, Part 5 §4 | Not started |
| Notification dispatch | Part 5 §13 | Not started |
| Report generation | Part 3 §12 | Not started |
| Project closure & archival | Part 6 §3 | Not started |

---

# Phase 9: Specification Verification

## 9.1 Implemented Requirements

| # | Requirement | Status | Implementation |
|---|-------------|--------|----------------|
| C1 | Multi-client architecture | ✅ Implemented | Per-client data + configuration |
| C6 | RBAC + ABAC authorization | ⚠️ Partial | RBAC implemented, ABAC (PermissionsGuard) defined but unused |
| C7 | Soft delete policy | ✅ Implemented | isActive flag on all entities |
| C9 | Holiday-aware scheduling | ⚠️ Partial | Holiday service + check exists, but no scheduling module |
| C12 | Client-specific import mappings | ✅ Implemented | JSONB import_mapping on client_configurations |
| C13 | Business identifiers separate from system IDs | ✅ Implemented | UUIDs for PK, business codes for identification |
| C14 | Configuration-driven behavior | ⚠️ Partial | Client config works, but no global configuration system |
| C17 | Desktop-first responsive design | ⚠️ Partial | CSS grid layout works, no mobile testing done |
| C18 | Accepted assignments are locked | ❌ Not implemented | Assignment status changes not implemented |

## 9.2 Partially Implemented Requirements

| # | Requirement | Implementation Gap |
|---|-------------|-------------------|
| C2 | Planning workspace with multi-panel layout | Frontend has basic 2-panel layout (spec says 4-panel: left/center/right/bottom) |
| C3 | Candidate recommendation engine | PostGIS proximity works, but no workload/history/score factors |
| C4 | Real-time coverage calculation | No coverage service; client-side percentage only |
| C5 | Immutable audit trail | Backend implemented, but no UI to view audit history |
| C8 | State-machine driven entity lifecycles | State machines defined in shared but NOT enforced in any backend service |
| C10 | Document lifecycle tracking | Not started |
| C11 | Geographic intelligence | PostGIS proximity works, but no map visualization, clustering, or address search |
| C15 | Bulk operations with per-record audit | Not started (BulkOperationRequest defined in shared) |
| C16 | Enterprise table views | Frontend has basic tables but no saved views, column config, or export |

## 9.3 Not Implemented Requirements

| # | Requirement | Phase |
|---|-------------|-------|
| C2 (full) | Multi-panel workspace (4 panels) | Phase 3 |
| C4 (full) | Real-time coverage service | Phase 3 |
| C8 (full) | State machine enforcement | Phase 3 |
| C10 | Document lifecycle | Phase 5 |
| C11 (full) | Map integration, clustering | Phase 3 |
| C15 | Bulk operations | Phase 5 |

## 9.4 Implementation Without Specification

Several implementation details exist in the code that are not explicitly specified in the requirements:

1. **Assignment auto-creation as ACCEPTED** — Not in any spec. Spec describes negotiation workflow
2. **Account lockout (5 attempts, 15 min)** — Not explicitly specified in Part 8
3. **Excel import with dynamic column mapping** — Import format was an open question (M2), but implementation assumes Excel with per-client mapping
4. **Audit event table with JSONB metadata** — Not specified at this level of detail
5. **PostGIS (SRID 4326) for spatial data** — Technology choice, not a requirement

## 9.5 Specification/Implementation Mismatches

| Spec Statement | Implementation | Issue |
|----------------|---------------|-------|
| Project status starts as DRAFT (Part 6 §3) | Defaults to PLANNING | Minor, but inconsistent |
| Assignment workflow: CREATED → CANDIDATE_SELECTED → CONTACT_INITIATED → NEGOTIATION → ACCEPTED (Part 6 §5) | Created directly as ACCEPTED | Major — skips negotiation |
| Schedule is a separate entity owned by Assignment (Part 7 §5) | No Schedule entity, no Schedule table | Schedule not implemented at all |
| "Assignment Planning" state between Planning and Scheduling (Part 3 §2) | Not reflected in code | Phase ordering differs from spec |
| Zones per-Client (Part 2 §9) | zone.entity.ts has clientId FK | Implemented as recommended |
| Coverage: multi-tier (planned + confirmed) | Not implemented | Coverage not implemented |

## 9.6 Specification Gaps (Things Code Implements That Specs Don't Cover)

1. **User entity has `department_id`** — Not specified in Part 8
2. **Permission scope hierarchy expansion** — Not in Part 8 at this level
3. **Refresh token rotation** — Not specified in Part 8
4. **Optimistic locking (version column)** — Not specified in Part 7
5. **File storage path configuration** — Not in any spec
6. **PostGIS point field on both Branch and Assayer** — Not specified to this level

---

# Phase 10: Code Quality Discovery

## 10.1 Duplicate Logic

| Pattern | Locations | Impact |
|---------|-----------|--------|
| PostGIS Point creation | `branch.service.ts:54-58`, `assayer.service.ts:69-75`, `branch.service.ts:194-196` (importExcel) | 3x — should be a shared utility |
| Soft delete pattern | `client.service.ts`, `assayer.service.ts`, `holiday.service.ts`, `zone.service.ts` | 4x — same `isActive=false` + audit pattern |
| Pagination metadata construction | All 8 list controllers | Format varies — 6 have `hasNext/hasPrevious`, 2 don't |
| `@UseGuards(JwtAuthGuard, RolesGuard)` + `@ApiBearerAuth()` | Every controller class | 10x — could be a global guard |
| Audit record pattern | Every service method that mutates data | 15+ methods follow same `save → audit` pattern |
| `Object.assign` for entity updates | Every update service method | 6+ implementations |
| Entity field definitions | Shared `interfaces.ts` vs Backend entity files | 12 interfaces duplicated as TypeORM entities |

## 10.2 Unused Code

| Code | Location | Reason |
|------|----------|--------|
| `StatefulEntity` class | `core/entities/base.entity.ts:50` | Defined but never extended by any entity |
| `PermissionsGuard` | `modules/auth/guards.ts:55` | Defined but never applied to any controller |
| `@RequirePermissions()` decorator | `modules/auth/guards.ts:108` | Defined but never used on any endpoint |
| `PermissionEntity` in UserModule | `modules/user/user.module.ts` | Registered in TypeOrm.forFeature but only RoleEntity used |
| React Query (`@tanstack/react-query`) | Frontend `main.tsx` | Configured but zero components use `useQuery` or `useMutation` |
| API contracts in shared package | `api-contracts.ts` | 0 of 15 contracts imported by backend or frontend |
| State machines in shared package | `state-machines.ts` | 0 of 5 state machines imported by backend or frontend |
| 6 shared enums | `enums.ts` | ScheduleStatus, DocumentStatus, DocumentType, ValidationStatus, CommunicationType, TravelMode — never imported |
| 22 shared interfaces | `interfaces.ts` | 0 of 22 imported by backend or frontend (backend has its own entity classes) |
| Bulk operation types | `api-contracts.ts` | `BulkOperationRequest`, `BulkOperationResponse` — no implementation |

## 10.3 Dead Code

| Code | Location | Reason |
|------|----------|--------|
| `hasNext`/`hasPrevious` in pagination | ProjectController, AssignmentController | Missing from their pagination metadata (present in all others) |
| Mock data in `api.ts` | `services/api.ts:80-117` | 4 mock projects, 5 mock branches, 3 mock states — only used when backend offline |
| Sandbox admin hardcoded | `App.tsx:25-29` | Always returns "Sandbox Admin" profile |
| 6 placeholder sidebar items | `Sidebar.tsx` | Navigate to routes that show "Coming in Phase X" |

## 10.4 TODO/FIXME Comments

**None found** in any source file. This is unusual for a project of this size and suggests incomplete code review.

## 10.5 Hardcoded Values

| Value | Location | Recommended |
|-------|----------|-------------|
| JWT secret | `.env` | Should be env variable, not committed |
| DB_SYNCHRONIZE=true | `.env` | Must be false in production |
| `'fapoms_token'` | `frontend/src/App.tsx:42,55,63` | Typo — brand is FAPOMS |
| `'SBI Corporate'` | `frontend/src/pages/Projects.tsx:268` | Hardcoded client name fallback |
| `distanceKm: 4.8` | `frontend/src/pages/PlanningWorkspace.tsx:360` | Hardcoded mock recommendation |
| `admin/admin123` | `frontend/src/pages/Login.tsx:69-76` | Hardcoded sandbox credentials |
| `['Maharashtra', 'Gujarat', 'Karnataka']` | `frontend/src/pages/Branches.tsx:59` | Hardcoded state filters |
| Default working days [1,2,3,4,5] | `client.service.ts:37` | Reasonable default |
| Default radius 50.0 | `client.service.ts:38` | Reasonable default |
| bcrypt rounds 12 | `user.service.ts:52` | Reasonable default |
| bcrypt rounds 10 | `auth.service.ts:148` | Inconsistent with user service (12 rounds) |

## 10.6 Technical Debt Summary

| Category | Items |
|----------|-------|
| **No tests** | Zero test files across entire project. Jest configured but not used |
| **No migrations** | `synchronize: true` in development. No migration files |
| **No CI/CD** | No GitHub Actions, no pipeline configuration |
| **No Docker** | No containerization for local development |
| **Committed secrets** | JWT secret in `.env` committed to VCS |
| **Deprecated API usage** | `findByIds()` in `user.service.ts` (TypeORM deprecation) |
| **Eager loading risk** | `{eager: true}` on RoleEntity→PermissionEntity can cause N+1 |
| **Inconsistent RBAC** | Project, Assignment, Planning controllers have no role restrictions |
| **Inconsistent pagination** | 2 of 8 list endpoints return incomplete pagination metadata |
| **Frontend bypasses API client** | Write operations use raw `fetch` instead of `api.request()` |
| **React Query unused** | Library configured but all components use manual fetch |
| **State machines unenforced** | Complete state maps defined but never validated in services |
| **Inconsistent bcrypt rounds** | 12 in UserService, 10 in AuthService |
| **No error boundaries** | Frontend has zero error boundaries or Suspense fallbacks |
| **No Docker setup** | Cannot run without manually configuring PostgreSQL+PostGIS |

---

# Phase 11: Dependency Analysis

## 11.1 Module Dependency Graph (Backend)

```
AppModule
├── ConfigModule (isGlobal)
├── TypeOrmModule (database.config)
├── AuthModule
│   └── UserEntity, RefreshTokenEntity, JwtModule
├── UserModule
│   └── UserEntity, RoleEntity, PermissionEntity
├── AuditModule (Global)
│   └── AuditEventEntity
├── ClientModule
│   └── ClientEntity, ClientConfigurationEntity
├── BranchModule
│   ├── ClientModule
│   ├── BranchEntity
│   └── GeoStateEntity, GeoDistrictEntity, GeoCityEntity (inline)
├── AssayerModule
│   └── AssayerEntity
├── HolidayModule
│   └── HolidayEntity
├── ZoneModule
│   └── ZoneEntity
├── PlanningModule
│   ├── BranchEntity (direct TypeOrm.forFeature)
│   └── AssayerEntity (direct TypeOrm.forFeature)
├── ProjectModule
│   └── ProjectEntity, ProjectBranchEntity
└── AssignmentModule
    ├── AssignmentEntity, ProjectBranchEntity
    └── HolidayModule (for HolidayService)

Cross-cutting:
  AuditService ← injected into:
    AuthService, UserService, ClientService, BranchService,
    AssayerService, HolidayService, ZoneService, ProjectService,
    AssignmentService
```

## 11.2 Circular Dependencies

**None detected.** The module dependency graph is acyclic.

## 11.3 Coupling Analysis

| Module | Inbound Dependencies | Outbound Dependencies | Coupling |
|--------|---------------------|----------------------|----------|
| AuthModule | None (leaf) | UserEntity, JwtModule | Low |
| UserModule | AuthModule (JWT) | PermissionEntity | Low |
| AuditModule | All services | None | Medium (injected everywhere) |
| ClientModule | None (leaf) | None | Low |
| BranchModule | ClientModule | 3 Geo entities | Medium |
| AssayerModule | None (leaf) | None | Low |
| HolidayModule | None (leaf) | None | Low |
| ZoneModule | None (leaf) | None | Low |
| PlanningModule | None (leaf) | BranchEntity, AssayerEntity (direct) | Medium |
| ProjectModule | None (leaf) | ProjectBranchEntity | Low |
| AssignmentModule | HolidayModule | ProjectBranchEntity | Medium |

## 11.4 Unnecessary Dependencies

1. **PlanningModule directly imports BranchEntity + AssayerEntity** — Should import BranchModule/AssayerModule instead. This bypasses module encapsulation
2. **BranchModule imports 3 geo entities directly** — Should import a GeoModule instead
3. **RoleModule imports PermissionEntity** — Fine, but eager loading adds unnecessary coupling

---

# Phase 12: Implementation Completeness

## 12.1 Overall Score: **~35%**

| Phase | Description | Completion | Rationale |
|-------|-------------|------------|-----------|
| **Phase 1** | Foundation (auth, RBAC, audit, design system) | **95%** | Auth, RBAC, audit complete. Missing: migrations, Docker, CI/CD, tests |
| **Phase 2** | Master Data (client, branch, assayer, holiday, zone) | **90%** | All modules implemented. Missing: branch update/delete, geo CRUD, holiday update |
| **Phase 3** | Core Planning (project, planning workspace, GIS, coverage) | **25%** | Project CRUD partial, planning service works but feature-incomplete. Missing: full project lifecycle, multi-panel workspace, map integration, coverage service |
| **Phase 4** | Assignment & Scheduling | **15%** | Assignment create + list only. Missing: full lifecycle, scheduling module, communication, negotiation workflow |
| **Phase 5** | Execution & Coordination | **0%** | Not started: documents, workflow, notifications |
| **Phase 6** | Validation & Reporting | **0%** | Not started: validation, dashboards, analytics, reports |
| **Phase 7** | Hardening & Launch | **0%** | Not started: security audit, performance, UAT, deployment |

## 12.2 Feature-Level Completion Table

| Feature | Backend | Frontend | DB | API | Overall |
|---------|---------|----------|----|-----|---------|
| Authentication | 100% | 90% | 100% | 100% | **98%** |
| RBAC Authorization | 100% | 0% | 100% | 60% | **65%** |
| ABAC Authorization | 100% (defined) | 0% | 0% | 0% | **25%** |
| Audit Trail | 100% | 0% | 100% | 100% | **75%** |
| User Management | 100% | 0% | 100% | 100% | **75%** |
| Client Management | 100% | 30% | 100% | 100% | **83%** |
| Branch Management | 90% | 50% | 100% | 80% | **80%** |
| Assayer Management | 100% | 10% | 100% | 100% | **78%** |
| Holiday Calendar | 90% | 0% | 100% | 80% | **68%** |
| Zone Management | 100% | 0% | 100% | 100% | **75%** |
| Project Management | 40% | 40% | 80% | 60% | **55%** |
| Assignment Management | 30% | 30% | 80% | 40% | **45%** |
| Candidate Recommendation | 70% | 40% | 100% | 100% | **78%** |
| Scheduling | 0% | 0% | 0% | 0% | **0%** |
| Communication Tracking | 0% | 0% | 0% | 0% | **0%** |
| Document Management | 0% | 0% | 0% | 0% | **0%** |
| Validation Coordination | 0% | 0% | 0% | 0% | **0%** |
| Coverage Analysis | 0% | 10% | 0% | 0% | **3%** |
| Dashboard & Analytics | 0% | 5% | 0% | 0% | **1%** |
| Reporting | 0% | 0% | 0% | 0% | **0%** |
| Notifications | 0% | 0% | 0% | 0% | **0%** |
| GIS (map visualization) | 0% | 0% | 100% | 0% | **25%** |

---

# Phase 13: Implementation Inventory

## 13.1 Master Inventory Table

| # | Feature | Description | Frontend | Backend | Database | API | Permissions | Workflow | Status | % |
|---|---------|-------------|----------|---------|----------|-----|-------------|----------|--------|---|
| 1 | Login | Username/email + password auth | Login.tsx | AuthService | refresh_tokens | 4 | None (public) | Auth | ✅ | 98% |
| 2 | JWT Refresh | Token rotation | Not used | AuthService | refresh_tokens | 1 | None (public) | Auth | ✅ | 90% |
| 3 | Logout | Token revocation | Header.tsx | AuthService | refresh_tokens | 1 | JWT | Auth | ✅ | 100% |
| 4 | Account Lockout | 5 failures, 15 min lock | Not used | AuthService | users.locked_until | — | — | Auth | ✅ | 100% |
| 5 | RBAC Roles | Role-based access | Sidebar (not used) | RolesGuard | roles | — | Controller-level | AuthZ | ✅ | 65% |
| 6 | ABAC Permissions | Granular permissions | Not used | PermissionsGuard | permissions | — | Unused | AuthZ | 🟡 | 25% |
| 7 | Audit Trail | Append-only event log | Not displayed | AuditService | audit_events | — | — | Cross | ✅ | 75% |
| 8 | User CRUD | Manage users | Not implemented | UserService | users | 6 | ADMIN | User | ✅ | 75% |
| 9 | Client CRUD | Manage clients | Not implemented | ClientService | clients, client_configurations | 5 | ADMIN/OPS_MGR | Client | ✅ | 83% |
| 10 | Branch CRUD | Manage branches | Branches.tsx | BranchService | branches | 4 | ADMIN/OPS_MGR | Branch | 🟡 | 80% |
| 11 | Branch Excel Import | Bulk import with mapping | Branches.tsx | BranchService | branches | 1 | ADMIN/OPS_MGR | Import | 🟡 | 80% |
| 12 | Assayer CRUD | Manage assayers | Not implemented | AssayerService | assayers | 5 | ADMIN/OPS_MGR | Assayer | ✅ | 78% |
| 13 | Holiday Calendar | Manage holidays | Not implemented | HolidayService | holidays | 4 | ADMIN | Holiday | 🟡 | 68% |
| 14 | Zone CRUD | Manage zones | Not implemented | ZoneService | zones | 5 | ADMIN/OPS_MGR | Zone | ✅ | 75% |
| 15 | Project Create | Create audit project | Projects.tsx | ProjectService | projects | 1 | NONE (missing) | Project | 🟡 | 30% |
| 16 | Project List | List projects | Projects.tsx | ProjectService | projects | 1 | NONE (missing) | Project | ✅ | 70% |
| 17 | Project Branches | View project branches | PlanningWorkspace | ProjectService | project_branches | 1 | NONE (missing) | Project | 🟡 | 30% |
| 18 | Recommendations | PostGIS proximity search | PlanningWorkspace | PlanningService | branches, assayers | 1 | NONE (missing) | Planning | 🟡 | 78% |
| 19 | Assignment Create | Create assignment | PlanningWorkspace | AssignmentService | assignments | 1 | NONE (missing) | Assignment | 🟡 | 30% |
| 20 | Assignment List | List assignments | Not implemented | AssignmentService | assignments | 1 | NONE (missing) | Assignment | 🟡 | 40% |
| 21 | Dashboard | Operational dashboard | Dashboard.tsx (mock) | Not implemented | — | — | — | Dashboard | ❌ | 1% |
| 22 | Geo Reference Data | State/District/City | Not implemented | No CRUD service | geo_states/districts/cities | 0 | — | Reference | 🟡 | 50% |
| 23 | Design System | CSS theme, components | index.css | — | — | — | — | UI | ✅ | 90% |
| 24 | State Machines | Entity lifecycle enforcement | Not used | Not used | — | — | — | Business | ❌ | 10% |

**Legend:** ✅ Complete (80-100%) | 🟡 Partial (20-80%) | ❌ Not started (0-20%)

---

# Phase 14: Missing Pieces

## 14.1 Referenced But Not Implemented

### Frontend Elements Referenced But Non-Functional

| Element | Component | Issue |
|---------|-----------|-------|
| "Export CSV" button | Projects.tsx | No onClick handler |
| "Detail" button per project | Projects.tsx | No onClick handler |
| "View All" button | Dashboard.tsx | No onClick handler |
| Organization selector | Header.tsx | Shows "Axis Bank Project" hardcoded, no dropdown |
| Global search input | Header.tsx | Placeholder only, no search logic |
| Notification bell | Header.tsx | Static red dot, no notifications |
| State filter dropdown | Branches.tsx | Options hardcoded, should be dynamic |
| Phone "Call" link | PlanningWorkspace.tsx | Uses `tel:` protocol (functionally correct but UX incomplete) |
| Negotiation modal | PlanningWorkspace.tsx | Submits assignment via direct fetch, no validation feedback |

### Backend CRUD Operations Missing

| Module | Missing Endpoints |
|--------|------------------|
| Branch | `PUT /branches/:id`, `DELETE /branches/:id` |
| Holiday | `PUT /holidays/:id` |
| Project | `PUT /projects/:id`, `DELETE /projects/:id`, state transition endpoints |
| Assignment | `PUT /assignments/:id/status`, `PUT /assignments/:id/cancel`, state transition endpoints |
| Geo | All CRUD endpoints for states, districts, cities |
| User | Password change/reset endpoints |

### Database Tables Referenced in Specs But Not Created

| Table | Spec Reference | Status |
|-------|---------------|--------|
| `schedules` | Part 2 §7, Part 7 §5 | Not created |
| `communications` | Part 3 §9, Part 7 | Not created |
| `travels` | Part 3 §6, Part 7 | Not created |
| `documents` | Part 3 §8, Part 7 | Not created |
| `validation_cases` | Part 3 §10, Part 7 | Not created |
| `ocr_results` | Part 3 §10 | Not created |
| `notifications` | Part 5 §13 | Not created |
| `user_preferences` | Part 7, Part 10 | Not created |
| `user_sessions` | Part 8 | Not created (uses refresh_tokens instead) |

### Business Rules Referenced But Not Enforced

| Rule | Spec Reference | Where It Should Be |
|------|---------------|-------------------|
| Project lifecycle state transitions | Part 6 §3 | project.service.ts |
| ProjectBranch lifecycle state transitions | Part 6 §4 | project-branch entity/service |
| Assignment lifecycle state transitions | Part 6 §5 | assignment.service.ts |
| Completed project is read-only | Part 8 §10 | Guard on project controller |
| Accepted assignments are locked | Part 2 §6 | Guard on assignment controller |
| Negotiation workflow (fee/availability) | Part 2 §4 | assignment.service.ts (currently auto-accepts) |
| Coverage calculation (multi-tier) | Part 3 §7 | coverage.service.ts (not created) |
| Scheduling conflict resolution | Part 5 §6 | scheduling.service.ts (not created) |
| Document status lifecycle | Part 6 §6 | document.service.ts (not created) |
| Validation status lifecycle | Part 6 §7 | validation.service.ts (not created) |

### Features Referenced in Sidebar But Not Implemented

| Menu Item | Route | Current State |
|-----------|-------|---------------|
| Assignments | /assignments | Placeholder: "Coming in Phase 4" |
| Scheduling | /scheduling | Placeholder: "Coming in Phase 4" |
| Documents | /documents | Placeholder: "Coming in Phase 5" |
| Validation | /validation | Placeholder: "Coming in Phase 6" |
| Reports | /reports | Placeholder: "Coming in Phase 6" |
| Administration | /admin | Placeholder: "Coming in Phase 1" (ironically) |

## 14.2 Configuration & Infrastructure Gaps

| Item | Status |
|------|--------|
| Dockerfile | Not present |
| docker-compose.yml | Not present |
| CI/CD pipeline | Not present |
| Database migration files | Not present |
| ESLint configuration | Referenced but files not confirmed |
| Unit tests (spec files) | Zero files |
| Integration tests | Zero files |
| E2E tests | Zero files |
| API client SDK | Not generated |
| Postman/Insomnia collection | Not present |
| Production environment config | Not present (only `.env` for dev) |
| Logging configuration | Not structured (console only) |
| Monitoring/health checks | `GET /auth/status` only (basic) |
| Rate limiting | Not implemented |
| CORS config | Basic (FRONTEND_URL only) |

---

# Phase 15: Final Summary

## 15.1 What Exists

A NestJS/NPM workspaces monorepo with:
- **19 database tables** covering users, roles, permissions, clients, branches, assayers, projects, assignments, zones, holidays, geo reference data, and audit events
- **36 REST API endpoints** across 10 modules, all under `/api/v1`
- **13 frontend files** creating a dark-themed SPA with login, dashboard, projects, branches, and planning workspace pages
- **Shared package** with 17 enums, 22 interfaces, 15 API contracts, and 5 state machine definitions
- **Seed script** populating 2 clients, 3 assayers, 4 roles, 25 permissions, 3 states, and geo reference data
- **PostGIS spatial queries** for proximity-based candidate recommendations
- **Excel import** with per-client dynamic column mapping
- **JWT authentication** with refresh token rotation and account lockout
- **RBAC guards** on 7 of 10 controllers
- **Append-only audit trail** on every business operation
- **Soft delete** on all business entities
- **Optimistic locking** via version columns

## 15.2 What Works

| Feature | Reliability |
|---------|-------------|
| Authentication (login/logout/refresh) | Fully functional |
| User management (CRUD + roles) | Backend only (no frontend) |
| Client management (CRUD + config) | Backend only (no frontend) |
| Assayer management (CRUD) | Backend only (no frontend) |
| Zone management (CRUD) | Backend only (no frontend) |
| Holiday management + date check | Backend only (no frontend) |
| Branch CRUD + Excel import | Backend works, frontend reads work (writes require live backend) |
| Project create + list | Backend + frontend (writes require live backend) |
| Candidate recommendations (PostGIS) | Backend + frontend display (mock fallback in sandbox) |
| Assignment create (auto-accept) | Backend + frontend (writes require live backend) |
| Audit trail (append-only events) | Backend only (no frontend display) |

## 15.3 What Is Partial

| Feature | Limitation |
|---------|------------|
| Project management | No update, delete, lifecycle transitions, or state enforcement |
| Assignment management | No update, cancellation, completion, or negotiation workflow |
| Candidate recommendations | Distance-only ranking; no workload, history, or configurable scoring |
| Planning workspace | 2 panels instead of 4; no map integration; mock coverage display |
| RBAC on API | Missing on Project, Assignment, and Planning controllers |
| ABAC | PermissionsGuard defined but never applied to any endpoint |
| Shared package | State machines defined but never imported/enforced anywhere |

## 15.4 What Is Missing (Business-Critical)

1. **All tests** — Zero test files despite Jest being configured
2. **Database migrations** — `synchronize: true` is a dev-only pattern
3. **State machine enforcement** — The entire state-driven lifecycle is unimplemented
4. **Negotiation workflow** — Assignments skip from "no assignment" to "ACCEPTED"
5. **Scheduling module** — No schedule entity, no calendar view, no conflict resolution UI
6. **Document management** — No file upload, PDF generation, or document tracking
7. **Validation workflows** — No OCR integration, human review, or approval flow
8. **Coverage service** — No real-time or calculated coverage metrics
9. **Communication tracking** — No phone/WhatsApp/email log
10. **Notifications** — In-app, email, or WhatsApp notifications
11. **Docker setup** — Cannot run without manual PostgreSQL+PostGIS setup
12. **Dashboard** — Entirely mock data, no backend integration

## 15.5 Architecture Overview (Actual)

```
┌──────────────────────────────────────────────────────┐
│                    Frontend (React 19 + Vite 6)       │
│  ┌──────────┬──────────┬──────────┬────────────────┐  │
│  │ Login    │Dashboard │ Projects │ Branches       │  │
│  │ (sandbox)│ (mock)   │ (CRUD)   │ (list+import)  │  │
│  ├──────────┴──────────┴──────────┴────────────────┤  │
│  │ PlanningWorkspace  (2-panel, recommendations)    │  │
│  └─────────────────────────────────────────────────┘  │
│                   │ HTTP /api/v1                       │
│                   ▼                                    │
│  ┌──────────────────────────────────────────────────┐  │
│  │         Backend (NestJS 11 + TypeORM)             │  │
│  │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌────────┐ │  │
│  │  │ Auth │ │ User │ │Client│ │Branch│ │ Assayer│ │  │
│  │  └──────┘ └──────┘ └──────┘ └──────┘ └────────┘ │  │
│  │  ┌──────┐ ┌──────┐ ┌──────┐ ┌────────┐ ┌──────┐ │  │
│  │  │Project││Holiday││ Zone ││Planning││Assign │ │  │
│  │  └──────┘ └──────┘ └──────┘ └────────┘ └──────┘ │  │
│  │  ┌──────────────────────────────────────────────┐ │  │
│  │  │         AuditService (Global)                │ │  │
│  │  └──────────────────────────────────────────────┘ │  │
│  └──────────────┬───────────────────────────────────┘  │
│                 │                                      │
│                 ▼                                      │
│  ┌──────────────────────────────────────────────────┐  │
│  │              PostgreSQL + PostGIS                  │  │
│  │  19 tables: users, roles, permissions, clients,   │  │
│  │  branches, assayers, projects, project_branches,  │  │
│  │  assignments, zones, holidays, audit_events,      │  │
│  │  refresh_tokens, geo_*, client_configurations     │  │
│  └──────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

## 15.6 Current Module Map

```
                 ┌──────────────┐
                 │   AppModule  │
                 └──────┬───────┘
        ┌───────────────┼───────────────────┐
        ▼               ▼                   ▼
  ┌─────────┐    ┌──────────┐      ┌──────────────────┐
  │AuthModule│   │UserModule│      │ AuditModule      │
  │  JWT +   │   │  Roles + │      │ (Global)         │
  │ Passport │   │ Perms    │      │ Append-only log  │
  └─────────┘    └──────────┘      └──────────────────┘
        │               │
        ▼               ▼
  ┌─────────┐    ┌──────────┐      ┌──────────────────┐
  │ClientMod│    │BranchMod │      │  AssayerModule   │
  │  CRUD + │◄───│ CRUD +   │      │  CRUD + PostGIS  │
  │  Config │    │ Excel    │      └──────────────────┘
  └─────────┘    └──────────┘
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
  ┌──────────┐ ┌──────────┐ ┌─────────────┐
  │HolidayMod│ │ ZoneMod  │ │ProjectModule │
  │ CRUD +   │ │ CRUD +   │ │ Partial CRUD │
  │ Check    │ │ Client   │ └─────────────┘
  └──────────┘ └──────────┘       │
                                  ▼
  ┌─────────────────────────────────────────┐
  │         AssignmentModule (+Holiday)     │
  │         Create + List only               │
  └─────────────────────────────────────────┘

  ┌─────────────────────────────────────────┐
  │         PlanningModule                   │
  │  BranchRepo + AssayerRepo (direct)      │
  │  PostGIS recommendation engine          │
  └─────────────────────────────────────────┘

Unimplemented modules:
  SchedulingModule, CommunicationModule, DocumentModule,
  ValidationModule, CoverageModule, AnalyticsModule,
  NotificationModule, WorkflowModule
```

## 15.7 Current Database Overview

**19 tables, approximately:**
- 7 master/reference tables (users, roles, permissions, clients, assayers, zones, geo_*)
- 4 transactional tables (projects, project_branches, assignments, client_configurations)
- 2 infrastructure tables (refresh_tokens, audit_events)
- 2 join tables (user_roles, role_permissions)
- 1 calendar table (holidays)
- 3 geo reference tables (geo_states, geo_districts, geo_cities)

**All tables use UUID primary keys and optimistic locking.**

**PostGIS enabled** on branches and assayers for spatial queries.

## 15.8 Current Role Matrix

| Role | Seed Data | Backend Guards | Frontend |
|------|-----------|---------------|----------|
| SUPER_ADMINISTRATOR | Full permissions | All @Roles endpoints | Not enforced |
| ADMINISTRATOR | Full permissions | Most @Roles endpoints | Not enforced |
| OPERATIONS_MANAGER | Limited permissions | Client, Branch, Assayer, Zone | Not enforced |
| OPERATIONS_EXECUTIVE | No permissions | Not in any @Roles | Not enforced |
| VALIDATOR | No permissions | Not in any @Roles | Not enforced |
| Others (5) | Not seeded | Not in any @Roles | Not enforced |

## 15.9 Current API Inventory

**36 total endpoints:**
- 4 authentication (2 public)
- 6 user management (2 require admin)
- 5 client management (3 require admin/ops)
- 4 branch management (2 require admin/ops)
- 5 assayer management (3 require admin/ops)
- 4 holiday management (2 require admin)
- 5 zone management (3 require admin/ops)
- 1 planning (no role restriction)
- 3 project (no role restriction)
- 2 assignment (no role restriction)

## 15.10 Current UI Inventory

**5 pages + 3 components:**
- Login (functional with sandbox fallback)
- Dashboard (100% mock, no backend integration)
- Projects (reads work, writes require live backend)
- Branches (reads work, file upload requires live backend)
- PlanningWorkspace (recommendations display, assignment create requires live backend)
- Layout/Sidebar/Header (functional shell)

## 15.11 Current Project Maturity

| Domain | Backend | Frontend | Integration |
|--------|---------|----------|-------------|
| Auth | Production-ready | Functional | Connected |
| Master Data | Production-ready | Read-only | Partial |
| Planning | Functional | Visual only | Partial |
| Assignments | Skeleton | Modal only | Partial |
| Everything else | Not started | Placeholder | None |

## 15.12 Technical Debt Summary

| Category | Count | Severity |
|----------|-------|----------|
| Missing tests | Entire project | Critical |
| No migrations | 19 tables | Critical |
| Missing RBAC on 3 modules | 3 controllers | High |
| State machines unenforced | 5 defined, 0 used | High |
| Committed secrets | 1 (.env) | High |
| Deprecated API usage | 2 occurrences | Medium |
| Inconsistent pagination | 2 of 8 endpoints | Medium |
| Frontend fetch bypass | 4 direct fetch calls | Medium |
| Eager loading risk | 1 entity | Medium |
| Unused code (shared) | ~60% of shared package | Medium |
| Unused code (backend) | StatefulEntity, PermissionsGuard | Low |
| Inconsistent bcrypt rounds | 10 vs 12 | Low |
| Hardcoded values | 8+ in frontend | Low |

## 15.13 Readiness Score

| Category | Score | Interpretation |
|----------|-------|---------------|
| **Backend Completeness** | 45/100 | Core infrastructure complete, most business logic missing |
| **Frontend Completeness** | 20/100 | Shell + 3 reading pages, 0 writing pages work reliably |
| **Database Completeness** | 45/100 | Schema matches ~45% of specified requirements |
| **API Completeness** | 40/100 | 36 endpoints, but 25 not called from frontend |
| **Testing Coverage** | 0/100 | Zero tests across entire project |
| **Infrastructure Readiness** | 10/100 | No Docker, no CI/CD, no migrations |
| **Security Hardening** | 30/100 | Auth works, but secrets committed, no rate limiting, no ABAC |
| **Overall Readiness** | **27/100** | **Not production-ready. Suitable for development/demo only.** |
