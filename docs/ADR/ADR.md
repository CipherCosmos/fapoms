# FAPOMS Architecture Decision Records (ADR)

## ADR-001: Modular Monolith Architecture
* **Status:** Approved
* **Context:** FAPOMS manages field audit lifecycles with multiple roles (Super Admin, Validator, Assayer). A microservices architecture would introduce unnecessary networking overhead, operational complexity, and eventual consistency issues during state synchronization.
* **Decision:** We use a modular monolith architecture organized by domain boundaries within a single NestJS backend (`packages/backend/src/modules/`) and share core validation helpers via a shared library (`packages/shared/src/`).
* **Consequences:** Easier transaction management across modules, lower deployment complexity, clear code isolation.

## ADR-002: Spatial Geometry Layer (PostGIS)
* **Status:** Approved
* **Context:** Assayer assignments depend on geographic proximity to branches. Traditional coordinate queries using basic SQL floats cannot perform efficient range searches or distance sorting on thousands of locations.
* **Decision:** Enforce PostGIS geometry types (`GEOMETRY(Point, 4326)`) on branches and assayers, using `ST_DistanceSphere` spatial operations for planning calculations.
* **Consequences:** Requires PostGIS extension enabled in PostgreSQL. Highly optimized geographic recommendations.

## ADR-003: Transaction-Locked Planning Commitments
* **Status:** Approved
* **Context:** Double-booking assayers or creating partial assignment records when state transitions fail leads to database corruption and scheduling conflicts.
* **Decision:** All critical planning workspace updates must be wrapped in `DataSource.transaction` blocks.
* **Consequences:** Ensures ACID reliability for multi-table updates.
