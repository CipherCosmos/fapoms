# FAPOMS Release Roadmap

This roadmap defines the implementation milestones for FAPOMS.

---

## 1. Milestones

### Milestone 1: Foundation (Release 1.0)
- **Objectives:** Establish project configuration, DB schema, basic auth, and core endpoints.
- **Status:** **Completed**
- **Exit Criteria:** Core NestJS backend compiles, database seeder is active.

### Milestone 2: Planning & Hardening (Release 1.1)
- **Objectives:** Integrate Leaflet Interactive Map, purge all mock fallbacks, implement PostGIS recommendation queries, and enforce transaction guards.
- **Status:** **Completed**
- **Exit Criteria:** Zero frontend fallback mode dependencies, all dashboard metrics live.

### Milestone 3: Background Jobs & Scaling (Release 1.2)
- **Objectives:** Asynchronous worker processing for uploads (Excel), enhanced validator reviews.
- **Status:** **In Progress**
- **Exit Criteria:** Large branch lists import without thread lockups.

### Milestone 4: Client Portal & Analytics (Release 1.3)
- **Objectives:** Implement read-only portals for external bank managers and summary utilization analytics.
- **Status:** **Not Started**
- **Exit Criteria:** Bank portal dashboard views compile and execute cleanly.
