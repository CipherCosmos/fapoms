# Security controls, and why they keep disappearing

If you arrived here because `security-controls.spec.ts` failed, skip to
[What to do when the spec fails](#what-to-do-when-the-spec-fails).

## The failure this exists to prevent

On **20 August 2026**, commit `83925654` — *"security: enforce forced password change server-side,
and close five more findings"* — shipped a hardening batch with its tests.

The **same day**, `7c9ee664` — *"fix(roles): finish the rename, and reconnect the roster to its own
detail page"* — was merged. It was **39 files, 211 insertions, 720 deletions**, from a branch forked
*before* the security batch. It merged over it and took most of it back out.

Seven controls vanished:

| Control | What its absence means |
|---|---|
| `mustChangePassword` enforcement in `JwtAuthGuard` | A temporary password never has to be changed. The flag is written and returned, and nothing reads it. |
| **`handleRefreshTokenReuse`** — reuse detection / family revocation | **A stolen refresh token is replayable indefinitely.** |
| `DUMMY_BCRYPT_HASH` login timing equalisation | Usernames are enumerable by response time. |
| `feedbackVerdict` socket-room entitlement | Any authenticated socket joins any feedback thread by UUID. |
| `allowSubscribeAttempt` per-socket budget | Unbounded room subscription. |
| `issueFreshSessionForUser` | No session continuity after a password change. |
| `utils/url.ts` `javascript:` sanitiser | XSS vector on client website links. |

Also lost in the same window: `select: false` on `users.password_hash` (so the staff bcrypt hash
loads by default, into the Redis-cached principal), `revokeAllSessions` on password change, and the
expense self-approval block.

**It went unnoticed for twelve days.** A prior audit note recorded every one of these as "fixed and
shipped" and advised against re-auditing them — so the written record actively pointed away from
live holes.

## Why CI did not catch it

**CI was not broken. It was answering the question correctly.**

Each control's unit test was deleted in the *same commit* as the control. `guards.ts` lost 50 lines;
`guards.spec.ts` lost 42. With no test asserting the behaviour, a green build is the right answer.

The lesson generalises: **a test cannot protect the code it lives beside**, because the commit that
removes one naturally removes the other. Coverage measures what is tested, not what *should* be.

Two things compounded it:

1. **No CODEOWNERS**, so a 720-line deletion touching the auth module needed no security reviewer.
2. **CI did not run on the working branch.** The workflow triggered on `main` only, while
   development moved to `test` — so commits got no verification at all until a pull request. Both
   are fixed as of 2026-09-01; the CODEOWNERS gate additionally needs *"Require review from Code
   Owners"* enabled in branch protection, which is a repository setting, not a file.

## How the tripwire works

`packages/backend/src/security-controls.spec.ts` holds a registry of
`{ id, file, marker, why }` and asserts each `marker` string still appears in its `file`.

Three deliberate properties:

- **It lives outside every module it protects** and is named after none of them, so a commit
  removing a control has no reason to open it.
- **It fails loudly with the reasoning**, not a diff — the error prints `why`, so the next reader
  learns what the control was for rather than just that a string moved.
- **Removing an entry is still possible**, but requires editing the registry and writing over a
  justification. That is a deliberate act visible in review, not a silent side effect of a merge.

### What it is not

**A tripwire, not a test.** It proves a control is still *wired*, never that it still *works*.
Behavioural tests remain the place for that; this is the backstop for when those tests are deleted
too. A marker can also be defeated trivially by someone who wants to — that is fine. It is built to
catch the accident, which is what actually happened, not an insider.

## What to do when the spec fails

1. **Read the `WHY IT EXISTS` line in the failure.** It says what protection was lost.
2. **Did you mean to remove it?**
   - **No** — you have hit a merge that reverted a control. Restore it. Check what *else* the same
     commit removed: `git show <sha> --stat` and look for other files under
     `modules/auth/`, `infrastructure/security/`, `infrastructure/scope/`.
   - **Yes** — delete the entry from the registry **in the same commit** and say why in the commit
     message. If the control moved or was renamed, update `file`/`marker` instead of deleting.
3. **If the marker is stale but the control is intact** (a rename, a refactor), update the entry.
   Prefer a marker that is hard to change without changing behaviour.

## Markers must be code, never prose

A marker is a substring of the file, so a sentence from a comment satisfies it just as well as the
control does. Three entries were written that way — anchored to "cheaper to hammer than login", to
"Synchronous xlsx.write blocks the event loop with no yield", and to an OSRM `SECURITY:` note.
Every one of those controls was genuinely present, so nothing was broken; but each tripwire would
have kept passing after its control was deleted, as long as the comment above it survived.

That is this document's own incident reproduced inside the safeguard: a green check that means
nothing. The registry now asserts it — `anchors every control to code, never to a comment
describing it` — so a prose marker fails at the moment somebody writes one, rather than at the
moment somebody needed it to work.

The same mistake turned up in two other source-scanning specs on the same day, both of which were
matching text from neighbouring lines rather than the code they guarded. If you are writing a spec
that reads source, strip comments before you match.

## Adding a control

Add an entry when the control is one whose *absence is silent* — nothing fails, no user complains,
and the system behaves normally right up until it is exploited. That is the whole selection rule.
Encryption transformers, redaction interceptors, guard defaults, scope filters and append-only
constraints qualify. A validation rule that produces a visible error when removed does not need one.

Write `why` for someone who has never seen the control before and has to decide, under time
pressure, whether restoring it is worth their afternoon.
