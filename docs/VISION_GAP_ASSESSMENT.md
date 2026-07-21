# FAPOMS Enterprise Vision Gap Assessment Report

## 1. Executive Summary
This report evaluates the FAPOMS architecture against its long-term enterprise product vision: supporting hundreds of client organizations, configurable state-machine logic, AI-assisted planning models, horizontal scaling, and multi-tenant isolation. 

---

## 2. Target vs. Current Architecture Gap Analysis

### 2.1 Core Planning & Scheduling Engine
* **Target Vision:** Configurable, multi-criteria travel and route optimizer, workload balancer, SLA optimizer, and AI-assisted allocation recommendations.
* **Current Implementation:** Proximity-only matching (`ST_DistanceSphere` in PostGIS) hardcoded in `planning.service.ts`.
* **Architectural Gap:** **Strategic Bottleneck.** Current planning calculations run synchronously inside NestJS services. Adding complex scoring weights, multi-tenant rules, or route graphs requires refactoring the service logic.
* **Verdict:** Requires architectural decoupling. The recommendation engine should be isolated into a stateless calculator pattern, retrieving dynamically seeded rules from a configurable metadata database.

### 2.2 Workflow & State Rules Engine
* **Target Vision:** Configurable workflows where Product Owners can define and execute state transitions, approval hierarchies, and notifications without modifying backend code.
* **Current Implementation:** Hardcoded state transitions in backend services using simple entity saves and hardcoded enums (e.g. `UserStatus`, `ValidationStatus`).
* **Architectural Gap:** **Strategic Debt.** Changing lifecycles or validation sequences forces manual code changes, database migrations, and updates in frontend layout mappings.
* **Verdict:** Needs a unified database-driven Workflow Engine. State transitions must be validated against transition graph tables rather than hardcoded service guards.

### 2.3 Scalability & Event-Driven Processing
* **Target Vision:** Horizontally scalable processing for millions of audit logs, background document parsing, and third-party integrations using event-driven architectures.
* **Current Implementation:** Synchronous request-response loops in HTTP controller endpoints. OCR boundaries call services sequentially.
* **Architectural Gap:** **Tactical Debt.** Thread-blocking during large Excel imports or PDF processing.
* **Verdict:** Introduce BullMQ and an event dispatcher (e.g. NestJS EventEmitter or RabbitMQ) to handle document processing asynchronously.

---

## 3. Chief Architect Final Verdict

1. **Decisions to Keep:** The monorepo structure, TypeORM migrations, PostGIS geometry bindings, and short-lived access/refresh token models are excellent patterns.
2. **First-Year Bottlenecks:** Synchronous Excel parsing and document indexing will cause connection time-outs as client branches scale.
3. **Major Rewrite Triggers:** Transitioning to a true multi-tenant model (where client data is isolated via schema-level segregation or tenant ID filters) will require database-wide query changes.
4. **Immediate Redesign Candidate:** Decouple hardcoded status state machines into a metadata-driven workflow service validator.
5. **Alternative Design Choice:** Starting today, I would design a micro-kernel architecture with event-driven background queues from the start, decoupling the heavy geographical proximity calculator and document OCR processing into worker containers.
