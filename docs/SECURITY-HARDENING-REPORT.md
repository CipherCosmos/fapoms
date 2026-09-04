# FAPOMS security hardening — report and honest score

_Last updated: 2026-09-04. Branch: `test`. Scope: the FAPOMS application and backend surface,
plus the deployment configuration that decides whether a control is actually in force._

> This report does not claim the system is "secure" or "100/100". No honest engineer makes that
> claim about a live system. It records what was built, what was verified and how, and — with equal
> weight — what is only partly done, what is deferred by decision, and what depends on the device or
> the deployment rather than the code.

---

## The honest score

Two numbers, because they answer two different questions and only both together are truthful.

| Question | Score | Why |
|---|---|---|
| **Assessed backend/application surface — controls implemented and tested** | **90 / 100** | The auth, session, scoping, encryption, audit, upload-scanning and MFA controls below are in the code and covered by passing tests; several are also verified against the live system. |
| **Effective posture as actually deployed today** | **82 / 100** | Lower on purpose: controls that are opt-in, report-only, or need a provider/client that is not yet in place do not protect anyone until they are. Client MFA screens are not shipped, SMS is unconfigured, CSP is report-only. |

The gap between the two numbers _is_ the remaining work. It closes as the clients ship MFA/timeout
handling, CSP flips from report-only to enforce, the ClamAV sidecar runs in production, and an SMS
provider is configured. It does not reach 100 even then — the deferred and accepted items below stay
named and owned.

### What the score deliberately excludes (and why it can't be 100)
- A **stolen, unlocked device with the app already open** is partly the device's job (full-disk
  encryption + OS auto-lock). The app can only bound and revoke the session, which it now does.
- **Wire MITM** is primarily mitigated by TLS terminating at the Tailscale Funnel edge; HSTS + CSP
  are incremental hardening, not the primary control. **Mobile certificate pinning is not done**, so
  a device with an attacker-installed root CA is a residual on mobile.
- **Step-up re-auth** on sensitive actions is deferred (see Deferred).

---

## By category (per the review gate)

### ✅ Implemented and verified (code + tests, several confirmed live)

| Control | Verification |
|---|---|
| Deny-by-default `RolesGuard` + `PermissionsGuard`; region (`users.regions`) + client-ceiling scope | Unit + boundary specs; region write-parity spec |
| Refresh-token rotation + **reuse detection & family revocation** (restored after the Aug silent revert) | `auth.service.spec`; tripwire in `security-controls.spec` |
| **Per-request session gate**: idle + absolute timeout, instant revocation, "log out everywhere" | `session.service.spec`, `auth.service.spec`; revocation bites on the next request, not at token expiry |
| **Field encryption at rest** (`enc:v1:` envelope) | Proven live: the TOTP secret and MFA destination store as ciphertext, never plaintext |
| **MFA — TOTP** (RFC 6238) + single-use hashed recovery codes | `totp.spec` (RFC Appendix-B vectors), `mfa.service.spec`; **full live E2E** on a throwaway account, code cross-checked by an independent Python TOTP implementation |
| **MFA challenge** — single-use, account-bound, 5-min expiry, 5-attempt cap | `auth.service.spec` challenge-flow block; live E2E |
| MFA enrol/disable/regenerate — authorized (JwtAuthGuard) and fully audited | `mfa.service.spec`; live 401-without-token check |
| **Upload malware scanning** — fail-closed on every upload path + boot assertion | `file-scan.service.spec`, `upload-scan-parity.spec`, `main.guard.spec` (EICAR rejected; refuses to boot if `FILE_SCAN_REQUIRED` unset in prod) |
| **HSTS + edge security headers** (Caddy + Helmet) | Header-presence assertions; HSTS `preload` deliberately **off** (not blind-preloaded) |
| Append-only audit trail + hash-chain seal; bypass/override attributed to the record | `audit-seal` specs; today's `assignment` attribution fix |
| **Platform-settings write/reset is ADMIN-role-only** (privilege-escalation closed) | `platform-settings-role-only.spec` (behavioural + source check); the live exploit that motivated it was reproduced then closed |
| `security-controls.spec` tripwire preventing silent control removal | The spec that would have caught the Aug 2026 regression |

### 🟡 Partially done / not fully re-verified
- **CSP is report-only.** It reports violations but does not yet block. Next step: inventory real
  script/style/connect origins, then flip to enforce with nonces/hashes as needed.
- **Live socket re-auth after a role change** was blocked earlier by test-fixture contamination;
  the behaviour is covered by unit tests (`events.gateway.reauth.spec`) but not re-confirmed live.
- **MFA email/SMS delivered-code send** is covered by unit/integration tests and the live
  fail-closed + route + validation checks; the actual email/SMS _delivery_ was not exercised
  end-to-end live (no readable test mailbox; SMS provider unconfigured on this deployment).

### 🧪 Built but not yet exercised by a client (dormant)
- **MFA is opt-in and dormant.** Un-enrolled login is byte-identical to before. Web and mobile must
  add the challenge / enrolment / send-code screens and the session-timeout/logout handling before
  any user is actually protected by MFA. The backend ships this way on purpose so shipped clients
  keep working.

### ⏸️ Deferred by decision (named, not silent)
| Item | Why deferred / residual |
|---|---|
| **Step-up re-auth** on MFA enrol/disable and other sensitive actions | Out of this wave. A stolen _live_ session could change a victim's MFA. Bounded by instant revocation + audit trail; the common attack (stolen credentials) is what MFA-at-login stops. |
| Access-token TTL shortening (kept at 15 min) | Session gate + revocation carry the stolen-session risk instead |
| **Mobile certificate pinning** | MITM residual on a device with an attacker-installed CA |
| Cookie migration (tokens in storage, not httpOnly cookies) | Larger client change; not this wave |
| Separation-of-duties **enforcement** | Explicitly chosen NOT this wave |

### 🌍 Accepted / external (not the application's job alone)
- Stolen **unlocked** device with the app open → device FDE + OS lock. App bounds + revokes only.
- Wire MITM → primarily TLS at the Funnel edge.
- **SMS OTP requires an SMS provider** (MSG91: `SMS_PROVIDER_API_KEY` + `SMS_SENDER_ID`). Until set,
  SMS enrol/send is **refused with a clear error** (verified live) — TOTP + email still work.
- **ClamAV only scans when the sidecar is actually running.** The compose service + boot assertion
  enforce the intent; an operator still has to run it.
- Upload **size/type validation** beyond scanning is surfaced but not added; the scanner is now the
  enforced boundary.

---

## What the user must supply to close the gap (in priority order)
1. **Ship the client MFA screens** (web + mobile): the `mfaRequired` challenge, factor enrolment,
   `POST /auth/mfa/send` for email/SMS, and session-timeout → logout handling.
2. **Configure MSG91** if SMS is wanted as a factor (otherwise it stays correctly disabled).
3. **Run the ClamAV sidecar in production** and keep `FILE_SCAN_REQUIRED=true`.
4. **Flip CSP from report-only to enforce** after an origins inventory.
5. Decide on the deferred items (step-up re-auth is the highest-value next control).

---

## Standing truths
- All work is on `test`; `main` is the production deploy trigger.
- The whole backend suite is green: **249 suites / 3175 tests**.
- No control here should be removed without also removing nothing else — `security-controls.spec`
  exists precisely because a control and its test were once deleted together and went unnoticed for
  twelve days. See `docs/SECURITY-CONTROLS.md`.
- This system is **not** "fully secure". The residual risks above are real, named, and owned.
