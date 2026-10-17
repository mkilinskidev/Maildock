# R17 Gmail OAuth hotfix

Date: 2026-10-17. Starting HEAD: `4f67d749e3d6e6a28fe9e1a0bf01f044dca306f5`.
Branch: `feature/imap-sync-r17-secondary-mailboxes`.

**Decision: PARTIAL.** The hotfix is implemented; full regression remains failed.
No R18, live recovery, Gmail connection, push, merge or pull request is included.
The next activity is a clean, user-controlled real Gmail acceptance test.

## Audit recorded before implementation

The local read-only report at
`C:/Users/mateu/AppData/Local/Temp/Maildock-R17-diagnostics/R17_GMAIL_DIAGNOSTICS.md`
was available and read. It proves current credential blockage, not its initiating
cause. Neither `invalid_grant` nor a Gmail FETCH incompatibility is established.
The earlier `failed_remote_read` and `failed_before_execution` remain independent
unresolved failures. R16/R17 PARTIAL evidence remains unchanged.

Metadata: scheduler admission -> `runOneReceivingTurn` -> captured
`resolveConnection` -> `AccountsService.resolveReceivingConnection` ->
`resolveCredential` -> `GoogleOAuthProvider.accessToken` ->
`OAuthRefreshes.resolve/run` -> Google token POST -> encrypted grant CAS ->
owned metadata adapter. History currently includes all this within two seconds.

Typed content/STORE/MOVE/APPEND: scheduler -> `runReceivingOperation` ->
`boundary.validate` -> elected `operationConnection` -> captured configuration
read -> receiving credential binding -> the same account/provider resolver ->
owner/configuration/lifecycle validation. Prepared operations repeat this
validation after claim, potentially refreshing twice before one socket.

Google stores encrypted subject/refresh token only. `expires_in` is validated
but discarded. Every resolution refreshes; no valid access token is reused.
Microsoft uses its existing MSAL cache. Local calls already coalesce by account
(128 callers/allocations); cross-process authority is the database attempt UUID.
Success CAS binds grant/configuration/lifecycle and enabled/removal state.
Reconnect replaces the encrypted grant and increments configuration. Disable /
enable increments lifecycle. These identities must fence token reuse too.

The initiating caller's cancellation/deadline controls the shared refresh. An
issued exchange with lost/malformed response or cancellation conservatively
retains its marker and requires reconnect; it cannot safely be replayed. Existing
explicit provider no-issuance errors release only the matching claim. Before any
POST, cancellation/validation can safely release a definitely unissued claim;
the existing generic catch does not distinguish that case. Provider error text
must never enter logs. The existing Google non-OK classification is overly broad:
an arbitrary error string is not proof of no issuance.

Receiving membership and typed selection currently ignore OAuth availability.
Pending intents survive repeated pre-claim rejection, but user detail returns
only pending content and polls indefinitely. Settings already offers reconnect.
The minimal correction should reuse this action, expose availability with the
existing detail/account reads, and gate scheduling without changing demands,
frontiers, source identity, mutation uncertainty, or W/C/D admission.

## Final implementation

### Token reuse and credential identity

Google supplies the successful token response's actual `expires_in` to the
existing refresh resolver. Safe expiry is monotonic request-start time plus that
lifetime minus 60 seconds; response/SQL latency cannot extend it. Provider
lifetimes must be greater than 60 seconds and at most 24 hours. No lifetime is
invented for the old encrypted grant. The first use after process startup refreshes
once; subsequent metadata/content/command resolutions reuse the access token.

Each provider resolver retains at most 128 entries and 128 callers. An entry
binds account UUID, configuration version, receiving lifecycle version, principal,
provider, canonically ordered encrypted grant and SHA-256 of current provider
client credentials. Every hit and single-flight join checks current durable
identity, enabled/removal state, connected status, absence of an unresolved claim
and safe expiry. Account/configuration/grant/reconnect changes cannot inherit an
old entry. Expired/stale entries are discarded on lookup; capacity evicts the
oldest entry. Disabled/unavailable provider configuration also evicts reuse.

No access token or expiry is added to plaintext storage. Refresh-token rotation
still uses the existing encrypted grant CAS and database attempt UUID. Web and
worker have separate in-memory caches/coalescers; cross-process claim authority is
unchanged. There is no Redis, permanent cache table or extra service. Reconnect's
omitted-refresh-token fallback explicitly forces validation of the previous grant,
including when a local caller might otherwise join a cache hit.

A typed operation memoizes its prepared connection by its own combined AbortSignal
in a WeakMap. Post-claim validation still checks owner/configuration/lifecycle and
OAuth availability, without a second credential acquisition. It shares neither
sockets nor prepared connections across operations.

### Lifetime, failure classes and rotation uncertainty

Metadata preparation occurs inside the already admitted W/C slot, with a separate
ten-second signal/deadline. Shutdown/ownership loss and account retirement revoke
preparation. Allocation remains held until actual settlement, including a provider
that ignores abort. Only then does the existing fresh/history execution clock
start. History retains two seconds; receiving SQL retains its existing deadlines.
Locked authority/configuration/lifecycle validation remains before IMAP creation.
Typed operations retain their existing absolute ten-second lifetime. No scheduler,
poller, refresh worker, queue, extra lane or socket was added.

Allowlisted OAuth outcomes distinguish rejected grant, invalid/malformed response,
unknown exchange, cancellation/timeout before or after transport invocation and
configuration mismatch. Explicit provider errors proving no token issuance remain
retryable; an arbitrary error string is no longer proof of no issuance. Calling
fetch does not prove remote delivery, so lost responses remain uncertain.

Only a matching definitely pre-issue/no-token failure releases its claim. Issued
uncertain exchanges keep the marker and require manual reconnect; arriving callers
cannot replay them. Failure bookkeeping cannot revoke a replacement grant or set
reconnect-required back to connected. Installation configuration failure before
claim publishes only a bounded temporary category for the matching enabled
identity: no token request, claim or grant write. Restoring configuration permits
a real refresh and clears stale temporary presentation.

Migration 0055 adds only nullable `oauth_failure_category` to preserve sanitized
failure context for UI. There is no repair/backfill of the user's stuck records.
Normal credential rotation does not change source configuration/lifecycle.

### UI, blocked selection and resumption

Account views and message detail use the same fixed-message availability mapper.
Settings/list reuse their existing reconnect action. Reader state links to account
settings, distinguishes temporary problems from rejected authorization and unknown
renewal, and stops pending-content polling. Ready cached mail remains readable
with the same account warning. No error text claims a grant was revoked merely
because the exchange outcome is unknown.

A connected account with a non-null marker shows renewal pending, without
asserting whether it is still active or abandoned. This matters when lifecycle
invalidation correctly prevents an old refresh CAS from changing a newer account
state. The marker has no liveness timestamp; it is not cleared or replayed to
make the UI look connected. Persistent pending state offers settings/reconnect.

The existing 20-second folder-status read already loads the account; its response
now carries safe availability. A state transition reloads selected detail, so
successful reconnect/background retry clears stale presentation without a new
per-message account-status request. Successful reconnect retains the existing
configuration/demand lifecycle and safe original-intent recovery rules.

Membership suppresses reconnect-required metadata; typed selectors also exclude
unresolved claims. A reconnect-required metadata failure parks that captured
scheduler descriptor until membership/configuration changes. Temporary failures
use a 30-second eligibility pause based on existing update time and normal
heartbeat/wake opportunities. Active normal refresh claims do not themselves
remove metadata membership. Blockage creates no socket or new durable remote
attempt; demands, sources and F/E/R remain. Re-entry confers no replay right on
uncertain STORE/MOVE/APPEND.

### Structured diagnostics

Existing configured Pino logging emits only explicitly projected fields, with
best-effort output and no raw exceptions/provider bodies. Correlations use
operation/refresh UUIDs, without mail addresses, mailbox paths or message content.

| Event                   | Safe evidence                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `oauth.refresh`         | Start, successful CAS or failure category, issue status when known, elapsed time, retry/reconnect disposition          |
| `receiving.credentials` | Configuration/pre-claim unavailability; coarse metadata failure fallback                                               |
| `receiving.operation`   | Kind, last invoked allowlisted IMAP method, owned phase, timeout/cancellation/preflight or uncertain-mutation category |
| `receiving.publication` | Published versus unresolved durable failure result                                                                     |
| `receiving.account`     | Matching paused transition and successful authorization/reconnect                                                      |

Blocked/pre-claim diagnostics coalesce by fixed operation/category for 30 seconds,
in at most 128 keys. A superseded failure CAS does not report a false paused
transition. Worker control logging no longer copies an exception object. Last
invoked method is not proof of successful authentication/FETCH. Attempted MOVE or
APPEND uses `mutation_outcome_unknown` / `recover`, never a replay recommendation.

## Validation evidence

All fixtures use disposable databases and mock/local OAuth/IMAP. The full suite
sets a loopback port-1 `DATABASE_URL` guard; fixtures explicitly provision their
own databases. No active installation, real OAuth token or real Gmail was used.

### Complete regression and historical comparison

The serial full run finished **2062 passed / 7 failed / 2069 total**, in 135 files
(130 passed / 5 failed), **zero skipped**, with **one unhandled PostgreSQL driver
exception**, in **1807.58 seconds**. It began 08:27:50 Europe/Warsaw. It is a failed
run, not a full-suite PASS. No build or Compose workload ran alongside it.

The exact failures were:

1. Scheduler W1 complete-history control: E=129 rather than 1.
2. Scheduler W1 returning-history fresh barrier.
3. Scheduler healthy-versus-hung ordering, 23.915 ms late.
4. R17 manual Archive/restart `afterEach` exceeded the unchanged 120-second limit;
   no failed mapping assertion was reported.
5. R03 suspended owner: replacement election returned no owner, causing the test
   helper to read missing `actor`; stale-publication assertions were not reached.
6. New lost-MOVE diagnostic assertion: own MOVE claim helpers were incorrectly
   described using the outer shared claim variable. The corrected stage uses last
   invoked method and separately reports owned phase; execution authority is unchanged.
7. New connected-pending presentation assertion: presentation changes were made
   during the run, so it did not validate an unchanged final mapper/module tree.

The uncaught error was `postgres` `Immediate.nextWrite`, reading `write` on a null
socket, around the existing R10 post-claim configuration-change test. All 29 R10
assertions passed, but this exception makes that run unsuccessful.

R16/R17 PARTIAL evidence is untouched. Historical R17 full evidence remains
**2041 passed / 5 failed / 2046 total**. The current run adds 23 tests; these are
separate complete-run counts, not totals made by adding focused rechecks.

During this full run, final presentation/configuration-preflight refinements and
a diagnostic-only MOVE stage correction were made. Accordingly this is explicit
development/broad regression evidence, not a claimed closed-final-source green
run. Final-source focused, static and Docker results are recorded separately.

### Direct baseline comparison

A read-only archive of starting HEAD, under
`TEMP/maildock-r17-oauth-baseline-5a487b91a2`, shares the same installed dependencies
and Node/Vitest executable. No branch or checkout history was changed.

The same five original scheduler/R03/R17 cases ran serially without other tests,
builds or Compose beside either selection: baseline **5/5**, 39.04 s; hotfix
**5/5**, 39.01 s. Baseline had 53 unselected cases, hotfix 54 (one new scheduler
control). These selected bodies/assertions/deadlines are unchanged. This does not
explain, erase or retroactively pass their failures in the broader run. No fresh
complete baseline suite was run.

The complete unchanged baseline R10 file then passed **29/29 assertions** but
reproduced the **same unhandled `nextWrite` null-socket error** and exited 1,
41.23 s. This establishes that driver failure predates this hotfix in the shared
dependency environment; it is not evidence that the exception is harmless.

### Final-source focused controls

The final fresh six-file run passed **132/132**, zero skipped, zero unhandled
errors, in **87.69 s**, exit 0: Google 38, R09 37, R14 MOVE 45, reader 6,
structured diagnostics/state 5, existing OAuth redaction 1. It includes the
corrected MOVE stage, connected pending-claim presentation, cached-body warning,
configuration-unavailable/resume and token lifecycle controls. A preceding
final-source selection also passed 132/132 in 84.25 s; counts are not added.

The final diagnostic refinement omits issue status when MSAL/cache evidence does
not establish a token POST. Generic cancellation after provider entry remains
exchange-unknown; explicit Google transport/cancellation categories retain their
known issue boundary. Refresh safety/authority did not change.

Command (same six paths, serial):

```text
node node_modules/vitest/vitest.mjs run tests/receiving-move.integration.test.ts tests/google-oauth.integration.test.ts tests/receiving-credentials-diagnostics.integration.test.ts tests/mail-client-unread-count.test.tsx tests/receiving-diagnostics.test.ts tests/oauth-logging.test.ts --maxWorkers=1 --no-file-parallelism --reporter=default --reporter=json
```

Evidence: `TEMP/maildock-r17-oauth-final-focused.{log,json}`. The complete run
also exercised R08, R03, R10/R11/R13/R14/R15/R16/R17, production worker,
authentication/API/reader tests and full repository regressions; its failed
counts and limitations above remain authoritative.

### Earlier development evidence

- Initial OAuth/R09/logging selection: 58 passed / 7 failed, exposing canonical
  JSON binding order and obsolete arrival-as-expiry expectations. Binding is now
  canonical; the old expiry test advances the actual monotonic clock explicitly.
- Later four-file selection: 79/79 passed.
- Seven-file control: all 183 assertions passed, but exited 1 with the R10 driver
  exception. Its count does not replace the failed full regression.
- Development scheduler: 28/32, including the new preparation control passing;
  four failed names matched R17's previously recorded baseline comparison.
- An earlier full dispatch was interrupted for the MOVE diagnostic correction.
  Its incomplete log is retained; it is not an acceptance count.

No existing assertion, production operation/SQL deadline or test timeout was
relaxed. Final focused controls do not replace failed complete-run evidence.

## Resource / refresh measurements

The deterministic reuse control makes **12 concurrent plus 24 sequential
resolutions with exactly one mocked Google token request**. For a 3,600-second
response it reuses at 3,530 seconds and refreshes after 3,541 seconds. These are
resolver measurements, not real-provider throughput. The scheduler control delays
credential preparation **2,200 ms**, retains the **two-second** history execution
budget and checks executor retirement.

Blocked content/STORE controls exercise three repeated opportunities for each of
two OAuth failure classes: zero IMAP commands/new claims, pending intents retained,
exact frontiers unchanged. Existing W/C/D and one-mutation uncertainty controls
remain. Cache capacity is 128 entries; no worker-RSS bound is inferred from it.

## Build and isolated deployment

An initial normal production image build and fresh Compose smoke passed before
the final diagnostic/presentation refinements. The final-source build/smoke is:

**PASS.** Final normal Dockerfile image build:
`sha256:f1ef79e9045f9d540cc85f8c8f3522239b9d3cc004d05931dde5d27d215465b8`.
Both Next.js and compiled worker built successfully.

Fresh project `maildock-r17-oauth-final-2af68348d8` used normal base Compose,
separate generated fixture secrets and new project-prefixed volumes. Resolved
configuration was verified to have no external volumes, host mounts, published
host ports, fixed container names or pre-existing project containers. No active
installation was restarted, rebuilt or recreated.

Both app/PostgreSQL became healthy. HTTP live/ready returned **200/200**;
unauthenticated account API returned **401**. The fresh database had **56
migrations**. Idle post-start snapshot: app **477.1 MiB / 0.15% CPU**, PostgreSQL
**57.5 MiB / 0.10% CPU**. This is bootstrap/idle, not a synchronization or cache-heap
benchmark and not a promised VPS ceiling.

Only this project's containers/network were removed; fixture volumes were
retained. Shutdown/removal took **1,386 ms**. Final evidence is under
`TEMP/maildock-r17-oauth-final-deployment-1876631f903b/`.

**PASS:** application and worker typecheck (`pnpm typecheck`), repository ESLint
(`pnpm lint`), changed-file Prettier and Git whitespace checks. No full-suite
failure was suppressed or reclassified as a passing result.

Raw local evidence remains under `TEMP/maildock-r17-oauth-*.{log,json}` and the
project-specific deployment directories. Generated fixture secrets in those
directories must not be published; no private report, token or secret is committed.
No user container, database, OAuth record or volume was modified or reset.

## Remaining limits and decision

**PARTIAL.** Full-repository validation is not green: broad-run scheduler,
replacement-election and R17 cleanup observations remain unresolved, and the
baseline PostgreSQL driver exception remains. Passing targeted selections do not
close these observations. Final diagnostic/presentation controls are separate
from the failed full run; no closed-final-source full-suite PASS is claimed.

The initiating real Gmail OAuth error and the older `failed_remote_read` /
`failed_before_execution` causes remain unknown. The report proves excessive
refresh exposure and the current credential gate, not a specific Google rejection
or protocol incompatibility. Real Gmail acceptance remains user-controlled after
this hotfix; no R18, push, merge or pull request was performed.
