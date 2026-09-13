# Environment variables

Every environment variable read anywhere in this repo, as of 2026-09-13 — backend (`packages/backend`),
its standalone scripts, root-level operational/acceptance scripts, frontend (`packages/frontend`),
mobile (`packages/mobile`), and the docker-compose/`.env*` files under the repo root and `deploy/`.

This is Phase H of the config/env consolidation: before this file, no single place listed every var,
which package or script reads it, and its default — so `VITE_*`, `EXPO_PUBLIC_*` and the backend's own
scheme had each drifted independently. Where the SAME variable name resolves to a DIFFERENT default in
two places, the Notes column says so explicitly — that drift is exactly what this file exists to make
visible. See the end of this document for a consolidated list of what was found.

**Two fixes already landed this session, reflected here in their current (fixed) state, not the old
broken one:** `packages/backend/scripts/*.js` now read `DB_DATABASE` (not the old `DB_NAME`), and
`deploy/docker-compose.prod.yml`'s `SKIP_BOOTSTRAP` forwarding now reads a host variable of the same
name (not `DB_SKIP_BOOTSTRAP`).

**Settings-registry override.** A number of backend variables are also declared in
`packages/backend/src/infrastructure/settings/settings.registry.ts`, a live, database-backed
configuration store editable at Administration → Platform Settings. For those, resolution order is
**saved value (Platform Settings) → this environment variable → the shipped default** — the env var is
a bootstrap fallback for a fresh environment, not the only way to set it. Rows below say **"(+ settings
registry)"** when this applies; a row with no such note is environment-only — there is no UI override.

---

## Backend (`packages/backend/src`)

### Database

| Variable | Read by | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | `infrastructure/database/database.config.ts`, `data-source.ts` | none | Wins over the discrete `DB_*` values when set; turns TLS on (`DB_SSL` also forces it) |
| `DATABASE_URL_UNPOOLED` | `data-source.ts` | none | Migrations CLI prefers this direct (non-pooled) endpoint over `DATABASE_URL` |
| `DB_HOST` | `database.config.ts`, `data-source.ts`, `main.ts` (`assertDatabaseIdentity`), `roles/provision.ts`, `seed.ts` | `localhost` | Consistent across all backend runtime code |
| `DB_PORT` | same files | `5432` | Consistent |
| `DB_USERNAME` | same files | `fapoms` | `main.ts` refuses to boot if this equals the migration role (`fapoms_migrator`) |
| `DB_PASSWORD` | same files | `fapoms_dev` (`database.config.ts`/`data-source.ts`); no fallback where `main.ts` reads it raw for the production safety check | `main.ts` rejects `fapoms_dev`/`postgres`/`fapoms`/`changeme` outright in production |
| `DB_DATABASE` | same files | `fapoms` | Fixed this session (was `DB_NAME` in the standalone scripts, see above) |
| `DB_SSL` | `database.config.ts`, `data-source.ts`, `main.ts`, `roles/provision.ts` (×3) | off; `database.config.ts` defaults it **on** whenever `DATABASE_URL` is set | Six near-identical `rejectUnauthorized:false` blocks the code comments say must change together |
| `DB_SYNCHRONIZE` | `database.config.ts`, `data-source.ts`, `main.ts` | `false` | MUST be `false` in production — boot fails otherwise; compared as the string `'true'` |
| `DB_MIGRATIONS_RUN` | `database.config.ts`, `main.ts` | `true` | Must be `false` when `DB_USERNAME` is the runtime role; boot fails otherwise in production |
| `DB_LOGGING` | `database.config.ts`, `data-source.ts` | `false` | |
| `DB_POOL_MAX` | `database.config.ts`, `main.ts` (`assertConcurrencyWithinPool`), `infrastructure/queue/worker-concurrency.ts` | `20` (`DEFAULT_DB_POOL_MAX`) | Compared at boot against summed `WORKER_CONCURRENCY`; warns if oversubscribed |
| `DB_POOL_MIN` | `database.config.ts` | `5` | |
| `DB_IDLE_TIMEOUT_MS` | `database.config.ts` | `300000` | |
| `DB_CONN_TIMEOUT_MS` | `database.config.ts` | `10000` | |
| `DB_STATEMENT_TIMEOUT_MS` | `database.config.ts` | `30000` | |
| `DB_IDLE_TX_TIMEOUT_MS` | `database.config.ts` | `60000` | |
| `DB_RETRY_ATTEMPTS` | `database.config.ts` | `10` | |
| `DB_RETRY_DELAY_MS` | `database.config.ts` | `3000` | |
| `FAPOMS_RUNTIME_PASSWORD` | `roles/provision.ts` | none (required) | The application credential |
| `FAPOMS_MIGRATION_PASSWORD` | `roles/provision.ts` | none (required) | The deploy-only credential; never in the API's own environment |
| `DB_ADMIN_URL` | `roles/provision.ts` | none (required unless `SKIP_BOOTSTRAP=true`) | An administrative login used only by the bootstrap step |
| `SKIP_BOOTSTRAP` | `roles/provision.ts` | off (checked `!== 'true'`) | Same name `deploy/docker-compose.prod.yml` now forwards (fixed this session) |

### Auth, JWT & sessions

| Variable | Read by | Default | Notes |
|---|---|---|---|
| `JWT_SECRET` | `infrastructure/security/jwt.module.ts`, `modules/auth/jwt.strategy.ts`, `main.ts` (`assertProductionSafeConfig`), `modules/document/document-access-token.service.ts` (fallback) | `dev-secret` | Same literal default in the two JWT read-sites; two specific burned values are rejected outright in production |
| `JWT_ACCESS_EXPIRATION` | `jwt.module.ts`, `modules/auth/auth.service.ts` | `900` (15 min) | Same default in both places; accepts seconds or a timespan (`15m`, `7d`) |
| `JWT_REFRESH_EXPIRATION` | `auth.service.ts` | `604800` (7 days) | |
| `DOCUMENT_TOKEN_SECRET` | `document-access-token.service.ts` | falls back to `JWT_SECRET`; throws if both unset | Deliberately no hardcoded literal fallback |
| `PII_ENCRYPTION_KEY` | `infrastructure/security/field-encryption.ts`, `main.ts`, `infrastructure/settings/platform-settings.service.ts` | none | REQUIRED in production (64 hex chars or 32-byte base64); degrades to plaintext passthrough with a boot warning outside production |
| `RBAC_CACHE_TTL_SECONDS` | `auth.service.ts` | `600` | Cached-principal TTL; every mutating path also invalidates explicitly |
| `SESSION_IDLE_TIMEOUT_MINUTES` | `auth.service.ts` (+ settings registry `security.session.idleTimeoutMinutes`) | `0` (off) | Same default value in code and in the settings registry, by design |
| `SESSION_ABSOLUTE_HOURS` | `auth.service.ts` (+ settings registry `security.session.absoluteHours`) | `168` (7 days) | Same default value in both, by design |
| `LOGIN_IP_MAX_FAILURES` | `auth.service.ts` | `20` (floor 5) | Per-source-IP brute-force brake |
| `LOGIN_IP_FAIL_WINDOW_SECONDS` | `auth.service.ts` | `900` (floor 60) | |
| `LOGIN_IP_BLOCK_BASE_SECONDS` | `auth.service.ts` | `60` (floor 15) | |
| `LOGIN_IP_BLOCK_MAX_SECONDS` | `auth.service.ts` | `1800` (floor 60) | |
| `REFRESH_REUSE_GRACE_MS` | `auth.service.ts` | `30000` | |
| `THROTTLE_LIMIT` | `app.module.ts` | `300` (req/min/IP) | `POST /auth/login` is separately capped at 20/min, hardcoded, not env-tunable |
| `THROTTLE_TTL_MS` | `app.module.ts` | `60000` | |
| `METRICS_TOKEN` | `infrastructure/observability/metrics-auth.guard.ts` | none | `Authorization: Bearer` required on `/api/v1/metrics` when set |
| `BULL_BOARD_USER` | `infrastructure/queue/bull-board.setup.ts` | none | With `BULL_BOARD_PASSWORD`, Basic-Auth-gates `/bull-board`; unset in production = not mounted at all |
| `BULL_BOARD_PASSWORD` | `bull-board.setup.ts` | none | |
| `STARTUP_CHECKS_STRICT` | `main.ts`, `infrastructure/observability/startup-checks.service.ts` | off (`!== 'true'`) | Automatically strict when `NODE_ENV=production` regardless of this var |

### Storage, uploads & malware scanning

| Variable | Read by | Default | Notes |
|---|---|---|---|
| `STORAGE_DRIVER` | `infrastructure/storage/storage.module.ts`, `main.ts` | `local` | MUST be `s3` in production — boot fails otherwise (local disk loses evidence across replicas/redeploys) |
| `S3_ENDPOINT` | `infrastructure/storage/s3-storage.service.ts`, `main.ts` (MinIO-password check) | `''` (empty → real AWS S3) | |
| `S3_BUCKET_NAME` | `s3-storage.service.ts` | `fapoms-documents` | |
| `AWS_REGION` | `s3-storage.service.ts` | `us-east-1` | `.env.production.example` recommends `ap-south-1` for India data residency — template guidance, not a code default |
| `AWS_ACCESS_KEY_ID` | `s3-storage.service.ts` | `''` | |
| `AWS_SECRET_ACCESS_KEY` | `s3-storage.service.ts` | `''` | |
| `S3_FORCE_PATH_STYLE` | `s3-storage.service.ts` | `false` | `true` for MinIO, `false` for real AWS S3 |
| `S3_MAX_ATTEMPTS` | `s3-storage.service.ts` | `3` | |
| `S3_CONNECTION_TIMEOUT_MS` | `s3-storage.service.ts` | `5000` | |
| `STORAGE_SSE` | `s3-storage.service.ts` | `AES256` | `aws:kms` + `STORAGE_SSE_KMS_KEY_ID` for a customer-managed key |
| `STORAGE_SSE_KMS_KEY_ID` | `s3-storage.service.ts` | none | |
| `MINIO_ROOT_PASSWORD` | `main.ts` | none | Checked in production against the burned literal `fapoms_minio_secret`, only when `S3_ENDPOINT` is set and is not `amazonaws.com` |
| `DOCUMENT_MAX_UPLOAD_MB` | `modules/document/upload-validation.ts` | `50` (shared `DEFAULT_MAX_UPLOAD_MB`) | |
| `DOCUMENT_MAX_RESUMABLE_UPLOAD_MB` | `upload-validation.ts` | `100` (shared `MAX_RESUMABLE_UPLOAD_MB`) | |
| `FILE_SCAN_REQUIRED` | `infrastructure/security/file-scan.service.ts`, `main.ts` | `false` | MUST be `true` in production — boot fails otherwise; upload path fails CLOSED when the scanner is unreachable |
| `CLAMAV_HOST` | `file-scan.service.ts` | none | |
| `CLAMAV_PORT` | `file-scan.service.ts` | `3310` | |
| `CLAMAV_TIMEOUT_MS` | `file-scan.service.ts` | `15000` | |
| `DATA_RESET_BACKUP_DIR` | `infrastructure/data-reset/backup-on-demand.service.ts` | `/app/backups` | |

### Email, SMS & push

| Variable | Read by | Default | Notes |
|---|---|---|---|
| `GMAIL_USER` | `infrastructure/notifications/email-provider.ts` (+ settings registry `email.gmailUser`) | none | |
| `GMAIL_APP_PASSWORD` | `email-provider.ts` (+ settings registry) | none | |
| `SMTP_HOST` | `email-provider.ts`, `modules/notifications/notification-admin.controller.ts` (+ settings registry) | none | |
| `SMTP_PORT` | `email-provider.ts` (+ settings registry) | `587` | Same default in both |
| `SMTP_USER` | `email-provider.ts` (+ settings registry) | none | |
| `SMTP_PASSWORD` | `email-provider.ts` (+ settings registry) | none | |
| `SMTP_SECURE` | `email-provider.ts` (+ settings registry) | `false` | |
| `EMAIL_FROM` | `email-provider.ts`, `notification-admin.controller.ts` (+ settings registry) | none | |
| `APP_PUBLIC_URL` | `email-provider.ts`, `modules/validation-query/validation-query.controller.ts` (+ settings registry `app.publicUrl`) | `http://localhost:5173` | Also read directly by the frontend's `vite.config.ts` (Node/build context) — see Frontend |
| `EMAIL_DIGEST_CRON` | `notification-admin.controller.ts` (+ settings registry) | `30 8 * * 1-6` | Same default in both |
| `FRONTEND_URL` | `validation-query.controller.ts` (fallback after `APP_PUBLIC_URL`) | none | Also read by the frontend's `vite.config.ts` |
| `SMS_PROVIDER_API_KEY` | `infrastructure/notifications/sms-provider.ts` | none | Blank disables SMS delivery entirely; not a Platform Settings field (single vendor) |
| `SMS_SENDER_ID` | `sms-provider.ts` | none | MSG91 registered 6-character sender id |
| `SMS_ROUTE` | `sms-provider.ts` | `'4'` (MSG91 transactional route) | |
| `FCM_PROJECT_ID` | `infrastructure/notifications/fcm-provider.ts` | none | All three required together or push stays disabled |
| `FCM_CLIENT_EMAIL` | `fcm-provider.ts` | none | |
| `FCM_PRIVATE_KEY` | `fcm-provider.ts` | none | `\n` sequences un-escaped before use |

### Geo, routing & geocoding

| Variable | Read by | Default | Notes |
|---|---|---|---|
| `ROUTING_PROVIDER` | `modules/geo/routing.provider.ts` | `OSRM` | Anything else logs a boot warning and behaves as `OSRM`; `.env.production.example` once shipped the now-nonexistent `google` |
| `OSRM_URL` | `routing.provider.ts` | none | Unset means OSRM is treated as unavailable and every request degrades to the great-circle estimate — never silently calls the public demo server |
| `OSRM_CACHE_TTL_S` | `routing.provider.ts` | `2592000` (30 days) | |
| `OSRM_TABLE_MAX_COORDS` | `routing.provider.ts` | `100` | Matches `osrm-routed`'s own `--max-table-size` default |
| `OSRM_BREAKER_THRESHOLD` | `routing.provider.ts` | `5` | Consecutive failures before the circuit opens |
| `OSRM_BREAKER_COOLDOWN_MS` | `routing.provider.ts` | `30000` | |
| `OSRM_TIMEOUT_MS` | `routing.provider.ts` | `4000` | |
| `NOMINATIM_URL` | `modules/geo/osm-geocoder.ts` | `https://nominatim.openstreetmap.org` | Self-hosted URL replaces the ~1 req/s public tier |
| `GEOCODER_USER_AGENT` | `osm-geocoder.ts` | `FAPOMS/1.0 (field-audit operations platform; contact: it@sumeruglobal.in)` | Required by the OSM usage policy |
| `GEOCODER_CONCURRENCY` | `osm-geocoder.ts` | `6` | |
| `GEOCODER_ALLOW_NETWORK_IN_TESTS` | `osm-geocoder.ts` | off | Only consulted when `NODE_ENV=test` |
| `GEO_CACHE_DIR` | `modules/geo/geo-cache-store.ts` | none | On-disk cache for geocode results across redeploys |
| `GEO_CACHE_ALLOW_WRITES_IN_TESTS` | `geo-cache-store.ts` | off | Only consulted when `NODE_ENV=test` |
| `GOOGLE_MAPS_API_KEY` | `modules/geo/india-geocoder.ts`, `modules/geo/india-autocomplete.helper.ts` | none | Also the sole place-autocomplete source; unset disables both |
| `GEO_PRECISION_NIGHTLY_LIMIT` | `modules/geo/geo-precision.worker.ts` | `150` | Nightly sweep row cap (rate-limited public geocoder) |
| `GEO_ADDRESS_ENRICH_LIMIT` | `geo-precision.worker.ts` | `3000` | |
| `GEO_BACKFILL_CONCURRENCY` | `modules/geo/geo-precision.service.ts` | `6` | |
| `BRANCH_IMPORT_SYNC_GEOCODE_LIMIT` | `modules/import/import-job.service.ts` | `25` | |
| `BRANCH_IMPORT_SYNC_ROW_LIMIT` | `import-job.service.ts` | `200` | |

### In-app calling (LiveKit)

| Variable | Read by | Default | Notes |
|---|---|---|---|
| `LIVEKIT_HOST` | `main.ts` (signaling proxy target) | `http://livekit:7880` | |
| `LIVEKIT_PUBLIC_URL` | `modules/calls/calls.service.ts` | `/livekit` | What the browser/app actually connects to |
| `LIVEKIT_API_KEY` | `calls.service.ts` | none | Same pair the `livekit` container receives as `LIVEKIT_KEYS` via compose |
| `LIVEKIT_API_SECRET` | `calls.service.ts` | none | |

### Retention

All four below accept `0` to mean "keep indefinitely" (deliberately explicit). Three (`SESSION_HISTORY`,
`UI_TELEMETRY`, and `LOCATION_TRAIL` further down) have a settings-registry override that is checked
*before* the environment variable.

| Variable | Read by | Default | Notes |
|---|---|---|---|
| `RETENTION_OUTBOX_DAYS` | `infrastructure/retention/retention.service.ts` | `7` | Dispatched outbox rows only |
| `RETENTION_REFRESH_TOKEN_GRACE_DAYS` | `retention.service.ts` | `2` | Counted past expiry |
| `RETENTION_READ_NOTIFICATION_DAYS` | `retention.service.ts` | `180` | Read notifications only; unread ones are never purged |
| `LOCATION_TRAIL_RETENTION_DAYS` | `retention.service.ts`, `modules/assayer/location-trail.service.ts` (+ settings registry `locationTrail.retentionDays`) | `550` (`DEFAULT_LOCATION_PING_DAYS`) when neither Platform Settings nor this env var is set | No statutory floor |
| `SESSION_HISTORY_RETENTION_DAYS` | `retention.service.ts` (+ settings registry `retention.sessionHistoryDays`) | kept indefinitely; a set value is floored up to 180 days (CERT-In) | |
| `UI_TELEMETRY_RETENTION_DAYS` | `retention.service.ts` (+ settings registry `retention.uiTelemetryDays`) | `180`; a set value is floored up to 90 days | Only class that defaults to purging, not keeping |

### Compliance & observability

| Variable | Read by | Default | Notes |
|---|---|---|---|
| `DATA_RESIDENCY_REGION` | `infrastructure/observability/startup-checks.service.ts` | `''` (unset → boot warning, non-fatal) | CERT-In/RBI hosting-region declaration; app cannot detect this itself |
| `CLOCK_DRIFT_WARN_MS` | `startup-checks.service.ts` | `5000` | App-vs-database clock skew warning threshold |

### Performance & caching

| Variable | Read by | Default | Notes |
|---|---|---|---|
| `DASHBOARD_CACHE_TTL_S` | `modules/user/operations-snapshot.service.ts` | `15` | |
| `HR_OVERVIEW_CACHE_TTL_S` | `modules/assayer/hr-workforce.service.ts` | `30` | |
| `COMMAND_CENTER_CACHE_TTL_S` | `modules/planning/command-center.service.ts` | `20` | |
| `COMMAND_CENTER_MAX_POINTS` | `command-center.service.ts` | `20000` (`DEFAULT_MAX_POINTS`) | Map payload ceiling |
| `PROJECT_CANDIDATES_PER_BRANCH` | `modules/planning/project-planning.service.ts` | `5` | |
| `SCOPE_OPTIONS_CACHE_TTL_S` | `infrastructure/scope/scope.controller.ts` | `60` | |
| `ASSAYER_RECENT_TERMINAL_DAYS` | `modules/assignment/assignment.service.ts` | `60` | |
| `SCHEDULE_RECONCILE_MS` | `infrastructure/queue/repeatable-schedules.ts` | `300000` | |
| `REDIS_COMMAND_TIMEOUT_MS` | `infrastructure/http/throttling/resilient-throttler-storage.ts` | `500` | |
| `REDIS_HOST` | `app.module.ts`, `infrastructure/redis/redis-client.module.ts`, `main.ts` (boolean presence check only) | `localhost` | Setting it also switches on the multi-node Socket.IO Redis adapter |
| `REDIS_PORT` | `app.module.ts`, `redis-client.module.ts` | `6379` | |
| `REDIS_PASSWORD` | `app.module.ts` (×2), `redis-client.module.ts` | none | |
| `FEE_FLAG_MULTIPLIER` | `modules/pricing/fee-policy.service.ts` (+ settings registry `fees.flagMultiplier`) | `1.5` | Falls back to the settings-registry constant rather than a separate literal |

### Process & misc

| Variable | Read by | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | throughout (`main.ts` and many others) | none (checked against `'production'` / `'test'`) | Gates the production-safety checks, Swagger, seed behaviour, CORS default, etc. |
| `PORT` | `main.ts` | `3000` | |
| `PROCESS_ROLE` | `main.ts`, `infrastructure/queue/job-failure.monitor.ts` | `all` | `api` \| `worker` \| `all` — splits HTTP from background-job replicas |
| `WORKER_HEALTH_PORT` | `main.ts` | value of `PORT`, else `3000` | Worker-role replica's health-only listener |
| `TRUST_PROXY` | `main.ts` | on, as `loopback,linklocal,uniquelocal`, unless the value is `'false'` | An explicit non-`'true'` value is used verbatim as the Express trust-proxy setting |
| `MAX_JSON_BODY` | `main.ts` | `50mb` | Legacy base64-JSON upload path only |
| `HTTP_KEEPALIVE_TIMEOUT_MS` | `main.ts` | `61000` | Should exceed the load balancer's idle timeout |
| `HTTP_HEADERS_TIMEOUT_MS` | `main.ts` | `65000` | |
| `HTTP_REQUEST_TIMEOUT_MS` | `main.ts` | `300000` | |
| `ENABLE_API_DOCS` | `main.ts` | off | Swagger (`/api/docs`) is mounted whenever NOT production, or when this is `true` |
| `CORS_ORIGINS` | `main.ts`, `modules/realtime/events.gateway.ts` (+ read via `configService` in `assertProductionSafeConfig`) | `http://localhost:5173,http://localhost:8081,http://localhost:19006` | REQUIRED in production — boot fails if unset; same literal default in both direct-read sites |
| `SEED_MODE` | `infrastructure/database/seed.ts` | `''` (trimmed) | |
| `COMPOSE_PROJECT_NAME` | `modules/platform/logs/docker-engine.client.ts` | `''` → derives the project from the container's own labels | Also a compose-level var, see Deployment |
| `DOCKER_API_URL` | `docker-engine.client.ts` | `http://dockerproxy:2375` | |
| `SERVICE_LOGS_ENABLED` | `docker-engine.client.ts` | on (checked `!== 'false'`) | |
| `ALERT_WEBHOOK_URL` | `infrastructure/observability/error-alerter.ts` | none | Unset = alerts are logged only |

### Settings-registry-backed (env-only rows not covered above)

Declared in `settings.registry.ts` with an `envVar` fallback; resolution is saved value → this
variable → the shipped default shown here.

| Variable | Read by (settings key) | Default | Notes |
|---|---|---|---|
| `CHECK_IN_GEOFENCE_METERS` | `field.checkInGeofenceMeters` | `2000` | |
| `IDENTITY_GATE_MODE` | `onboarding.identityGate.mode` | `warn` | `off` \| `warn` \| `enforce` |
| `ID_CARD_VALIDITY_MODE` | `onboarding.idCard.validityMode` | `CALENDAR_YEAR` | |
| `ID_CARD_ROLLING_MONTHS` | `onboarding.idCard.rollingMonths` | `12` | |
| `ID_CARD_GRACE_DAYS` | `onboarding.idCard.graceDays` | `45` | |
| `REGION_SCOPE_MODE` | `security.regionScope.mode` | `enforce` | `off` \| `log` \| `enforce`; shipped as `log` during rollout, now `enforce` |
| `SEGREGATION_OF_DUTIES_MODE` | `security.segregationOfDuties.mode` | `enforce` | `off` \| `warn` \| `enforce` |
| `PLANNING_FAIRNESS_OFFER_CAP` | `planning.fairnessOfferCap` | `8` | |
| `PLANNING_NO_EMPANELMENT_ROW` | `planning.eligibility.noEmpanelmentRow` | `BLOCK` | |
| `ROSTER_AUTO_CREATE_CLIENTS` | `roster.autoCreateClients` | `true` | |
| `DOCUMENT_AUTO_SEND_TO_OCR` | `document.autoSendToExternalOcr` | `false` | |
| `FEEDBACK_FIRST_RESPONSE_SLA_HOURS` | `feedback.firstResponseHours` | `24` | |
| `FEEDBACK_RESOLUTION_CRITICAL_SLA_HOURS` | `feedback.resolveCriticalHours` | `8` | |
| `FEEDBACK_RESOLUTION_HIGH_SLA_HOURS` | `feedback.resolveHighHours` | `24` | |
| `FEEDBACK_RESOLUTION_MEDIUM_SLA_HOURS` | `feedback.resolveMediumHours` | `72` | |
| `FEEDBACK_RESOLUTION_LOW_SLA_HOURS` | `feedback.resolveLowHours` | `168` | |

### Test-only fixtures (`.db.spec.ts` acceptance-style integration specs)

Not application configuration — read only by two integration spec files that drive a live server the
same way `scripts/acceptance/*.mjs` does. Listed for completeness since they are genuine
`process.env.*` reads under `packages/backend/src`.

| Variable | Read by | Default | Notes |
|---|---|---|---|
| `TI_API` | `modules/assayer/assayer-tenant-isolation.db.spec.ts` | `http://127.0.0.1:3999/api/v1` | |
| `TI_ORG_A` | same | `382c3718-89e5-41a2-ac29-ab5ec7900562` | |
| `TI_USER_A` | same | `lc-ops@lifecycle-cert.invalid` | |
| `TI_PASSWORD` | same | none | |
| `TI_ADMIN_PASSWORD` | same | falls back to `TI_PASSWORD` | |
| `TI_ADMIN_USER` | same | `lc-admin@lifecycle-cert.invalid` | |
| `LC_API` | `modules/assayer/assayer-lifecycle-certification.db.spec.ts` | `http://localhost:8080/api/v1` | Different default host/port than `TI_API` above, for a different spec file |
| `LC_USER` | same | `lc-ops@lifecycle-cert.invalid` | |
| `LC_PASSWORD` | same | none | |
| `LC_ORG` | same | `382c3718-89e5-41a2-ac29-ab5ec7900562` | Same literal org id as `TI_ORG_A` |

Other backend `*.spec.ts` files set/delete a handful of the vars already listed above
(`PII_ENCRYPTION_KEY`, `JWT_SECRET`, `GOOGLE_MAPS_API_KEY`, `COMMAND_CENTER_MAX_POINTS`,
`DATA_RESIDENCY_REGION`, `EMAIL_DIGEST_CRON`, and the retention days) purely as test setup/teardown —
not a distinct configuration surface, so they are not repeated here.

---

## Backend scripts (`packages/backend/scripts/*.{js,ts}`)

Ten standalone scripts (`flag-weak-passwords.js`, `reencrypt-pii.js`, `repair-corrupt-dates.js`,
`repair-inverted-exit-dates.js`, `audit-phase2-inconsistency.ts`, `phase2-production-preflight.ts`,
`phase3-assayer-audit.ts`, `run-benchmarks.ts`, `run-phase1-validation.ts`, `test-keyset-plan.ts`), each
opening its own short-lived `pg` connection. All ten now read `DB_DATABASE` (fixed this session, was
`DB_NAME`) — but the other four connection variables have **not** been unified, and differ by file:

| Variable | Read by | Default | Notes |
|---|---|---|---|
| `DB_HOST` | `flag-weak-passwords.js`, `reencrypt-pii.js`, `repair-corrupt-dates.js` | `postgres` | |
| `DB_HOST` | `repair-inverted-exit-dates.js` | `localhost` | **DRIFT:** same var, different literal default than the three files above |
| `DB_HOST` | `audit-phase2-inconsistency.ts`, `phase2-production-preflight.ts`, `phase3-assayer-audit.ts`, `run-benchmarks.ts`, `run-phase1-validation.ts`, `test-keyset-plan.ts` | `localhost` (and an explicit `postgres` value is actively rewritten to `localhost`) | **DRIFT:** a third, distinct resolution rule for the same var, in the same directory |
| `DB_PORT` | all ten | `5432` | Consistent |
| `DB_USERNAME` | flag-weak-passwords.js, reencrypt-pii.js, repair-corrupt-dates.js, and all six `.ts` scripts | `fapoms` | Consistent |
| `DB_USERNAME` / `DB_USER` | `repair-inverted-exit-dates.js` | `process.env.DB_USERNAME \|\| process.env.DB_USER`, no literal fallback | **DRIFT:** the only script that also accepts the alternate name `DB_USER`, which no other script or the app itself reads, and the only one with no `'fapoms'` fallback if both are unset |
| `DB_PASSWORD` | flag-weak-passwords.js, reencrypt-pii.js, repair-corrupt-dates.js, repair-inverted-exit-dates.js | none | |
| `DB_PASSWORD` | the six `.ts` scripts | `fapoms_dev` | **DRIFT:** same var, no default in the four `.js` scripts vs. `fapoms_dev` in the six `.ts` scripts |
| `DB_DATABASE` | all ten | `fapoms` | Fixed this session — previously `DB_NAME` |
| `PII_ENCRYPTION_KEY` | `reencrypt-pii.js` | none (required; exits if unset) | Walks existing rows re-encrypting them under the current key |

---

## Root scripts & acceptance (`scripts/*.mjs`, `scripts/acceptance/*.mjs`)

`scripts/acceptance/README.md` already documents the safety-gate variables informally (`AC_ALLOW_WRITES`
et al.) and is the authority on which script writes what; this table adds the variable-level defaults
that document does not spell out. Provisioning scripts and the acceptance probes are separate concerns
kept in one section because both live directly under `scripts/`.

### Provisioning (`scripts/create-database.mjs`, `scripts/db-provision.mjs`, `scripts/verify-*.mjs`)

| Variable | Read by | Default | Notes |
|---|---|---|---|
| `DB_ADMIN_URL` | `create-database.mjs`, `db-provision.mjs`, `verify-migrations-from-empty.mjs` | none (required) | Administrative login: `CREATE ROLE`/`CREATE DATABASE`/`CREATE EXTENSION` |
| `DB_ADMIN_URL` | `verify-runtime-role.mjs` | `postgres://pgadmin:pgadmin_dev@127.0.0.1:55433/postgres` | **DRIFT:** the only place this var has a hardcoded fallback (with embedded dev credentials) rather than being required |
| `DB_DATABASE` | `create-database.mjs` (required), `db-provision.mjs` (defaulted) | none in `create-database.mjs`; `fapoms` in `db-provision.mjs` | |
| `FAPOMS_MIGRATION_PASSWORD` | `db-provision.mjs` | none (required) | |
| `FAPOMS_RUNTIME_PASSWORD` | `db-provision.mjs` | none (required) | |
| `DB_HOST` | `verify-migrations-from-empty.mjs` | `127.0.0.1` | Only used when `DB_ADMIN_URL` is unset |
| `DB_PORT` | `verify-migrations-from-empty.mjs` | `5432` | |
| `DB_USERNAME` | `verify-migrations-from-empty.mjs` | `fapoms` | |
| `DB_PASSWORD` | `verify-migrations-from-empty.mjs` | `fapoms_dev` | |
| `ADMIN_DB` | `verify-migrations-from-empty.mjs` | `postgres` | The scratch admin database to connect to before creating the throwaway one |
| `MIN_MIGRATIONS` | `verify-migrations-from-empty.mjs` | `70` | Floor, not an exact count — so the check does not need editing every time a migration is added |
| `MIN_TABLES` | `verify-migrations-from-empty.mjs` | `80` | |
| `DB_SSL` | `db-provision.mjs` | `false` | Forwarded to the `db:provision` npm step it shells out to |

### Acceptance probes (`scripts/acceptance/*.mjs`, `scripts/verify-http-security.mjs`, `scripts/verify-list-limits.mjs`)

Most probes import `AC_API`/`AC_PASSWORD`/the `DB_*` five straight from `_lib.mjs`'s `env` export
(`process.env` merged over an optional `AC_ENV_FILE`), so they share one resolution regardless of which
script runs.

| Variable | Read by | Default | Notes |
|---|---|---|---|
| `AC_ENV_FILE` | `_lib.mjs` | none | Optional `KEY=value` file; anything already in `process.env` wins over it |
| `AC_API` | `_lib.mjs` and nearly every script in this directory, plus `verify-http-security.mjs`/`verify-list-limits.mjs` | `http://127.0.0.1:8080/api/v1` | |
| `AC_PASSWORD` | `_lib.mjs`-based scripts (`custom-role-parity.mjs`, `region-parity.mjs`, `reopen-redo-money.mjs`, `bulk-lifecycle.mjs`, etc.), `reliability.mjs`, `verify-list-limits.mjs` | none (required) | |
| `AC_PASSWORD` | `verify-http-security.mjs` | `admin123` | **DRIFT:** the only script where this has a fallback; everywhere else it is required with no default |
| `CERT_PASSWORD` | `_lib.mjs`, `authorization-and-audit.mjs`, `role-surface-matrix.mjs`, `ten-business-days.mjs` | `Cert!Walk2026x19961` | |
| `AC_ALLOW_WRITES` (or `AC_ALLOW_MUTATIONS`) | `_lib.mjs` | off | Gates every mutating SQL statement `sql()` runs; announced on stdout before first use |
| `AC_ALLOW_PASSWORD_ROTATION` | `_lib.mjs` | off | Separate from `AC_ALLOW_WRITES` on purpose — gates rotating a real account's password |
| `AC_REPO` | `authorization-and-audit.mjs`, `business-loop.mjs`, `final-business-scenario.mjs`, `lifecycle-bypass.mjs`, `messy-reality.mjs`, `reliability.mjs`, `role-surface-matrix.mjs` | `/Users/deepstacker/WorkSpace/dupcq/gssAutomation` (hardcoded path, in `reliability.mjs`) / cwd-relative elsewhere | Where to resolve the workspace's `pg` module from |
| `AC_USERNAME` | `custom-role-parity.mjs` | `admin` | |
| `AC_USERNAME` | `verify-deployment.mjs` | none | **DRIFT:** same var, no default in this script vs. `admin` in `custom-role-parity.mjs` |
| `DB_HOST` / `DB_PORT` / `DB_USERNAME` / `DB_PASSWORD` / `DB_DATABASE` | most scripts in this directory | `127.0.0.1` (or `localhost` in `authorization-and-audit.mjs`/`business-loop.mjs`/etc.) / `55432` (`reliability.mjs`) or `5432` elsewhere / `fapoms` / `fapoms_dev` / `fapoms` | README calls out publishing the target deployment's real Postgres port here explicitly — pointing at the wrong port silently tests a different database |
| `MESSY_KEEP` | `messy-reality.mjs` | none | Keeps the run's fixture rows instead of tearing them down, for inspection |
| `AC_WORKER` | `reliability.mjs` | `deploy-backend-worker-1` | Container name it stops/starts |
| `AC_REDIS` | `reliability.mjs` | `deploy-redis-1` | |
| `AC_REDELIVERY_MS` | `reliability.mjs` | `180000` | |
| `AC_SILENCE_MS` | `reliability.mjs` | `135000` (2.25 × the 60s relay tick) | |
| `PA_LIB` | `ten-business-days.mjs`, `search-export-performance.mjs` | `./_lib.mjs` (this directory) | Previously defaulted to an absolute scratchpad path outside the repo — fixed |
| `SCALE_DB_URL` | `search-export-performance.mjs` | none | Optional second connection string to compare plans against the 200k-row scale database |
| `AC_EXPECT_COMMIT` | `verify-deployment.mjs` | none | |
| `AC_EICAR` | `verify-deployment.mjs` | off | Opt-in: uploads the EICAR test string to prove the malware scanner rejects it |
| `AC_ALLOW_WRITES` | `verify-deployment.mjs` | off | Opt-in: lets check 3.13 create real business records |
| `AC_MAX_LOGIN_FAILURES` | `verify-deployment.mjs` | `8` | |
| `AC_METRICS_TOKEN` | `verify-deployment.mjs` | none | |
| `AC_FILE_SCAN_REQUIRED` | `verify-deployment.mjs` | off | Operator assertion used only if 3.1 could not itself infer `FILE_SCAN_REQUIRED=true` from proving `NODE_ENV=production` |
| `AC_ROLE_LOGINS` | `verify-deployment.mjs` | `'{}'` (empty JSON object) | One credential per role to smoke-test the business loop read-only |
| `AC_CREDS_ARE_AUTHORITATIVE` | `verify-deployment.mjs` | off | |
| `AC_DB` | `verify-deployment.mjs` | off | Must be `1` before any database connection is attempted at all |
| `AC_DEVELOPER_LOGIN` | `verify-deployment.mjs` | none | `username:password` |

---

## Frontend (`packages/frontend`)

Vite only exposes `import.meta.env.VITE_*` to browser code, so that is the entire client-side surface.
`vite.config.ts` itself runs under Node at dev-server startup and separately reads several plain
`process.env.*` vars — these configure the dev server/proxy only and are never bundled to the browser.
(`import.meta.env.DEV` also appears in `src/pages/Login.tsx`, gating a dev-only visible credential
hint — a Vite-built-in flag, not an app-defined environment variable, so it is omitted from the table.)

| Variable | Read by | Default | Notes |
|---|---|---|---|
| `VITE_WS_URL` | `src/services/socket.ts` (`import.meta.env`, client bundle) | `/events` | The only `VITE_*` var actually read from client code |
| `VITE_API_URL` | `vite.config.ts` (`process.env`, Node/dev-server only) | `http://localhost:3000` | Despite the `VITE_` prefix, this one is a dev-server proxy target read at config time, not exposed to the browser bundle |
| `VITE_ALLOWED_HOSTS` | `vite.config.ts` (Node) | `''` | Comma-separated explicit override for Vite's Host-header allowlist |
| `APP_PUBLIC_URL` | `vite.config.ts` (Node) | none | Shared with the backend's own `APP_PUBLIC_URL`; feeds the dev server's allowed-hosts list and HMR client target |
| `FRONTEND_URL` | `vite.config.ts` (Node) | none | Shared with the backend's own `FRONTEND_URL`; same two uses as `APP_PUBLIC_URL` above |
| `CORS_ORIGINS` | `vite.config.ts` (Node) | none | Shared with the backend's own `CORS_ORIGINS`; comma list folded into the allowed-hosts set |

Production notes in `.env.production.example` state the frontend needs **no** build variables at all in
that deployment shape (served same-origin behind Caddy) — `VITE_API_URL`/`VITE_WS_URL` are dev-only.

---

## Mobile (`packages/mobile`)

`app.config.js` (Node, evaluated by Expo tooling / EAS) and the app's own React Native source
(`process.env.EXPO_PUBLIC_*`, inlined into the JS bundle at build time by Babel) are two different
read sites for a few of these names.

| Variable | Read by | Default | Notes |
|---|---|---|---|
| `EAS_PROJECT_ID` | `app.config.js` (`updates.url`, `extra.eas.projectId`) | `05ed5767-ce2f-4872-be1e-5509682f33fe` | Same literal default at both read sites in this one file |
| `EXPO_UPDATE_CHANNEL` | `app.config.js` | none | Required for a local Gradle build to receive OTA updates at all; `eas build` injects it itself |
| `GOOGLE_SERVICES_JSON` | `app.config.js` | `./google-services.json` | EAS Build supplies this as a path to a downloaded file secret; local builds use the literal file |
| `GOOGLE_MAPS_API_KEY` | `app.config.js` (`extra.googleMapsApiKey`, `android.config.googleMaps.apiKey`) | `''` | Same default at both read sites; also read by the backend (separate key, same name) |
| `EXPO_PUBLIC_API_URL` | `app.config.js` (`extra.apiUrl`), `src/services/server-config.ts` | `''` in `app.config.js`; in `server-config.ts` falls back to `Constants.expoConfig?.extra?.apiUrl`, then a derived dev guess | Inlined into the JS bundle at build time — a value baked into a release APK cannot be changed short of an OTA update or rebuild |
| `EXPO_PUBLIC_API_PORT` | `src/services/server-config.ts` | `'3001'` | Was `3000` and disagreed with the deployment's actual port; fixed |
| `EXPO_PUBLIC_DEV_LOCATION` | `src/context/LocationContext.tsx` | none (no simulated position) | `"lat,lng"`; stripped from release bundles by the `__DEV__` guard |

---

## Deployment (compose files & `.env*`)

Compose files resolve `${VAR}` from the shell or an `--env-file`, never from a service's own
`env_file:` entry — see the header comment in the root `docker-compose.yml`. `${VAR:-default}` is a
genuine compose-level default; a bare `${VAR}` with no `:-` means the value must come from the
environment or the container gets an empty string.

### `docker-compose.yml` (repo root — development)

| Variable | Read by (service) | Default | Notes |
|---|---|---|---|
| `DB_DATABASE` | `postgres` | `fapoms` | Also forwarded to `backend`/`mobile` via `env_file: .env.docker` |
| `DB_USERNAME` | `postgres` | `fapoms` | |
| `DB_PASSWORD` | `postgres` | `fapoms_dev` | |
| `PG_PRELOAD_LIBRARIES` | `postgres` | `pg_stat_statements` | Same default as the prod compose file |
| `PG_STAT_STATEMENTS_MAX` | `postgres` | `5000` | Same default as prod |
| `PG_STAT_STATEMENTS_TRACK` | `postgres` | `top` | Same default as prod |
| `PG_TRACK_IO_TIMING` | `postgres` | `on` | Same default as prod |
| `MINIO_ROOT_USER` | `minio` | `fapoms_minio` | |
| `MINIO_ROOT_PASSWORD` | `minio` | `fapoms_minio_secret` | Burned literal — committed to git history, treated as public |
| `LIVEKIT_API_KEY` | `livekit` | `devkey` | Combined into `LIVEKIT_KEYS`; a published, insecure pair |
| `LIVEKIT_API_SECRET` | `livekit` | `secret` | |
| `LAN_HOST_IP` | `livekit` (`NODE_IP`, `LIVEKIT_TURN_DOMAIN`), `mobile` (fallback) | `127.0.0.1` | One key for the DHCP address phones on the LAN must reach |
| `DOCKER_SOCKET_PATH` | `dockerproxy` | `/var/run/docker.sock` | Overridden for rootless Podman's socket path |
| `COMPOSE_PROJECT_NAME` | `backend` | `''` | Deliberately not defaulted to a name — see the in-file comment; also read directly by the app, see Backend |
| `APP_PUBLIC_URL` | `frontend` | `''` | Forwarded through to `vite.config.ts` inside the container |
| `FRONTEND_URL` | `frontend` | `''` | |
| `CORS_ORIGINS` | `frontend` | `''` | |
| `VITE_ALLOWED_HOSTS` | `frontend` | `''` | |
| `VITE_API_URL` | `frontend` | not parameterized — hardcoded to `http://backend:3000` | Any `VITE_API_URL` set in `.env.docker` has **no effect** in this compose file (unlike `vite.config.ts`'s own standalone default) |
| `REACT_NATIVE_PACKAGER_HOSTNAME` | `mobile` | `${LAN_HOST_IP:-127.0.0.1}` (nested fallback) | |
| `EXPO_PUBLIC_DEV_LOCATION` | `mobile` | `''` | |

### `.env.docker` (repo root — the one file dev and prod both read)

Not code defaults — this is what the checked-in dev file actually sets. Comments are this file's own.

| Variable | Set to | Notes |
|---|---|---|
| `NODE_ENV` | `development` | |
| `JWT_SECRET` | `supersecretjwtkeyforfapomsdevelopmentonly` | Dev-only literal; `main.ts` would reject this in production |
| `PII_ENCRYPTION_KEY` | a real-format dev key (committed) | Production must generate its own — losing it makes encrypted values unrecoverable |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | a generated (not `devkey`/`secret`) pair | Comment: "Anyone holding these can mint a token and join any call, so they never leave this file" |
| `LAN_HOST_IP` / `REACT_NATIVE_PACKAGER_HOSTNAME` | `10.80.144.102` | This machine's DHCP address; drifts, and is the sole key for it (previously three independent copies) |
| `DB_MIGRATIONS_RUN` | `true` | Dev keeps one role and migrations-on-boot; production splits this to `false` (see `deploy/docker-compose.prod.yml`) |
| (everything else) | — | `DB_HOST/PORT/USERNAME/PASSWORD/DATABASE`, `STORAGE_DRIVER=s3` + MinIO/AWS_* creds, `FRONTEND_URL`, `CORS_ORIGINS`, `FCM_*` (blank), `GOOGLE_MAPS_API_KEY` (blank), `NOMINATIM_URL` (points at the tailnet Nominatim VM), `GMAIL_USER`/`GMAIL_APP_PASSWORD`/`EMAIL_FROM`/`APP_PUBLIC_URL`, `DB_SSL=false`, `LIVEKIT_HOST`/`LIVEKIT_PUBLIC_URL` | Values match the code defaults documented above where a default exists |

### `deploy/docker-compose.prod.yml`

| Variable | Read by (service) | Default | Notes |
|---|---|---|---|
| `DB_USERNAME` | `postgres` | none (required) | **Note:** unlike the dev compose file, the prod `postgres` block has no `:-` fallback at all — deliberate hardening, not an oversight |
| `DB_PASSWORD` | `postgres` | none (required) | |
| `DB_DATABASE` | `postgres` | none (required) | **DRIFT within this same file:** the `db-migrate` service below defaults this same var to `fapoms` |
| `PG_SHARED_BUFFERS` | `postgres` | `768MB` | |
| `PG_EFFECTIVE_CACHE_SIZE` | `postgres` | `2GB` | |
| `PG_WORK_MEM` | `postgres` | `16MB` | |
| `PG_MAINTENANCE_WORK_MEM` | `postgres` | `256MB` | |
| `PG_AUTOVACUUM_WORK_MEM` | `postgres` | `128MB` | |
| `PG_RANDOM_PAGE_COST` | `postgres` | `1.1` | SSD assumption; `4` for spinning disks |
| `PG_EFFECTIVE_IO_CONCURRENCY` | `postgres` | `200` | |
| `PG_JIT` | `postgres` | `off` | Measured win — see file comment |
| `PG_AUTOVACUUM_SCALE_FACTOR` | `postgres` | `0.05` | |
| `PG_AUTOVACUUM_COST_LIMIT` | `postgres` | `1000` | |
| `PG_MAX_WAL_SIZE` | `postgres` | `2GB` | |
| `PG_MIN_WAL_SIZE` | `postgres` | `512MB` | |
| `PG_WAL_COMPRESSION` | `postgres` | `on` | |
| `PG_PRELOAD_LIBRARIES` | `postgres` | `pg_stat_statements` | Same default as dev compose |
| `PG_STAT_STATEMENTS_MAX` | `postgres` | `5000` | Same as dev |
| `PG_STAT_STATEMENTS_TRACK` | `postgres` | `top` | Same as dev |
| `PG_LOG_MIN_DURATION_MS` | `postgres` | `1000` | |
| `PG_LOG_AUTOVACUUM_MIN_DURATION_MS` | `postgres` | `10000` | |
| `PG_TRACK_IO_TIMING` | `postgres` | `on` | Same as dev |
| `PG_MEM_LIMIT` | `postgres` (`mem_limit`) | `3g` | |
| `REDIS_MAXMEMORY` | `redis` | `384mb` | `noeviction` — refuses writes rather than silently dropping a queued job |
| `REDIS_MEM_LIMIT` | `redis` (`mem_limit`) | `512m` | |
| `MINIO_ROOT_USER` | `minio` | none (required) | No fallback in prod, unlike dev's `fapoms_minio` |
| `MINIO_ROOT_PASSWORD` | `minio` | none (required) | No fallback in prod, unlike dev's `fapoms_minio_secret` |
| `MINIO_MEM_LIMIT` | `minio` (`mem_limit`) | `1g` | |
| `CLAMAV_MEM_LIMIT` | `clamav` (`mem_limit`) | `2g` | |
| `DOCKER_SOCKET_PATH` | `dockerproxy` | `/var/run/docker.sock` | Same default as dev; overridden for rootless Podman |
| `DB_ADMIN_URL` | `db-migrate` | none | Only required unless `SKIP_BOOTSTRAP=true` |
| `FAPOMS_MIGRATION_PASSWORD` | `db-migrate` | none (required) | |
| `FAPOMS_RUNTIME_PASSWORD` | `db-migrate`, `backend`, `backend-worker` | none (required) | |
| `DB_DATABASE` | `db-migrate` | `fapoms` | See drift note against the `postgres` service above |
| `SKIP_BOOTSTRAP` | `db-migrate` | `false` | **Fixed this session** — forwards a host var of the same name, was `DB_SKIP_BOOTSTRAP` |
| `FAPOMS_RUNTIME_USER` | `backend`, `backend-worker` (both set container `DB_USERNAME` from this) | `fapoms_runtime` | Never read directly by application code — purely a compose-level indirection |
| `BACKEND_API_DB_POOL_MAX` | `backend` (sets container `DB_POOL_MAX`) | `20` | Matches the app's own code-level `DB_POOL_MAX` default |
| `BACKEND_NODE_OPTIONS` | `backend` | `--max-old-space-size=1024` | |
| `BACKEND_MEM_LIMIT` | `backend` (`mem_limit`) | `1536m` | |
| `BACKEND_WORKER_DB_POOL_MAX` | `backend-worker` (sets container `DB_POOL_MAX`) | `40` | Deliberately higher than the app's own 20-default — sized above `WORKER_CONCURRENCY`'s 33 declared slots |
| `BACKEND_WORKER_NODE_OPTIONS` | `backend-worker` | `--max-old-space-size=1024` | Same literal as `BACKEND_NODE_OPTIONS`, independent knob |
| `BACKEND_WORKER_MEM_LIMIT` | `backend-worker` (`mem_limit`) | `1536m` | Same literal as `BACKEND_MEM_LIMIT`, independent knob |
| `APK_DIR` | `caddy` (×2 mounts) | `/srv/fapoms-downloads` | |

### `deploy/aws/docker-compose.aws-full.yml` ("full" mode overlay)

| Variable | Read by (service) | Default | Notes |
|---|---|---|---|
| `NOMINATIM_PBF_URL` | `nominatim` | `https://download.geofabrik.de/asia/india-latest.osm.pbf` | |
| `NOMINATIM_REPLICATION_URL` | `nominatim` | `https://download.geofabrik.de/asia/india-updates/` | |
| `NOMINATIM_PASSWORD` | `nominatim` | `nominatim` | |
| `OSM_DATA_DIR` | `osrm` | `/opt/fapoms-osm` | |

`CLAMAV_HOST`, `NOMINATIM_URL` and `OSRM_URL` are how the backend reaches these three services
(`clamav:3310`, `http://nominatim:8080`, `http://osrm:5000`) — read by the app, not set here; see Backend.

### `.env.production.example` (template for `.env.docker` in production)

Not a separate reader — this is the annotated template for every backend variable already listed
above, plus the compose-level `PG_*`/`*_MEM_LIMIT` knobs already listed under
`deploy/docker-compose.prod.yml`. Two things worth flagging on their own:

- It documents `RETENTION_REFRESH_TOKEN_GRACE_DAYS`, `SESSION_HISTORY_RETENTION_DAYS`,
  `DATA_RESIDENCY_REGION`, `CLOCK_DRIFT_WARN_MS`, `TRUST_PROXY`, `REDIS_COMMAND_TIMEOUT_MS` and several
  of the `Tuning knobs (all optional)` — all confirmed above as genuinely read.
- Its closing section points operators at `packages/backend/.env.example` "for the full list and
  precedence" — **that file does not exist anywhere in this repository.** Stale pointer; either the
  reference should be removed or the file it names should exist.

### `deploy/auto-deploy.env.example` (homeserver) / `deploy/aws/auto-deploy.env.example` (AWS)

Both are read by the same `deploy/auto-deploy.sh` (systemd `EnvironmentFile` on the AWS box, sourced
directly by the script itself), whose own `${VAR:-default}` lines are the true defaults — the two
`.example` files are per-host overrides layered on top of those.

| Variable | Read by | Script default | Notes |
|---|---|---|---|
| `FAPOMS_DEPLOY_CONF` | `auto-deploy.sh` | `/etc/default/fapoms-deploy` | |
| `FAPOMS_REPO` | `auto-deploy.sh` | `$HOME/apps/fapoms` | AWS example overrides to `/opt/fapoms` |
| `FAPOMS_BRANCH` | `auto-deploy.sh` | `main` | **Deliberate, documented difference, not drift:** the homeserver example keeps `main`; the AWS example overrides to `test` — "same script, same gate, different branch" per the file's own comment |
| `FAPOMS_OPS_DIR` | `auto-deploy.sh` | `$HOME/apps/fapoms-ops` | AWS example overrides to `/opt/fapoms-ops` |
| `FAPOMS_ENV_FILE` | `auto-deploy.sh` | `$REPO/.env.docker` | AWS example overrides to `/opt/fapoms/.env.docker` |
| `FAPOMS_CONTAINER_CLI` | `auto-deploy.sh` | `podman` | AWS example overrides to `docker` |
| `FAPOMS_HEALTH_URL` | `auto-deploy.sh` | `http://127.0.0.1:8080/api/v1/health` | Same in both examples |
| `FAPOMS_LOG` | `auto-deploy.sh` | `$OPS_DIR/auto-deploy.log` | Not set by either example |
| `FAPOMS_COMPOSE_FILES` | `auto-deploy.sh` | `$REPO/deploy/docker-compose.prod.yml` | AWS example overrides to `/opt/fapoms/deploy/docker-compose.aws.yml`; append the "full" overlay for `MODE=full` boxes |
| `FAPOMS_POST_RESET_HOOK` | `auto-deploy.sh` | `''` (none) | AWS example sets `/opt/fapoms-ops/render-aws-compose.sh`; homeserver example does not set it |
| `FAPOMS_SOURCE_MOUNTED` | `auto-deploy.sh` | `false` | Not set by either example |
| `FAPOMS_REPAIR_COOLDOWN_S` | `auto-deploy.sh` | `1800` | Not set by either example |
| `FAPOMS_SKIP_CI_GATE` | `auto-deploy.sh` | `0` | Not set by either example |
| `FAPOMS_GH_REPO` | `auto-deploy.sh` | `CipherCosmos/fapoms` | Same in both examples |
| `FAPOMS_GH_TOKEN` | `auto-deploy.sh` | `''` (none — CI gate calls GitHub anonymously) | Same (blank) in both examples; only needed if the repo goes private or shares an egress IP |

---

## Summary of genuine inconsistencies found

Everything below is the same variable name resolving to a materially different default, or a
different name doing the same job, in more than one place. Presented for a human decision — nothing in
this repo was changed to produce or fix this list.

1. **`packages/backend/scripts/*`: three different `DB_HOST` defaults** in the same directory —
   `postgres` (3 files), `localhost` (1 file), and a third rule that actively rewrites an explicit
   `postgres` value back to `localhost` (6 files).
2. **Same directory, `DB_PASSWORD`: no default in the four `.js` scripts vs. `fapoms_dev`** in the six
   `.ts` diagnostic scripts.
3. **`repair-inverted-exit-dates.js` alone accepts `DB_USER`** as a fallback name for `DB_USERNAME`,
   with no other script or the application itself recognizing that name, and no literal default if
   both are unset (every sibling script defaults to `'fapoms'`).
4. **`scripts/verify-http-security.mjs` defaults `AC_PASSWORD` to `admin123`;** every other script that
   reads `AC_PASSWORD` (a dozen-plus of them) requires it with no default.
5. **`scripts/verify-runtime-role.mjs` hardcodes a fallback connection string for `DB_ADMIN_URL`**
   (embedded dev credentials); every other reader of `DB_ADMIN_URL` treats it as required.
6. **`scripts/acceptance/custom-role-parity.mjs` defaults `AC_USERNAME` to `admin`;**
   `verify-deployment.mjs` reads the same variable with no default.
7. **`deploy/docker-compose.prod.yml` requires `DB_DATABASE` on the `postgres` service (no fallback)
   but defaults it to `fapoms` on the `db-migrate` service** — the same variable, two different
   resolution rules, in the same file.
8. **`docker-compose.yml` (dev) hardcodes the frontend container's `VITE_API_URL`** to
   `http://backend:3000` rather than reading it from `.env.docker` — a `VITE_API_URL` set there has no
   effect in Docker dev, unlike running the frontend directly against `vite.config.ts`'s own default.
9. **`.env.production.example` points operators at `packages/backend/.env.example`** for the full
   variable list and precedence — that file does not exist anywhere in this repository.
10. **`FAPOMS_BRANCH` differs between the homeserver and AWS `auto-deploy.env.example` files** (`main`
    vs. `test`) — called out here for completeness, but this one is deliberate and documented in the
    files themselves, not an oversight.

Not drift, but worth keeping in mind while reading the tables above: several variables are
**intentionally** read with different defaults in genuinely different contexts — `DB_POOL_MAX` is 20
for the `backend` (API) role and 40 for `backend-worker` in production, sized against that role's own
job-concurrency table, not against each other; and the prod compose file requiring `DB_USERNAME`/
`DB_PASSWORD`/`MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` with no fallback where the dev compose file
defaults all four is a deliberate hardening difference between the two stacks.
