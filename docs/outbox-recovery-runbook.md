# When completed work stops becoming money

The outbox is what carries "this audit is finished" from the assignment to the ledger. If it
stalls, assignments keep completing and no payables or client lines appear behind them — and
nothing on any screen says so, because every dashboard reports what *is* booked, not what should
have been.

This is the operational surface for that, and **it is deliberately API-only**. There is no screen.
That is a decision, not an oversight: the recovery actions are destructive-adjacent (replaying an
event re-runs a business effect), they are needed rarely, and they belong to one named person. If
that decision is revisited, the endpoints below are what a screen would call.

**Everything here requires the DEVELOPER role and nothing else grants it.** Verified: ADMIN,
OPERATIONS and AUDITOR are each refused `403` on `/admin/outbox/health`. The controller is
`@Roles(DEVELOPER)` **and** `@RoleOnly()`, so a custom role holding every platform SYSTEM grant is
refused too. Creating that account is item 2.1 of the go-live checklist; until it exists, none of
this is reachable by anybody.

## Getting a token

```bash
FAPOMS=https://your-deployment/api/v1
TOKEN=$(curl -sS -X POST "$FAPOMS/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"<the developer account>","password":"<its password>"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["accessToken"])')
```

If the account was just created or reset, the first response carries `mustChangePassword: true`
and **every subsequent request will answer 403** until the password is changed — the gate is
enforced on each request, not only at sign-in. Change it with
`POST /users/me/change-password {"currentPassword":…,"newPassword":…}` and sign in again.

## 1. Is the outbox healthy?

```bash
curl -sS "$FAPOMS/admin/outbox/health" -H "Authorization: Bearer $TOKEN"
```

```json
{"pending":0,"deadLettered":0,"retrying":0,"oldestPendingAgeSeconds":null,"maxAttempts":15}
```

Read it like this:

| field | healthy | what a bad value means |
|---|---|---|
| `pending` | near 0 | events waiting. A few in flight is normal; a number that only grows means nothing is draining |
| `oldestPendingAgeSeconds` | null, or seconds | **the one to watch.** Minutes means the relay is behind; hours means it is not running |
| `retrying` | 0 | deliveries failing and backing off — look at a dead letter's `lastError` for why |
| `deadLettered` | 0 | events that exhausted all 15 attempts. These will never be delivered without a replay |

**If `oldestPendingAgeSeconds` is large and `retrying` is 0, the worker is not running.** That is
the most common cause and it is not an outbox problem: check that the `backend-worker` container is
up and healthy. An API-only deployment processes no background jobs at all — no outbox drain, no
audit sealing, no retention.

## 2. What failed, and why?

```bash
curl -sS "$FAPOMS/admin/outbox/dead-letters" -H "Authorization: Bearer $TOKEN"
curl -sS "$FAPOMS/admin/outbox/dead-letters/<id>" -H "Authorization: Bearer $TOKEN"
```

The detail carries `lastError`, `attempts`, `failedAt`, the `eventName` and the `subject` — the
assignment or payable the event was about. **Read `lastError` before replaying anything.** A replay
re-runs the same delivery; if the cause is still present it will fail again and consume another 15
attempts.

## 3. Fix the cause, then replay

```bash
curl -sS -X POST "$FAPOMS/admin/outbox/dead-letters/<id>/replay" -H "Authorization: Bearer $TOKEN"
```

A replay clears `failedAt`, resets `attempts` to 0, and stamps `replayedAt` and `replayedBy` with
the developer's own id, so the trail says who re-ran it.

**Replay is not a way to re-trigger a delivery that worked.** An event that is not abandoned is
refused with `409` and this sentence:

> Outbox event … has not been abandoned — it is on attempt 0 of 15 and the relay is still
> retrying it.

That refusal is the protection against deliberately booking the same money twice. Do not work
around it.

## 4. Money that never got booked

If assignments completed while the outbox was stalled, the events may be gone rather than
dead-lettered. The reconciler finds and repairs that without needing the events at all:

```bash
curl -sS "$FAPOMS/billing-engine/reconcile/preview" -H "Authorization: Bearer $ADMIN_TOKEN"
curl -sS -X POST "$FAPOMS/billing-engine/reconcile" -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{}'
```

These are ADMIN/OPERATIONS, not DEVELOPER. `preview` counts completed assignments with no **live**
payable or client line; `reconcile` books exactly the missing legs. It is idempotent — running it
twice changes nothing the second time — and it is the supported repair for a redone audit whose
money was never booked. Verified end to end: detect → repair → second run is a no-op.

## 5. When to escalate

Escalate to whoever owns the deployment if:

- `oldestPendingAgeSeconds` keeps growing after the worker is confirmed running — the relay is
  reaching the database but not the queue, or Redis is unreachable;
- the same event dead-letters again immediately after a replay, with the same `lastError`;
- `deadLettered` is more than a handful, which means a systemic failure rather than one bad event;
- `reconcile/preview` reports a count that does not fall after `reconcile` — the repair is failing,
  and the worker log names the reason.

## What was verified, and when

10 September 2026, against the production-shaped acceptance stack, 12 of 12 checks:
health, list, detail and replay all answer for DEVELOPER; ADMIN, OPERATIONS and AUDITOR each
refused 403; a manufactured dead letter was listed, its `lastError` shown, replayed successfully
with `replayedBy` recorded, and a second replay correctly refused 409.

Probe: `scratchpad/pa/outbox-recovery.mjs`.
