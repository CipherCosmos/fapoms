# FAPOMS Technical Debt Register

## 1. Overview
This register tracks identified design concessions, architectural compromises, and missing features across FAPOMS.

---

## 2. Debt Catalog

### 2.1 Backend / Security
- **Item ID:** TD-SEC-01
- **Category:** Security
- **Severity:** Medium
- **Description:** Hardcoded `dev-secret` fallback value in auth configurations when `.env` variable `JWT_SECRET` is not specified.
- **Impact:** Weak key risk in misconfigured production containers.
- **Suggested Fix:** Raise an application bootstrap exception if `process.env.JWT_SECRET` is blank while `process.env.NODE_ENV === 'production'`.
- **Dependencies:** None

### 2.2 Testing
- **Item ID:** TD-TEST-01
- **Category:** Testing
- **Severity:** Medium
- **Description:** Missing comprehensive unit and integration test coverage for the React frontend workspace.
- **Impact:** Risk of regression bugs during UI layout adjustments or service transitions.
- **Suggested Fix:** Add Vitest or Jest test suite package configuration to `packages/frontend`.
- **Dependencies:** None

### 2.3 UX / Performance
- **Item ID:** TD-UX-01
- **Category:** Performance / UX
- **Severity:** Low
- **Description:** Large Excel sheet imports (10k+ rows) run synchronously inside NestJS main HTTP thread.
- **Impact:** Heavy CPU load during upload could cause temporary endpoint timeouts.
- **Suggested Fix:** Move branch bulk parsing to background worker threads using BullMQ queues.
- **Dependencies:** BullMQ, Redis

### 2.4 DevOps
- **Item ID:** TD-OPS-01
- **Category:** DevOps
- **Severity:** Low
- **Description:** Missing Docker Compose configuration for dev-environment quickstarts.
- **Impact:** Developers must manually configure local PostgreSQL and PostGIS extensions.
- **Suggested Fix:** Introduce `docker-compose.yml` defining the DB setup alongside NestJS/React apps.
- **Dependencies:** Docker
