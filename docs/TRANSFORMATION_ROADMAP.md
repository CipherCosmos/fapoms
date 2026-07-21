# FAPOMS Architectural Transformation Roadmap

This document maps the approved target FAPOMS Enterprise Audit Operations & Decision Management Platform architecture to the existing codebase and defines our incremental, safe migration path.

---

## 1. Architectural Mapping & Gap Analysis

| Target Engine / Capability | Existing Codebase State | Reusable Components | Key Architectural Gaps | Migration & Decoupling Strategy | Complexity |
|---|---|---|---|---|---|
| **1. Routing Engine** | None. In `planning.service.ts`, straight-line PostGIS calculations are executed. | SQL fallback (State/District match) | No routing providers (OSRM, HERE, Google Maps) integrated. No matrix API. | Define a pluggable `RoutingProvider` interface. Implement local `OSRM` and `PostGIS` fallback adapters. | Medium |
| **2. Rule Engine** | Hardcoded constraints in `assignment.service.ts` and `scheduling.service.ts` | Validation transition schema helper in `@fapoms/shared` | Validation and business rule evaluation (e.g. licensing constraints) are hardcoded. | Build a metadata-driven Rule Engine validating configuration rules loaded from JSON structures in the database. | High |
| **3. Recommendation Engine (Multi-Factor)** | Distance-only raw SQL in `planning.service.ts` | Proximity SQL syntax | Lacks cost calculation, workload limits, capacity matrices, and weighting config. | Introduce a `ScoringStrategy` interface that runs calculations on OSRM distance, workload metrics, and fee structures. | High |
| **4. Cost Engine** | Simple fee columns on `AssignmentEntity` | `agreedFee` and `proposedFee` | Lacks assayer cost items (base fee, rates, allowances) and budget control checks. | Create `AssayerCommercialProfileEntity` and `CostService` to calculate expected assignment costs. | Medium |
| **5. Workflow Engine** | Bypassed state-machine constraints and raw entity saves in controllers. | `@fapoms/shared` transitions matrix | Hardcoded transitions logic inside NestJS service methods. | Create a state machine processor evaluating state mutations against a configured transition matrix table. | High |

---

## 2. Milestone Dependencies & Phase Structure

```
                  ┌──────────────────────────────────────────────┐
                  │ Phase 1: Routing & Commercial Base           │
                  │ (Commercial Profiles, OSRM/PostGIS Providers)│
                  └──────────────────────┬───────────────────────┘
                                         │
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │ Phase 2: Multi-Factor Scoring & Config Rules │
                  │ (Decision Engine, JSON Rule engine)          │
                  └──────────────────────┬───────────────────────┘
                                         │
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │ Phase 3: Dynamic Workflows & Negotiation     │
                  │ (Workflow transition tables, Offer flows)    │
                  └──────────────────────────────────────────────┘
```

---

## 3. High-Priority Architectural Decisions Requiring Approval

1. **Routing Strategy:** Should the default routing engine call public OpenStreetMap API endpoints (OSRM), or should we use an abstract provider that defaults to PostGIS proximity calculations until a premium client API key (Google Maps / HERE) is provided? *(Recommended: Abstract provider defaulting to PostGIS proximity with mock-OSRM option)*
2. **Workforce Matrix Location:** Should the Assayer operating coordinates be stored as a PostGIS point column inside the database, or as standard latitude/longitude decimals for compatibility with multiple DB backends? *(Recommended: Retain PostGIS column mapping for spatial querying performance)*
