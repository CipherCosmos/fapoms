# Scale & Robustness Hardening — Consolidation Manifest

**Purpose:** review-and-commit checklist for the scale/robustness/assessment work done in this
session ("Track A"). The working tree currently interleaves **three** efforts — commit them as
separate, reviewable units:

- **Track A (this doc)** — scale, performance, observability, reliability, security, and the
  cheap/safe items from `docs/architecture-assessment.md`.
- **Track B** — the assessment's large ADRs: tenant isolation (`infrastructure/tenancy/`),
  the `ResponseInterceptor` (`infrastructure/http/response.interceptor.ts`), and billing
  transactions + `FOR UPDATE` locking (`modules/billing-engine/**`). **Not covered here.**
- **Mobile/validation WIP** — `packages/mobile/**`, validation changes. Pre-existing; untouched
  by Track A.

Everything in Track A is `tsc`-clean and unit-tested where testable (see §5). **None of it
touches billing.**

---

## 1. New environment variables (see `.env.production.example`)

| Var | Default | Purpose |
|---|---|---|
| `DB_POOL_MAX` / `DB_POOL_MIN` | 20 / 2 | Per-replica pool size (× replicas < Postgres max; use PgBouncer beyond a few). |
| `DB_CONN_TIMEOUT_MS` / `DB_IDLE_TIMEOUT_MS` | 10000 / 30000 | Pool timeouts. |
| `DB_STATEMENT_TIMEOUT_MS` | 30000 | Kills a runaway query before it pins a connection. |
| `DB_IDLE_TX_TIMEOUT_MS` | 60000 | Reaps idle-in-transaction sessions. |
| `DB_RETRY_ATTEMPTS` / `DB_RETRY_DELAY_MS` | 10 / 3000 | Survive a DB restart at boot. |
| `RBAC_CACHE_TTL_SECONDS` | 30 | TTL for the cached auth principal. |
| `PROCESS_ROLE` | `all` | `api` \| `worker` \| `all` — scale request handling and jobs separately. |
| `METRICS_TOKEN` | (unset) | Bearer token for `GET /api/v1/metrics`. Unset = open (restrict at network). |
| `BULL_BOARD_USER` / `BULL_BOARD_PASSWORD` | (unset) | Basic-auth for `/bull-board`. Unset in prod = dashboard not mounted. |
| `REDIS_PASSWORD` | (unset) | Recommended in production. |

Redis is now on the hot path (queues, cache, throttle, Socket.IO adapter, upload sessions) —
size and monitor accordingly. Multi-node realtime needs sticky sessions if the websocket
`polling` transport is enabled.

## 2. Migrations to run (in order)

```bash
npm run migration:run --workspace=packages/backend
```

| Timestamp | Migration | Adds |
|---|---|---|
| `1787300000000` | SearchTrigramIndexes | pg_trgm + 17 GIN indexes so global ILIKE search stops full-scanning. |
| `1787400000000` | AppendTableIndexes | Indexes on audit-history/evidence, platform_audit_logs, workflow_history, notifications, billing_history. |
| `1787500000000` | ReferenceDataIndexes | `client_configurations(client_id, effective_from)`, `clients(organization_id)`, `clients(lifecycle_status)`. |

All are idempotent (`IF NOT EXISTS`) and additive (index-only). Column names verified against the entities.

## 3. Changes by theme

### Wave 1 — horizontal-scaling foundation + hot paths
- **Socket.IO Redis adapter** — `infrastructure/realtime/redis-io.adapter.ts` (new); wired in `main.ts`. Room emits now fan out across replicas; safe single-node fallback. *Keystone for >1 backend instance.*
- **DB pool + resilience** — `infrastructure/database/database.config.ts`: env pool sizing, statement/idle-txn timeouts, keepalive, boot retry. `main.ts`: `enableShutdownHooks()`.
- **Trigram search** — `modules/search/search.service.ts` (min-length guard, concurrent per-entity) + migration `1787300000000`.
- **Recommendation geo pre-filter** — `modules/planning/recommendation.engine.ts`: PostGIS radius narrows candidates before scoring, safe fallback to full pool.
- **Append-table indexes + pagination** — migration `1787400000000`; paginated `validation-query` `findAllQueries` + controller; bounded `field-operations` incident query.
- **Frontend code-splitting** — `packages/frontend/src/App.tsx` route-level `React.lazy`; `vite.config.ts` `manualChunks`.

### Wave 2 — per-request cost, observability, isolation
- **RBAC principal cache** — `infrastructure/cache/{cache.service,cache.module}.ts` (new, fault-tolerant Redis JSON cache); `modules/auth/auth.service.ts` serves the 5-join principal from cache (30s TTL, invalidated on `user:updated`/`user:role-changed` + logout).
- **Reference-data caching** — `fee-policy.service`, `geo.controller`, `holiday.service` read-through cache + write-invalidation.
- **Worker/API split** — `main.ts` `PROCESS_ROLE` (worker skips HTTP; api pauses local queues). Default `all` = unchanged.
- **Prometheus metrics** — `infrastructure/observability/**` (new): `MetricsService`, `/metrics` controller, global HTTP-timing interceptor.
- **Throttler tiers** — `modules/planning/planning.controller.ts`: tight per-route limits on optimize/simulate/execute.

### Wave 3 — robustness
- **Presigned uploads** — `modules/document/document.controller.ts`: `POST /documents/upload/presign` + `/finalize` (S3/MinIO direct PUT, staff-only, object-existence + namespace guarded).
- **Idempotency fixes** — `modules/assignment/assignment.service.ts` (`getOrCreateForBranch` on completion); `modules/notifications/notification-delivery.worker.ts` (push double-send guard). *(The billing double-bill race is Track B's `FOR UPDATE` work.)*

### Assessment items (`docs/architecture-assessment.md`)
- **P0 §9.6 — guard `/metrics` + `/bull-board`** — `infrastructure/observability/metrics-auth.guard.ts` (bearer token) + spec; `infrastructure/queue/bull-board.setup.ts` (Basic Auth; not mounted unauth in prod).
- **ADR-005 (core) — error boundary + correlation IDs** — `infrastructure/http/{correlation-id.middleware,global-exception.filter}.ts` (+ filter spec): redacts TypeORM/Redis/S3 errors to a generic 500, preserves HttpException shape, stamps a correlation id. Wired in `main.ts`. *(ResponseInterceptor is Track B's.)*
- **P1 §8 — realtime fails loud** — `infrastructure/realtime/realtime-health.ts` (new); `main.ts` + `health.controller.ts`: `/health/ready` returns `degraded` when `REDIS_HOST` set but the adapter fell back to in-memory.
- **P2 §5.4 — reference-data indexes** — migration `1787500000000`.
- **P3 §8 — dead-letter job monitoring** — `infrastructure/queue/job-failure.monitor.ts` (+ spec): logs exhausted jobs + `jobs_failed_total` metric; role-gated to non-api replicas.
- **P2 (frontend) — typed planning API layer** — `packages/frontend/src/services/planning.ts` (new, additive; wiring the component is a reviewed follow-up).

### App wiring (Track A's edits, co-located with Track B — review both)
- `app.module.ts` — Track A added `CacheModule`, `ObservabilityModule`. (Track B added `TenancyModule`.)
- `main.ts` — Track A: adapter, shutdown hooks, `PROCESS_ROLE`, correlation middleware, exception filter, realtime-health. (Track B: `STORAGE_DRIVER`/burned-secret guards, `ResponseInterceptor`.)
- `health.controller.ts` — Track A: readiness + realtime status. (Track B: `@NoEnvelope`.)
- `database.config.ts` — Track A: pool/timeouts/retry. (Track B: `DB_SYNCHRONIZE` string-vs-boolean fix.)

## 4. Deliberately NOT touched by Track A
- **Billing** (`modules/billing-engine/**`) — Track B's transaction + `FOR UPDATE` work.
- **Tenancy** (`infrastructure/tenancy/**`) — Track B's ADR-001.
- **Mobile** (`packages/mobile/**`) — your active `feat/real-time-sync` WIP.

## 5. Verification status
- Backend `tsc --noEmit`: **clean**.
- Backend tests: **all suites pass with `--forceExit`** (the un-forced hang is a pre-existing open-handle teardown leak, unrelated).
- New Track A unit tests: `global-exception.filter.spec` (3), `metrics-auth.guard.spec` (4), `job-failure.monitor.spec` (4), plus updated `auth.service`/`fee-policy`/`recommendation.engine`/`billing-engine` specs for the new constructor deps.
- Frontend `tsc --noEmit`: **clean**.
- **Not runtime-verified** (needs a live stack / smoke test): the migrations applied against a real DB, multi-replica realtime end-to-end, and the presigned-upload round trip (bucket CORS required for browser PUT).

## 6. Known follow-ups (not done)
- ADR-005 tail: propagate `correlationId` into Bull jobs + convert `console.*` to structured `Logger`.
- Wire `PlanningWorkspace.tsx` onto `services/planning.ts` (compile-verifiable; needs a planning-page smoke test).
- The big ADRs remain Track B's: aggregate root (002), repository/UoW (003), outbox (004), god-service splits.
- Bucket lifecycle rule to reap orphaned `documents/direct/` objects (presigned-but-not-finalized).
