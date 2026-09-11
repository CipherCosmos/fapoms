# Final certification — findings ledger

Campaign started 2026-09-11 on `41f60beb`. One row per finding. Evidence levels are kept separate
and never merged into "tested": `BROWSER`, `API`, `DB`, `JOB`, `MOBILE`, `DEPLOYMENT`, `SOURCE`.

Every failure is classified **product defect / test defect / environment defect / wrong business
assumption** before anything is edited (§26). A refusal counts as verified only when the response
reason **and** the database state were both checked.

---

## Baseline — the starting line, measured not recalled

Probes re-run against the local production-shaped rig on 2026-09-11, after confirming the running
backend and frontend both contain markers from today's commits rather than trusting the deploy log.

| probe | result | evidence |
|---|---|---|
| ten business days | 85/85 | API · DB |
| region parity (write ceiling) | 43/43 | API · DB |
| custom role parity | 37/37 | API · DB |
| assayer child-row region | 30/30 | API · DB |
| reopen → redo → rebill | 19/19 | API · DB |
| bulk lifecycle contract | 17/17 | API · DB |

Ten business days improved from 80/85 at the last campaign to 85/85, with no change to the probe.

---

## Findings

### C-01 · MEDIUM · performance · OPEN
**The roster list has no index for the column it sorts and pages on.** `assayers` is ordered by
`created_at DESC, id DESC` for both the list and its keyset cursor, and no index covers
`created_at`. The plan is a sequential scan plus a sort at both data volumes measured.

This is the screen most likely to be exhausted: its limit ceiling is 1,000 where every other list
caps at 200, and the keyset cursor is literally `created_at_id`. `assignments` already carries
`idx_assignments_recent_page` for exactly this shape.

- **Repro**: `SELECT indexdef FROM pg_indexes WHERE tablename='assayers'`, then
  `EXPLAIN (ANALYZE, BUFFERS) SELECT a.id FROM assayers a WHERE a.is_active ORDER BY a.created_at DESC, a.id DESC LIMIT 20`
- **Evidence**: DB
- **Dependent workflows**: roster list, roster export, HR overview counts, anything paging assayers
- **Class to sweep**: every keyset cursor in the product — does an index cover its order-by?

### C-02 · LOW · performance · OPEN
**About twenty list endpoints read `limit` straight off the query string** without the
`ParseLimitPipe` that exists for exactly this, so an unbounded list request is accepted. Named in
the probe output with the pipe's own comment explaining why it was written.
- **Evidence**: SOURCE · API

### C-03 · INVESTIGATE · performance · OPEN
**One login took 60.4 seconds** during the ten-business-day run, against a 2.4 s threshold for
everything else in that run. Every other call was inside budget. Cause not yet established —
candidates are bcrypt cost under contention, rate-limit backoff, or a cold connection pool. A
minute to sign in is a usability defect in its own right if it reproduces.
- **Evidence**: API

### C-04 · MEDIUM · correctness · OPEN
**Three money transition tables have no consumers, and one of them is wrong.**
`packages/shared/src/state-machines.ts:185-204` declares `BILLING_STATE_TRANSITIONS`,
`INVOICE_TRANSITIONS` and `PAYABLE_TRANSITIONS`; nothing imports any of them. `PAYABLE_TRANSITIONS`
omits `VOIDED` entirely, while the enum, the `CK_assayer_payables_status` constraint and
`voidPayable()` all have it. The same file's docblock warns that a dead definition is worse than no
definition. Anyone reading it to learn the payable lifecycle learns a lifecycle that does not exist.
- **Evidence**: SOURCE
- **Fix shape**: delete them, or wire them to the imperative implementation — not leave them as a
  third opinion.

### C-05 · MEDIUM · correctness · OPEN
**A bulk lifecycle move still walks through an unearned activation.**
`packages/shared/src/assayer-lifecycle.ts:214-236` records in its own comment that `ACTIVE` remains
a waypoint, so a bulk `INVITED → SUSPENDED` routes through
`DOCUMENT_VERIFICATION → INACTIVE → ACTIVE → SUSPENDED` and writes all four hops — skipping
background verification and training, and leaving an `ACTIVE` audit row for someone who was never
activated. It is visible in the response's `via`, and it appears in **no findings ledger**.
- **Evidence**: SOURCE
- **Dependent workflows**: assignment eligibility, deployment readiness, audit truth

### C-08 · HIGH · deployment · OPEN — owner action
**The homeserver is not running the code anyone has been certifying.** It is serving a build from
**2026-09-09**, roughly 94 commits behind `HEAD` and 10 behind `origin/main`. It has not pulled the
remote tip either.

Absent from the running build: the TDS report PAN mask, the voided-payable money fix, region-scoped
writes, and the log-proxy wiring. **Every prior statement of the form "verified on the homeserver"
about anything dated 09-10 or later describes a build that box has never run.**

Established two independent ways, since no container shell was available. The SPA is public and
content-hashed, so its bytes are the build: all 96 chunks fetched and grepped for string literals
unique to known commits. Separately, by route existence — the outbox routes added later answer 404
while contemporaneous routes answer 401. Both agree.
- **Evidence**: DEPLOYMENT
- **Owner**: whoever owns that box. This is a deploy, not a code fix.

### C-09 · MEDIUM · observability · OPEN
**A status endpoint reports the database as connected without asking it.**
`/api/v1/auth/status` returns `{"status":"online","database":"connected"}` where `database` is a
**hardcoded literal**, not a probe. It will report "connected" with the database on fire. `/health`
is the honest one and does probe. Anyone wiring a monitor to the wrong one gets a green light that
cannot go red.
- **Evidence**: DEPLOYMENT · SOURCE

### C-10 · MEDIUM · test design · OPEN
**The EICAR test cannot certify the malware scanner, and the go-live checklist says it can.**
`FileScanService` catches the EICAR signature **in-process, before it ever looks at `CLAMAV_HOST`**.
So a rejected EICAR upload proves the guard fired and proves nothing whatever about whether clamd is
reachable. Checklist item 3.10 as written would return a false pass on a deployment with no scanner.

The discriminating probe is a **clean control file** alongside it: 503 means no reachable scanner,
2xx means the bytes actually reached clamd. Read together, the pair is conclusive; either alone is
not.
- **Evidence**: SOURCE
- **Fix shape**: correct the checklist item, and keep both probes together.

### C-11 · MEDIUM · tooling safety · OPEN
**The shared probe helper silently changes passwords on whatever it is pointed at.**
`scripts/acceptance/_lib.mjs` `login()` rotates an account's password whenever
`mustChangePassword` is set — away to a handover value and back. Against the local rig that is
convenient and re-runnable. Against a real deployment it is an unannounced write to a live
credential, and a failed rotate-back locks somebody out.

This is also the full explanation of campaign defect T-03: a manual password reset cannot hold,
because the next probe run rotates it.
- **Evidence**: SOURCE
- **Fix shape**: a non-mutating sign-in for read-only certification, with rotation opt-in.

### C-07 · MEDIUM · audit truth · OPEN — confirmed live, assigned
**Archiving a person cancels their open assignments with no trail on the assignments.** The delete
cascade closes them with a raw `UPDATE` and bumps `entity_version`, but writes **no audit row
against any assignment it closed**. The only record is one `ASSAYER_DELETED` row on the assayer,
whose remarks name neither the assignments nor how many. "Why was my job cancelled?" is answerable
only by already knowing to look at the assayer's deletion.

This is the long-standing AC-F11, now reproduced by probe rather than inferred from code.
- **Evidence**: API · DB (`lifecycle-bypass.mjs`, finding DEL-07)
- **Dependent workflows**: assignment history, dispute handling, the audit trail's completeness claim

### C-06 · LOW · documentation · OPEN
**Reports cite numbers the source contradicts.** `@RoleOnly()` is 29 routes not 22; CI runs seven
db-specs not "six"; the lifecycle matrix is 121 ordered pairs not 150; go-live item 1.0 verifies via
`scratchpad/pa/tds-pan.mjs`, which is not in the repo, so the item cannot be executed as written;
`scripts/acceptance/README.md` documents 2 of 15 scripts with a `DB_PORT` that disagrees with every
script. Full list in [SYSTEM_MAP.md](SYSTEM_MAP.md) §7.
- **Evidence**: SOURCE

---

## Campaign defects (mine, not the product's)

Recorded because §26 requires the distinction, and because a test defect reported as a product
defect is worse than silence.

| # | what | class |
|---|---|---|
| T-01 | The baseline runner used `timeout`, which macOS does not ship. All 14 probes reported "command not found" and nothing ran. | test defect |
| T-02 | The runner set the path to the credentials file but never sourced it, so probes reading `AC_PASSWORD` directly aborted while probes reading the file passed. Six probes wrongly appeared to fail. | test defect |
| T-03 | Resetting `admin` to a memorable password desynchronised it from the other fifteen accounts, which remain on the harness password. The probes rotate passwords themselves, so a manual change does not hold. **Open — needs a decision.** | environment defect |
| T-04 | Three `lifecycle-bypass` checks failed (EMP-04, EMP-05, ELG-03) because the shared empanelment fixture was left at `REJECTED` by an earlier aborted run, where the checks expect `ACTIVE`. **Verified not a product defect**: setting an invented standing `BLACKLISTED` is refused `400` naming the seven legal values, and the row is unchanged. Recorded because calling this a product defect would have been the easy and wrong answer. | test defect |
| T-05 | `business-loop` aborts with `409 Cannot assign` — every branch its assayer may work is already engaged, because a completed audit closes its branch to further assignments. That is a product **rule**, not a fault; the probe needs fresh branches per run. | test defect |
