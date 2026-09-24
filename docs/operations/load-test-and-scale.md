# Load testing & scaling FAPOMS

Answers the question "can it handle thousands of assayers and hundreds of staff, live?" with a
*measured* number instead of a hope. The architecture is already built to scale horizontally
(`PROCESS_ROLE` api/worker split, Redis-adapter Socket.IO, object storage for files, env-driven DB
pool). This is how you prove the ceiling and where to add capacity when you hit it.

## 1. The capacity model

The load is **moderate**, not extreme, and asymmetric:

| Population | Size | Concurrency profile |
|---|---|---|
| Field assayers (mobile) | thousands | Mostly idle; poll/sync every 10–30s; short bursts at check-in/upload |
| Internal staff (web) | hundreds | Read-heavy dashboards + work queues; steady concurrency during work hours |

Realistic **peak concurrency** is low thousands of connections and a few hundred requests/second — well
within one properly-deployed instance of this stack. The point of load-testing is to find *your* real
peak and the first component that bends under it.

## 2. Run the test

`scripts/load-test/fapoms-load.js` (k6) models exactly that mix — staff browsing + mobile sync.

```bash
BASE_URL=https://staging.example.com \
STAFF_USER=... STAFF_PASS=... ASSAYER_USER=... ASSAYER_PASS=... \
k6 run -e STAFF_VUS=150 -e MOBILE_VUS=400 scripts/load-test/fapoms-load.js
```

Run it against **staging with production-like data volume** (seed thousands of assayers, tens of
thousands of assignments) — an empty DB lies, because the bottleneck is query cost against real row
counts and indexes. Ramp `STAFF_VUS`/`MOBILE_VUS` up run-over-run until a threshold breaks; that break
point is your ceiling at the current topology.

**Watch, in parallel with k6's own output:**
- `staff_page_latency` / `mobile_sync_latency` p95 (k6 thresholds fail the run if exceeded).
- **DB**: active connections vs `max`, slow-query log, `pg_stat_activity` waits. This is almost always
  the first wall.
- **API**: the Prometheus metrics this app already exports (p95 latency, event-loop lag), CPU per replica.
- **Redis**: ops/sec, memory, connected clients (it backs the socket adapter, throttler, and caches).
- **Queues**: Bull depth and the dead-letter metric — background work backing up means workers are
  under-provisioned.

## 3. Scale topology — turn "should" into "does"

Everything here is deployment; the code already supports it.

1. **Horizontal API + workers.** Run N `PROCESS_ROLE=api` replicas behind a load balancer and M
   `PROCESS_ROLE=worker` replicas. Autoscale API on CPU/p95 latency and workers on Bull queue depth.
   Socket.IO fans out across replicas through the Redis adapter, so no sticky sessions are required for
   correctness (enable them only if your LB needs them for the WebSocket upgrade).
2. **PgBouncer + read replicas.** The DB is the ceiling. Put **PgBouncer in transaction mode** in front
   of Postgres and point `DB_HOST` at it (the pool is per-replica — N replicas × `DB_POOL_MAX` will
   otherwise exhaust `max_connections`). Add **read replicas** and route heavy reads (dashboards,
   reports, big lists) to them. Keep `statement_timeout` (already env-driven) so one runaway query can't
   pin a connection.
3. **Redis** — managed, with failover. Already on the hot path; size for the socket connection count +
   cache working set.
4. **Object storage + CDN.** Files scale infinitely off the app path (already object storage). Put a CDN
   in front of downloads/derivatives for geographically-spread staff. Bucket default encryption is set
   on boot (`STORAGE_SSE`).
5. **Rate limits** (already tiered per endpoint) protect against one client saturating a node.

## 4. Bottleneck-resolution playbook

Fix in this order — each step buys headroom before the next matters:

1. **Slow queries** (found via the slow-query log under load) → add/adjust indexes, remove N+1s. Several
   hot-path indexes and two N+1s are already fixed; the load test will surface any remaining.
2. **DB connection exhaustion** → PgBouncer (step 2 above). Symptom: latency cliff + "too many clients"
   while CPU is low.
3. **Read contention on the primary** → read replicas for reporting/list endpoints.
4. **API CPU / event-loop lag** → more API replicas (autoscale).
5. **Queue backlog** → more worker replicas; move any remaining heavy synchronous work (bulk import,
   PDF generation, reconciliation) onto Bull if not already.
6. **Socket fan-out cost** → prefer targeted room emits over broadcast-to-all (already the pattern);
   scale Redis.

## 5. Capacity alerts (so you know before users do)

Wire alerts on the metrics the app already exposes:
- API p95 latency > SLO for 5 min; event-loop lag high.
- DB pool utilization > 80%; replication lag > threshold.
- Bull queue depth rising / dead-letter count > 0.
- Socket connection count approaching the per-node budget.
- 5xx rate > 0.5%.

## 5b. Performance audit — findings (2026-08-09)

A code-level cost/performance pass over the hot flows. Fixed items are in the branch; tracked items need
production `EXPLAIN`/load-test evidence before refactoring core queries.

**Fixed**
- **Operations dashboard** — 7 heavy org-wide aggregate queries (funnel, a due-list with two correlated
  `EXISTS` per row, docs, money, capacity, per-project progress, activity) were run *fresh for every user
  on every load*. Now cached cluster-wide via Redis (`DASHBOARD_CACHE_TTL_S`, default 15s); the per-user
  validation counts stay fresh. The single biggest DB-load win under concurrency.
- **Notification unread-count poll** — was 10s *and* socket-driven (redundant). Relaxed to 30s → ~3× fewer
  count queries per signed-in user, no freshness loss.
- **`project_branches.scheduled_date`** — no index despite `WHERE is_active AND scheduled_date BETWEEN …`
  in the dashboard due-list, dispatch worker and scheduling. Added a partial index matching the predicate.
- **Socket-invalidation refetch storm** — `useSocketInvalidation` (mounted on most pages) invalidated broad
  query keys on *every* event; a burst (e.g. a bulk transition of 50 assignments → 50 events) refetched the
  active list + dashboard up to 50×. Now debounced (300ms) so a burst collapses into one refetch.
- **Notification fan-out enqueue** — a push notification to a whole role enqueued one Bull job per recipient
  in a sequential awaited loop (N Redis round-trips). Now a single `addBulk` per fan-out.
- **HR workforce overview** — nine panels / ~22 queries, org-wide, uncached (the /hr page's dashboard).
  Now cached cluster-wide (`HR_OVERVIEW_CACHE_TTL_S`, 30s).
- **Command Room coverage map** — loaded every active branch + assayer and aggregated in memory, uncached.
  Now cached per-filter (`COMMAND_CENTER_CACHE_TTL_S`, 20s).
- **Two `useMemo` render recomputes** — Holidays' date-map and the roles holder-count Map were rebuilt on
  every render (their dep was a freshly-created `data || []`). Source arrays now memoized.
- **Control-centre dashboard summary** — `getDashboardSummary` loaded *every active assignment* into
  memory (full entities, no pagination) purely to count them by status with `.filter().length` and a JS
  reduce. Replaced with four indexed `COUNT`s (parallel) + one `GROUP BY` for the per-project breach
  tally — a handful of numbers off the DB instead of the whole active-assignment table into Node.

**Confirmed already optimized (no change)**
- RBAC per-request principal (5-way join) is Redis-cached with invalidation — the highest-frequency path.
- Recommendation engine uses a `ST_DistanceSphere` geo pre-filter + grouped counts (no per-candidate N+1).
- List endpoints are pagination-bounded with indexed joins; the loaded relations are used by the UI.
- Money paths are idempotent; reference/config data is cached.

**Tracked — need an anti-join refactor + staging smoke-test (not force-fixed)**
- `assignment.findAll` `unscheduledOnly` filter loads *all* active schedule `assignmentId`s into memory
  then `NOT IN (…)`. Replace with `NOT EXISTS (SELECT 1 FROM schedules …)` in a query builder.
- `billing-engine` payable backfill loads all entry `assignmentId`s to build an "already-billed" set —
  acceptable for a batch op, but the anti-join is cleaner at scale.

**Do next with evidence**: run the load test (§2), capture the slow-query log + `EXPLAIN (ANALYZE)` on the
dashboard due-query, the capacity correlated-subquery, and `documents(type,status)` / `billing_entries
(state)` filters against production data volume. Refactor what the plans actually show as costly.

## 6. Known follow-ups surfaced while writing this

- The branch/assayer **picker dropdowns cap at `limit=1000`** (e.g. `Rules.tsx`, billing modals). For a
  client with more than 1000 branches this silently omits the rest. Convert those to a **server-side
  typeahead search** rather than a capped fetch. (This is the real "large list" fix — the data tables
  themselves are already bounded by pagination, so they need no virtualization.)
