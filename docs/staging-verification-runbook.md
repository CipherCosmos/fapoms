# Staging verification runbook

Everything in this repo is build- and test-verified, but a set of features can only be *proven* against
a live stack (they touch clamd, S3, a real Postgres, live sockets, or a browser at mobile width). This
runbook is the single pass that exercises all of them. Work top to bottom; each item says what to do and
exactly what "pass" looks like.

## 0. Bring up the stack

Provision the full dependency set (the features below need every one):

- **Postgres** (with a production-like data volume — thousands of assayers / tens of thousands of
  assignments; an empty DB hides the real query costs).
- **Redis** (socket adapter + throttler + cache + queues).
- **MinIO/S3** bucket.
- **ClamAV** (`clamd`) reachable on `CLAMAV_HOST:CLAMAV_PORT`.
- Optionally a self-hosted **OSRM** server (`OSRM_URL`). Without one, routing uses the OSRM project's
  public demo server (no SLA), and whenever that cannot answer, a great-circle estimate labelled
  `source: ESTIMATE` — which you'll test anyway.

Set the new env keys from `.env.production.example` — at minimum `PII_ENCRYPTION_KEY`, `STORAGE_SSE`,
`CLAMAV_HOST`, and the `HTTP_*`/`S3_*`/`OSRM_*` timeouts. Then:

```bash
npm run build:shared && npm run build:backend && npm run build:frontend
npm run migration:run --workspace=packages/backend   # applies PII widen + audit-drop + all migrations
# start API (PROCESS_ROLE=api) and at least one worker (PROCESS_ROLE=worker)
```

**Pass:** API boots; `/health` returns healthy (DB + Redis probes green); the boot log shows the bucket
CORS + default-encryption applied and **no** "PII_ENCRYPTION_KEY is not set" warning.

## 1. Data protection (the compliance-critical set)

| Check | How | Pass |
|---|---|---|
| **PII encrypted at rest** | Create/edit an assayer with a PAN + bank account. Then query the DB directly: `select pan_number, bank_account_number from assayers where …`. | The stored values are `enc:v1:…` ciphertext, **not** the plaintext. The app UI still shows the real value (transformer decrypts). |
| **Gov-ID encrypted** | Add a document number through the registration flow, then check `assayer_documents.document_number`. | Ciphertext at rest (`enc:v1:…`). The table named here used to be `assayer_government_documents`, which no longer exists — the query returned an error rather than a finding, so this row could never fail honestly. |
| **PII masked in transit** | As an ADMIN or OPERATIONS user, `GET /assayers` and `GET /assayers/:id`. | `panNumber`, `aadhaarNumber`, `bankAccountNumber` come back last-4 masked (`******234F`). Field names unchanged. As DESK_OPERATOR the keys are **absent entirely**, not masked — a different rule, and both are correct. |
| **Reveal is audited** | `GET /assayers/:id/sensitive/pan` as ADMIN. Then `SELECT * FROM audit_events WHERE event_type='ASSAYER_SENSITIVE_FIELD_REVEALED' ORDER BY occurred_at DESC LIMIT 1`. | Full plaintext returned (not `enc:v1:…`), and exactly one audit row naming who, which field, which assayer. The audit write is awaited **before** the value returns, so a failed audit fails the read. As DESK_OPERATOR: 403. |
| **A masked value cannot be written back** | `PUT /assayers/:id` with `bankAccountNumber: "******4321"`. | Refused, telling the caller to reveal the field first. Bank account is the one to test: PAN and Aadhaar are also caught by their format rules, so this guard is the *only* thing protecting the field a payroll-diversion attempt would aim at. |
| **Temporary passwords expire** | Issue app access, then backdate `assayers.temp_password_expires_at` and sign in. | 403, "The temporary password you were given has expired." An account with `temp_password_expires_at IS NULL` still signs in — null means no expiry applies, which is the honest state for credentials predating the column, and they must not be locked out. |
| **A registration-only session cannot roam** | Sign in as an assayer whose lifecycle is INVITED (issue app access from HR first). Then call `GET /assayers`, `GET /assayers/:id/dossier` and `GET /assignments/assayer/:id`. | All three: **403 with `code: REGISTRATION_IN_PROGRESS`**. `GET /assayers/:id/registration-checklist` and the document upload must succeed — that is the whole point of the session. Activate the person and the same token stops being restricted within the principal cache TTL (30s). |
| **An assayer cannot set their own PAN or Aadhaar** | As that assayer, `PUT /assayers/:id/document/PAN_CARD` with a `documentNumber`. | 403. Those numbers are HR-maintained and are entered from the document by staff. Uploading the *scan* must still succeed. |
| **Malware scanning — every path** | Upload the **EICAR test file** (harmless AV test string) through: a chat attachment, a document upload, an Excel import, the presigned upload, and a chunked upload. | Each is **rejected** with the malware message; nothing is stored/registered. A clean file uploads normally. |
| **Object encryption at rest** | After any upload, check the object in MinIO/S3, and read the `S3StorageService` line in the boot log. | **On AWS S3:** `x-amz-server-side-encryption` present. **On community MinIO this cannot pass** — MinIO needs a separate KMS (Vault or KES) for SSE-S3, so the backend logs a warning and carries on by design. There, the check is instead: confirm the *host volume* has full-disk encryption, and record the answer. Do not tick this row because a warning was present and looked familiar. |
| **Upload type/size limits** | Try uploading a `.exe` (rejected at presign) and a file over `DOCUMENT_MAX_UPLOAD_MB` (rejected + object deleted). | Both rejected with clear messages. |

## 2. Resilience on flaky / failing dependencies

| Check | How | Pass |
|---|---|---|
| **Socket connection recovery** | Open the web app, watch a live-updating list. Kill the network for ~10s (devtools offline), restore it. Meanwhile trigger an event from another session. | On reconnect the missed update appears **without a manual refresh** (connectionStateRecovery). |
| **Field-tolerant ping** | On a throttled ("Slow 3G") connection, leave the app idle. | The socket does **not** churn disconnect/reconnect every ~20s. |
| **OSRM circuit breaker** | Point `OSRM_URL` at a dead host (or stop OSRM). Run planning that needs distances repeatedly. | First few calls fall back to the great-circle estimate after the timeout (each candidate's `distanceSource` is `ESTIMATE` in the recommendation response; the planning workspace shows "(est.)" after the km figure); then the breaker **opens** and subsequent calls fall back **instantly**. `curl /metrics \| grep circuit_breaker_state` shows `{name="osrm"} 2`. Restore OSRM → after cooldown it probes and returns to `0`, and `distanceSource` returns to `OSRM`. |
| **S3 fail-fast** | Point storage at an unreachable endpoint briefly. | Requests fail within ~5s (connection timeout), not minutes. |
| **HTTP server timeouts** | (Optional) run a slow-loris probe. | Header-dribbling connections are dropped at `headersTimeout`. |

## 3. Realtime & multi-node

- Run **two API replicas** behind the Redis adapter. Connect one browser to each. An action on replica A
  updates the list on replica B live. **Pass:** cross-replica sync works (no sticky sessions needed for
  correctness).
- Confirm an **assayer** (mobile/external) does **not** receive staff-only operational events (room
  scoping) — connect an assayer token and verify only their `user:`/assignment events arrive.

## 4. The responsive UI pass (browser, per role)

Log in as each role and view at **375px (mobile), 768px (tablet), 1280px (desktop)**:

- **Shell**: sidebar collapses to a drawer on mobile; no horizontal body scroll anywhere; modals/drawers
  never exceed the viewport; a modal renders **above** the mobile bottom-nav (the z-index fix).
- **Heavy pages**: Billing / HR / Users tables scroll internally (not the page); Projects/Clients
  list+detail **stack** below ~900px; **CaseWorkspace** PDF+thread stacks (doesn't overlap);
  **PlanningWorkspace** stays a desktop power-tool (expected — verify it's usable on tablet, not that it
  stacks).
- **Login/ForcePasswordChange** card fits a phone with no overflow.

## 5. The integration fixes (spot-check the ones that were broken)

- **Per-role landing**: each role lands on its home (admin→Dashboard, ops-mgr→Command Room, ops-exec→
  Field Execution, finance→Billing, HR→Workforce, validator→Data Entry).
- **Assayer password reset** (HR): the one-time temporary password is **shown** (not lost).
- **Access control**: a Read-only Auditor / Finance Manager sees **no** assignment write buttons, and the
  API rejects the transition if forced; an Operations Manager sees **no** disburse panel.
- **Field Issues**: kill the API mid-load → the page shows an **error + Retry**, not an empty "all clear".
- **Clarification attachments**: region crops + files load in the thread (signed token).
- **Dates**: set the machine clock behind UTC → audit/schedule dates read correctly (no off-by-one) on
  web and mobile.
- **Staff directory** shows **all** users (not the first 20).

## 6. Regression gate (run every time)

```bash
npm run build:shared && npm run build:backend && npm run build:frontend
npm run test  --workspace=packages/backend      # expect 544/544
npm run lint  --workspace=packages/backend       # 0 errors (async-safety ratchet)
npm run lint  --workspace=packages/frontend      # 0 errors (react hook-rules)
(cd packages/mobile && npx tsc --noEmit)         # 0 errors
```

## 7. Still open (tracked elsewhere — not part of this pass)

- Dependency-maintenance pass for the residual dev/build/mobile-tooling vulns (`--force` + Expo device
  regression) — see the npm-audit note.
- Image EXIF-strip / thumbnail pipeline (native `sharp`).
- Logout token revocation — see `docs/integration-audit-handoff.md`.
  (The `mustChangePassword` half of that item is **done**, verified on the live stack on
  2026-09-02: the guard now covers assayer principals rather than exempting them, a gated
  principal gets 403 on an ordinary route and 201 on `POST /assayers/me/change-password`, the
  biometric path is throttled and rotation-gated, the flag is carried through a restored session,
  and the 403 carries `code: PASSWORD_CHANGE_REQUIRED` so the app raises the change-password
  screen mid-session instead of showing empty lists until the next cold start.)
- ADR-007 (assessment→project_branch fold) — a scheduled, coordinated migration.
