# Incident: certification probe truncated `audit_events`

**Date:** 9 September 2026
**Environment:** certification database `fapoms` on `deploy-postgres-1`
**Real organisation data affected:** none
**Status:** cause fixed, data partially recovered, unrecoverable portion quantified below

## What happened

During the full-system certification run, a probe tested whether `audit_events` was genuinely
append-only by issuing `TRUNCATE audit_events` directly against the certification database. The
statement succeeded and returned `TRUNCATE TABLE`, erasing **5,621 rows**.

The probe was testing a real control and found a real defect. It should not have been run against a
database holding evidence. A snapshot, or a throwaway database built from migrations, would have
established the same finding at no cost.

## Why it succeeded

Immutability was enforced by two triggers declared `BEFORE DELETE OR UPDATE ... FOR EACH ROW`.
Postgres fires row-level triggers once per row; `TRUNCATE` removes rows without visiting them, so
neither trigger ran. `DELETE`, `UPDATE` of an ordinary column and `UPDATE` of the hash column were
all correctly refused — only this one event was unguarded.

The privilege required is table ownership, which the application's own database role holds.

## Recovery

| | |
|---|---|
| Rows before the truncate | 5,621 |
| Restored from the nightly dump taken at 02:31 the same day | 2,301 |
| **Unrecoverable** (written between 02:31 and the truncate) | **~3,320** |

The nightly backup lives in `~/backups/fapoms/daily`. Restoring it required stripping the
`\restrict` / `\unrestrict` meta-commands a newer `pg_dump` emits, which the psql 16 client in the
container cannot parse.

## Scope of the loss

Every lost row was a certification event. The real organisation, `FAPOMS Private Limited`
(`382c3718-89e5-41a2-ac29-ab5ec7900562`), holds **5 users and zero operational records** — no
assayers, clients, projects, branches, assignments or documents — and therefore had no audit history
to lose. Its record counts were identical before and after and were re-verified at the end of the
run.

## Detection worked even though prevention did not

`audit_chain` was untouched by the truncate and was left holding **4,754 seals referencing
`audit_events` rows that no longer existed**. The hash chain made the deletion unambiguous
immediately, which is the tamper-evidence the design intends. Prevention is the stronger property
and is what had been missing.

## The fix

Migration `1796900000000-AuditTruncateProtection` adds a statement-level `BEFORE TRUNCATE` trigger
to both `audit_events` and `audit_chain`. It must be `FOR EACH STATEMENT` — Postgres rejects a
row-level TRUNCATE trigger, which is precisely how the original pair came to miss the event.

Verified afterwards in a disposable database built from migrations, against the application's own
role: `UPDATE` of a column, `UPDATE` of the hash, `DELETE` all, `DELETE` filtered, `TRUNCATE`,
`TRUNCATE` of both tables in one statement, `TRUNCATE ... CASCADE`, and
`TRUNCATE TABLE ... RESTART IDENTITY` — **twelve vectors, all refused**.

## The limit of that protection, stated plainly

The application connects as `fapoms`, which **is a Postgres superuser**. Demonstrated in the same
disposable database:

```
ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable;   -- ALTER TABLE
DELETE FROM audit_events WHERE event_type='TEST_A';                -- DELETE 1
```

No in-database control can prevent this: a role that can redefine the schema can undo any trigger.
The append-only guarantee is therefore only as strong as the database role, and the role is
currently unrestricted. The chain still detected it (one orphaned seal).

Closing that gap is a deployment change, not an application change: run the API as a role that is
not the owner of the audit tables, or ship audit records off-box where the application cannot reach
them. It is recorded here as an open hardening item rather than attempted against a live deployment,
because a mistaken ownership change locks the application out of its own database.

## Reading the audit count afterwards

The current `audit_events` count is **not** an uninterrupted history. It is the 02:31 backup plus
everything written since the restore. Any analysis spanning 9 September 2026 must account for the
gap between 02:31 and roughly 14:15 UTC.
