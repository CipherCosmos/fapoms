# FAPOMS Decision Engine & Enterprise Operational Redesign Report

## 1. Executive Summary & Critical Architectural Assessment
The current FAPOMS architecture is **insufficient** to support the proposed target operational decision platform without a structural redesign. 

### Why the Current Architecture is Insufficient:
- **Synchronous Tight Coupling:** Planning rules, holiday validation, and proximity searches are hardcoded into NestJS services. There is no separation between the REST API controllers and the mathematical scoring logic.
- **Straight-Line Geometrical Bias:** Relying solely on PostGIS coordinate points (`ST_DistanceSphere`) ignores real-world road networks, terrain restrictions, and actual travel times. 
- **Monolithic Database Contention:** Enforcing complex state transition validations, scheduling capacity checks, and concurrent transaction locks on the primary database will cause thread blockages during concurrent operations by multiple planners.

---

## 2. Proposed Target Architecture
To transition FAPOMS from a simple workflow tool into an intelligent planning workspace, we must move to a decoupled, kernel-based architecture:

```
┌────────────────────────────────────────────────────────┐
│                   Planning UI / Map                    │
└──────────────────────────┬─────────────────────────────┘
                           │ API Gateway
┌──────────────────────────▼─────────────────────────────┐
│                 Core Operations Kernel                 │
│  (Tenant Management, State machines, Audit ledger)     │
└──────────────────────────┬─────────────────────────────┘
                           │ Event Bus (Redis / BullMQ)
┌──────────────────────────┼─────────────────────────────┐
│                 Intelligent Engines                    │
│ ┌─────────────────┐ ┌─────────────────┐ ┌────────────┐ │
│ │  Routing Engine │ │ Decision Engine │ │ Rule Engine│ │
│ │  (HERE / OSMR)  │ │ (OptaPlanner)   │ │ (Metadata) │ │
│ └─────────────────┘ └─────────────────┘ └────────────┘ │
└────────────────────────────────────────────────────────┘
```

---

## 3. High-Priority Architectural Gaps

### 3.1 Immediate Redesigns (Do Now)
- **Engine Isolation:** Extract the hardcoded recommendation logic from `planning.service.ts` into a standalone `RecommendationCalculator` service.
- **Routing Engine Abstraction:** Define an interface for route calculation to decouple PostGIS straight-line math:
  ```typescript
  export interface RoutingProvider {
    calculateDistanceMatrix(origins: Point[], destinations: Point[]): Promise<DistanceMatrix>;
  }
  ```
- **Metadata-Driven Workflows:** Move the state transition validations out of transactional service methods and validate them against database configurations.

### 3.2 Deferred Optimizations
- **AI recommendation models:** Can be deferred until the database has collected historical assignment completion and rejection logs.
- **Horizontally scaled workers:** Can be deferred until active planners scale beyond 50 concurrent sessions.

---

## 4. Priority Evolution Roadmap

### Milestone 1: Routing Abstraction & Decoupling (Month 1)
- Create the `RoutingProvider` interface.
- Implement an OpenStreetMap (OSRM) service adapter.

### Milestone 2: Multi-Factor Scoring Engine (Month 2)
- Rebuild the recommendation engine to fetch and combine scoring weights (distance, historical SLA, active workload, cost) from client JSONB configurations.

### Milestone 3: Background Worker Queues (Month 3)
- Introduce BullMQ to process planning calculations asynchronously.
