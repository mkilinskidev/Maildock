# R09 — Credential resolution and owned connection diagnostics

2026-10-15. **PASS for isolated R09**, with the recorded R08 fixture timing failure and successful unchanged recheck below. Integration on
`feature/imap-sync-r09-credentials-diagnostics`, based on accepted R08
`f9951edcad7b883c0bfda7240fd65d733e6b4f92`.

## Credential and grant identity

Google and Microsoft credential acquisition now has three distinct phases: a
short account-row claim/read, external OAuth work without a database transaction
or reservation, and a conditional encrypted-cache update. Credential claim, CAS
and post-resolution identity reads use short application-pool transactions with
at most two-second statement/idle budgets, a one-second lock timeout and the
remaining caller deadline. Failure bookkeeping after cancellation has its own
bounded two-second SQL scope and cannot return credentials or resume IMAP. Revocation is checked before and after their work,
including after a delayed pool acquisition. The existing credential
store, encryption contexts and provider registrations remain in use. Migration
0045 adds only `mail_accounts.oauth_refresh_attempt` and the coordinator's
non-secret `diagnostic_endpoint`; there is no credential/RPC table or new queue.

The refresh claim is a random UUID on the existing account row. Commit compares
that UUID, the captured configuration and lifecycle versions, the encrypted grant
snapshot, enabled state and terminal removal state. Routine token/cache rotation
does not advance configuration identity. Explicit reconnect still advances the
R08 configuration version once, resets diagnostic status, retains durable demand
and clears the old refresh claim. An old success or failure cannot overwrite or
revoke this replacement grant. Disable/re-enable and physical removal also fence
old results. No credential operation re-enables an account.

Each provider instance coalesces acquisitions by account and bounds both live
acquisitions and callers at 128. Cross-process callers cannot concurrently consume
the same grant: the account claim refuses the loser. It does not hold a row lock
while awaiting OAuth. A process crash, lost/malformed token response, cancellation
or otherwise uncertain rotation leaves the claim closed to replay; reconnect is
required. Explicit Google/Microsoft OAuth error responses indicating no issuance remain
retryable, while `invalid_grant` requires reconnect. Installation configuration
errors are detected before claiming the account. This deliberately changes the
old network-error behavior, which permitted blindly replaying an uncertain grant.

Google's reconnect fallback now resolves the previous grant outside SQL and
compares the resulting snapshot again under the short reconnect lock. Microsoft
cache plugins operate only in memory; they never call SQL during MSAL network
work. Only the final successful cache snapshot is encrypted and committed.

## Cancellation, deadlines and admission

Refresh has an absolute monotonic deadline of at most ten seconds, intersected
with the caller's deadline/signal. Google fetch and the explicit MSAL network
client use the same signal throughout discovery/token exchange and response
reading, disable redirects, and bound JSON responses at 1 MiB. A Microsoft client
permits only one grant POST, preventing a library retry from replaying a possibly
rotated grant. Google reconnect code exchange, identity lookup and fallback share
one deadline.

There is no `Promise.race` timeout pretending to abort an underlying operation.
If a transport/library does not settle after cancellation, its provider allocation,
account claim and receiving W/C allocation remain occupied through actual
settlement. Late completion cannot construct IMAP or publish diagnostic status.
The inherited R03/Stage 4B remote-session limitation during arbitrary process
suspension remains; SQL fencing does not instantly retract a remote socket.

`receivingCredentialBindings` supplies DB-only elected loaders. The acquisition
snapshot contains an unusable connection placeholder; admitted metadata and typed
operations resolve the captured saved credentials outside the receiving executor.
The elected control gateway revalidates owner, enabled account, configuration and
lifecycle after resolution. Metadata subsequently performs its existing R06
locked identity recovery. Operation cancellation includes scheduler/owner loss.
Construction still occurs exclusively through the existing single-use owned
client factory and R03 W/C/D accounting. No provider helper creates a second
receiving client.

## Authenticated internal HTTP RPC

One small listener runs in the existing worker process. The default and base
Compose endpoint is `http://127.0.0.1:3001`: web and worker already share the app
container. Compose exposes only the existing application port; neither base nor
development Compose publishes the RPC port. No proxy route or new service is
introduced. A split-process/container deployment may set
`MAILDOCK_DIAGNOSTIC_ENDPOINT` to a private reachable HTTP origin through its
deployment override; its worker must bind that address and web must use the same
configuration. The endpoint must never be published through the public proxy.

RPC bodies use the existing AES-256-GCM encryption with separate request/response
AAD. A domain-separated HMAC-SHA256 using the existing `AUTH_SECRET` authenticates
the encrypted body before decryption, in both directions. Thus private HTTP
carries encrypted credentials and does not rely on Docker location for trust.
There is no credential in a URL, plaintext authorization header, job, notification
or durable RPC record. Authentication failures and exceptions never log bodies or
raw provider errors.

Routing reads the current unexpired coordinator actor/generation and advertised
endpoint once. The client pins that address to deployment configuration, sends
the expected term, and verifies response term/request identity. Advertisement is
conditional on the locked live term. Takeover/release clears the old address;
an old term cannot overwrite or clear its successor's advertisement. Followers
refuse admission before loading credentials. There is no automatic retry,
redirect, owner rediscovery/replay or direct web IMAP fallback.

Bounds are 28 KiB encrypted request, 2 KiB encrypted response, 2 KiB HTTP headers,
16 requests per listener/client and 32 accepted listener sockets. At most 128
request IDs/expiries are retained in the transient replay cache for the original
request lifetime; it contains no credentials. The R03 plaintext connection and
envelope bounds still apply. Strict schemas reject unknown fields and invalid
identities/credentials. The wire carries expiry plus remaining budget rather than
cross-process monotonic timestamps, capped at ten seconds without extending the
original expiry. Disconnect, shutdown and expiry abort admission. Resources remain
owned until underlying handler settlement even after the caller has disconnected.

## Diagnostic result semantics and SMTP isolation

Public saved, edited-saved and unsaved account-test routes now use this RPC for
IMAP. Existing `{ result: { imap, smtp } }` response shapes are retained. An absent,
follower, expired or lost owner yields a sanitized failure with `retryable: true`.
An unknown response outcome is never treated as success or automatically replayed.

Saved and edited-saved tests occupy the account's existing C=1 slot. Unsaved tests
occupy W and a bounded ephemeral identity slot without creating account/queue
rows. The diagnostic handler only authenticates and retires the owned IMAP client;
it never SELECTs, enrolls a mailbox or establishes epoch/coverage/sync state.

Only a saved test with no override can publish IMAP status. Its short SQL function
locks and validates the owner/account identity, and a deferred check validates the
owner, configuration and lifecycle again at COMMIT. The publication certificate is single-use within its transaction. Edited input never verifies saved settings. The web-side
SMTP status update compares captured configuration/lifecycle and SMTP fields;
concurrent SMTP edits cannot be verified by an old response. Errors crossing RPC
contain only the allowlisted categories, never provider messages or tokens.

SMTP remains outside receiving W/C/D and uses its existing transport for sending
and verification. Verification now accepts caller cancellation and closes its own
transport. IMAP unavailability does not prevent SMTP testing. A saved OAuth test
finishes IMAP credential acquisition before starting SMTP, avoiding a web/worker
race against its own refresh claim; password tests remain parallel. SMTP refresh
uses the same bounded provider resolver, with no database connection retained
across network I/O, including an application pool of size one.

## Validation

**265 distinct selected tests passed in 20 files across the runs below.** This is
not a claim that the first combined invocation was entirely green.

| Check                                                               | Result                                                                        |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Broad receiving/account/OAuth/config/Compose run, 17 files          | 232/233; one existing R08 seed transaction exceeded its two-second deadline   |
| Entire unchanged R08 file, isolated recheck                         | 20/20 passed, including the 1100-message negative control and restart cleanup |
| Final credential/diagnostic and Google/Microsoft files after review | 71/71 passed: R09 37, Google 27, Microsoft 7                                  |
| Existing IMAP/SMTP provider and SMTP delivery tests                 | 26/26 passed in two files                                                     |
| Targeted existing core account connection/removal case              | 1/1 passed; 15 unrelated cases intentionally skipped                          |
| Application and worker typecheck                                    | Passed                                                                        |
| Repository lint                                                     | Passed                                                                        |
| Changed supported-file formatting and working/staged diff checks    | Passed                                                                        |

The broad run passed R03 admission (20), election (15), retirement (4), Stage 1
safety (26), R04 pre-network claims (17), R06 bootstrap (31), Google/Microsoft
persistence (34), OAuth routes (8), account Settings/API/provider flow (15),
configuration (8) and Compose ingress (2). Its then-32 R09 cases passed. The final
R09 file adds SQL lock-budget, explicit Microsoft no-issuance and deferred
COMMIT identity controls, bringing it to 37. The R08 failure occurred in the
existing metadata seed, before the tested removal path; no R08 test, assertion,
batch size or deadline changed. Its complete isolated rerun passed. The legacy core account fixture now injects
the owned diagnostic and SMTP test ports explicitly; its old direct provider
stub throws if called. Its existing success/failure/removal assertions pass.

Commands used (all Vitest invocations use `--maxWorkers=1 --no-file-parallelism`):

```text
pnpm exec vitest run tests/receiving-credentials-diagnostics.integration.test.ts tests/receiving-admission.integration.test.ts tests/receiving-election.integration.test.ts tests/receiving-inbox-bootstrap.integration.test.ts tests/receiving-account-lifecycle.integration.test.ts tests/receiving-retirement-gate.integration.test.ts tests/receiving-safety.integration.test.ts tests/receiving-claim-phase.integration.test.ts tests/google-oauth.integration.test.ts tests/microsoft-oauth.integration.test.ts tests/google-oauth-routes.test.ts tests/account-settings.integration.test.ts tests/account-settings-api.test.ts tests/account-provider-flow.test.ts tests/oauth-logging.test.ts tests/config.test.ts tests/security/ingress-compose.test.ts
pnpm exec vitest run tests/receiving-account-lifecycle.integration.test.ts
pnpm exec vitest run tests/receiving-credentials-diagnostics.integration.test.ts tests/google-oauth.integration.test.ts tests/microsoft-oauth.integration.test.ts
pnpm exec vitest run tests/mail-provider.test.ts tests/outgoing-provider.test.ts
pnpm exec vitest run tests/core-platform.integration.test.ts -t "records separate connection outcomes and deletes an account"
pnpm typecheck
pnpm lint
node node_modules/prettier/bin/prettier.cjs --check <changed supported files>
git diff --check
git diff --cached --check
```

Docker settings were process-local:
`DOCKER_HOST=npipe:////./pipe/dockerDesktopLinuxEngine` and
`TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`. Evidence remains in
`TEMP/maildock-r09-final.{log,json}`, `maildock-r09-r08-recheck.{log,json}`,
`maildock-r09-final-credentials.{log,json}`, `maildock-r09-final-rpc.{log,json}`, `maildock-r09-smtp.log`,
`maildock-r09-typecheck.log`, `maildock-r09-lint.log` and
`maildock-r09-format-check.log` and `maildock-r09-core-account.log`. Earlier development runs have the same R09
prefix; they are not substituted for final passing evidence.

Fixtures use disposable PostgreSQL with all migrations, an ordinary application
schema owner and independent readers for versions, grant/cache/status and SQL
activity. R09 exercises actual internal HTTP, public Next account-test handlers
with only their owner-access gate/session binding stubbed, the real elected
coordinator/executor, scripted TLS IMAP, real MSAL with deterministic OAuth
responses, and a stalled real HTTP token endpoint. Deterministic barriers cover
refresh/reconnect, lifecycle changes, cancellation, takeover and settlement.

Coverage includes Google/Microsoft network work outside receiving SQL, refresh
coalescing/CAS, unchanged refresh identity, superseded grants, unabortable late
completion, actual transport abort, metadata candidate revalidation, saved C=1,
edited status isolation, unsaved W/no persistence, authentication/size/schema/
replay rejection, follower refusal, term-bound advertisement, disconnect/expiry,
lost response without replay, sanitized errors, disabled/removing/deleted accounts,
pool-one SMTP and multiple-account W bounds. Existing R03/R06/R08, Stage 1/R04,
OAuth/account/provider and SMTP regressions are selected separately from unrelated
application-wide suites. No Dovecot benchmark is run.

Development failures are retained in TEMP logs: the initial Google expectations
for uncertain responses were updated to require reconnect, and the test-only
provider now asserts the added identity/deadline argument. Fixture corrections
used the peer's actual cleanup API, the R08 removal API instead of forging a
terminal transition, and MSAL's serialized `expires_on` fields when expiring test
tokens. An intermediate run read an in-progress syntax edit and failed to load two
files; the corrected final source is revalidated. The Compose allowlist is extended
for the explicit internal endpoint while retaining both no-publication assertions.
MSAL wraps network errors, so explicit no-issuance is carried through a trusted
in-memory callback rather than inferred from its exception text. Its regression
preserves retryability without replaying an unknown grant. No authority assertion
or existing deadline is relaxed.

## Remaining integration boundaries

The production listener intentionally has no elected lifecycle bound in R09.
It refuses IMAP execution until R16 supplies the elected coordinator. Public IMAP
tests therefore return retryable unavailable in the intermediate production
composition, while SMTP tests/sending remain usable. The isolated composition
validates the full owned diagnostic path without starting production receiving.
This is an isolated stage, not a receiving cutover or a production-provider claim.

R10–R14 still own business operation execution/reconciliation. R15 still owns due
settlement. R16 must bind listener access to the elected lifetime, integrate its
advertisement/retirement and install these credential bindings in production
alongside membership reload and the coordinated worker cutover. R17 still owns
ordinary secondary synchronization. No flag, dual-engine routing, legacy worker
removal, R10 implementation, push, merge or PR is included. Stop after R09.
