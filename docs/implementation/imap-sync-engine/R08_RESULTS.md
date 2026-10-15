# R08 — Account configuration and removal lifecycle

2026-10-15. **PASS for isolated R08.** Account lifecycle and local cleanup only;
the new receiving engine remains absent from production worker registrations.

Base: accepted R07 `fef3948987ea8c8a5320d3310bc2a8e61afea0d4`.
Branch: `feature/imap-sync-r08-account-lifecycle`.

## Configuration and lifecycle identity

Migration `0044_receiving_account_lifecycle.sql` completes the existing
`configuration_version` and `receiving_lifecycle_version` contracts. No second
configuration model, identity table, execution ledger or feature flag is added.

Configuration advances once for changed IMAP host, port, security, login,
encrypted password, authentication method, provider or provider principal.
Explicit grant replacement increments the same existing version in both Google
and Microsoft callback implementations, including reconnect to the same
principal with the same endpoint and server UIDVALIDITY. A combined reconnect
and endpoint/principal change still advances once. Arbitrary counter resets or
jumps are rejected.

Display name, sender identity/email, SMTP configuration, sent-copy policy,
diagnostic status, OAuth status and ordinary encrypted token/cache rotation do
not change IMAP configuration identity. Password account edits lock their read
and write together; resubmitting the same plaintext retains the original
encrypted envelope rather than creating a false identity change from a fresh IV.
Google and Microsoft refresh continue to use their existing credential paths;
this task does not implement R09 transport or change their network deadlines.

The existing account-demand trigger atomically records changed configuration
and re-enable demand. Configuration demand is also retained while disabled.
Existing R03 preparation/R06 recovery captures configuration and lifecycle before
wire work and compares both on publication. Enable/disable changes the lifecycle
counter without changing cache provenance. Disable/re-enable therefore rejects
an old captured lifetime even when configuration, epoch and UID repeat. Provider
work and saved diagnostics reject disabled accounts. Existing C4 reads retain
otherwise valid disabled-account cached mail.

Configuration replacement preserves committed placements and cache rows
physically. R05 filters their obsolete bindings; R06 SELECT/rebinding establishes
empty coverage under the new binding before new metadata is published. No
frontier or revision is reset by account editing. Pending commands/content
requests survive configuration and enable/disable transitions without settlement,
retargeting or automatic replay.

## Physical account removal

The existing account DELETE handler now invokes a closed local SQL lifecycle
capability. No account-removal path constructs an IMAP client or issues remote
message deletion. Removing local data does not remove server mail.

Small accounts use the unchanged R04
`maildock_receiving_terminal_remove(account, configuration, lifecycle)` function.
It retains its 128-folder, 4096-associated-row, 2 MiB and two-second atomic bounds,
its complete-account deferred check, worker-independent authority and existing
draft/outgoing RESTRICT refusal. Success still returns HTTP 204.

An initial bounded probe examines at most 129 folders and 4097 associated rows,
including diagnostic references. It avoids counting/materializing an entire large
account before deciding that atomic deletion is unsuitable. Exceeding the atomic
budget instead commits `mail_accounts.removal_requested_at` and `enabled=false`
together, advancing lifecycle once. This timestamp on the existing account is
the only durable cleanup state. The transition is terminal: ordinary edits,
re-enable, reconnect and new dependent business/remote writes cannot revive it.

Draft and outgoing dependencies are checked before that transition under account
UPDATE. Their INSERT/UPDATE paths take account SHARE, so a concurrent authored
dependency either commits first and causes refusal, or waits and is rejected
after terminal removal wins. No draft/outgoing record or blob snapshot is
silently deleted. API conflicts return HTTP 409 with an explicit dependency
message; lock/statement timeouts return retryable HTTP 503. A missing account
returns 404.

Large deletion returns HTTP 202 with `status: "removing"`. Account GET/list views
expose `removalStatus: "active" | "removing"`; Settings shows local cleanup in
progress, refreshes its account list and prevents editing the selected terminal
account. A retained terminal account is never reported as completed deletion.
Repeated DELETE during cleanup continues to report 202.

## Why the narrow cleanup extension is necessary

The negative control builds 1100 actual enrolled messages through bounded
receiving publication. Messages, placements, conversation members and
conversations alone exceed 4096 associated rows. The original R04 function
rejects this dataset atomically. Native account cascades cannot supply bounded
progress: receiving state is RESTRICT-protected, Stage 1 forbids ordinary state
deletion, and the terminal R04 deferred check requires the entire account absent
in the same transaction. Simply deleting smaller receiving scopes under its
original terminal scope fails that check.

R08 therefore adds an exact-row cleanup capability for an already terminal,
disabled account. Every guarded mutation compares its relation, operation and
complete OLD/NEW certificate. Mixed writes, another account's state and repeated
cleanup calls in one transaction are refused. Existing R04 bounded write,
revision and COMMIT helpers gain only this separate branch; their accepted
fallback bodies and the original terminal removal function remain unchanged.
The content search trigger skips its derived message UPDATE only for certified
terminal cache deletion. It cannot publish content through cleanup.

Cleanup removes leaf data first: commands, content, attachments, placements,
conversation members/references, notification events, messages and conversations.
Conversation redirects are cleared in separate bounded batches before parent
conversation deletion. Diagnostic references are detached with the original
SET NULL meaning, and roles are removed before folders. No message is deleted
until its account's dependent leaf rows have been removed. This prevents a
single message with many placements/attachments from expanding a batch through
unbounded referential cascades.

Once leaves are empty, each transaction removes at most one folder plus its
exact receiving-state row. The deferred check requires the complete folder
identity absent and the account still terminal at the captured configuration and
lifecycle. This also handles accounts with more than 128 folders. The last empty
account is removed through the original R04 terminal function. Standalone state
DELETE remains forbidden. Missing accounts make repeated queue deliveries no-ops;
old callbacks cannot recreate mailbox/message identity because account identity
checks and FKs still apply. No source UUID is reused by this lifecycle.

## Execution, recovery and resource bounds

Lock order remains coordinator SHARE, existing discovery/role advisory mutex,
account UPDATE, then folder/state when removing that complete folder. Leaf rows
are locked/deleted under the exclusive account lock after terminal admission.
Publication holding account SHARE may commit first; deletion waits. A publication
starting after the terminal transition fails account/lifecycle validation. All
mandatory Stage 1/R04 deferred checks remain installed.

Each cleanup transaction affects at most **32 leaf rows**, or one folder and its
state. The final account removal uses the original R04 bound. Application SQL
sets a two-second statement timeout and idle transaction timeout before calling
the function, with a one-second lock timeout. Cleanup additionally captures a
two-second DB-clock deadline before locks and checks it at deferred COMMIT.
There are no network operations inside these transactions.

The existing production worker registers two ordinary pg-boss queues for local
cleanup and repair. This does not register or activate the new receiving engine,
remove a legacy worker, refresh elected membership or route between engines.
One cleanup delivery performs at most 16 independently committed transactions
with local concurrency one, then yields. Startup repair and the existing pg-boss
minute scheduler rediscover terminal account rows with 32-ID keyset pages. A
missed enqueue, exhausted retry, canceled worker or restart leaves the account
timestamp and remaining rows as sufficient recovery evidence. No new process,
external service, persistent execution ledger or general cleanup framework is
introduced. The API does not need a successful queue send to make removal durable.

Leaf selection uses indexed account/message/mailbox predicates and local ctid
batches; no OFFSET or whole-account Node collection is used. Each batch has a
constant number of leaf-table probes and at most 32 exact-row mutations. Total
work scales with retained rows and folders; timeout does not mark completion.
New indexes are:

| Index                                     | Purpose                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `mail_accounts_removal_pending_idx`       | Partial ordered startup/periodic repair over terminal accounts only.           |
| `message_contents_cleanup_source_idx`     | Avoid full content scans for folder source FK probes.                          |
| `message_attachments_cleanup_source_idx`  | Bound folder source FK probes.                                                 |
| `application_events_cleanup_mailbox_idx`  | Locate and detach folder diagnostic references.                                |
| `conversations_cleanup_redirect_idx`      | Partial account/id lookup of remaining redirects before conversation deletion. |
| `drafts_cleanup_account_idx`              | Indexed retained draft conflict and account FK check.                          |
| `outgoing_messages_cleanup_account_idx`   | Indexed retained outgoing conflict and account FK check.                       |
| `notification_events_cleanup_account_idx` | Locate account notification batches.                                           |
| `notification_events_cleanup_message_idx` | Avoid full notification scans for per-message FK deletion probes.              |

Existing message/account, attachment/message, placement/mailbox/message,
command/account and conversation membership/reference indexes are reused.
Indexes add ordinary write/storage cost; there is no per-message polling index
or execution receipt. Blob registry and physical storage objects are never
deleted by either removal path. Existing reference-aware cleanup remains
responsible for unreferenced objects; staged/draft/outgoing/signature snapshots
keep their references intact.

## Validation

| Check                                                                                  | Result                                   |
| -------------------------------------------------------------------------------------- | ---------------------------------------- |
| Final selected 20-file receiving/account/OAuth regression run                          | **388/388 passed**                       |
| R08 lifecycle file within that run                                                     | **20/20 passed**                         |
| Final migration verification after removing a redundant unchanged-fallback NULL clause | **3/3 passed**, 17 intentionally skipped |
| Application and worker typecheck                                                       | Passed                                   |
| Repository lint                                                                        | Passed                                   |
| Changed supported-file Prettier and working/staged diff checks                         | Passed                                   |

The 388-case run includes Stage 1 safety (26), R03 admission/election/retirement
(39), R04 claim/publication/cache/bounded capabilities (136), R05 reads (21),
R06 bootstrap (31), R07 topology (45), R08 lifecycle (20), Google/Microsoft
OAuth persistence (34), OAuth routes (8) and existing account API/order/settings
regressions (28). There were no failures in this final selected run.

The final three-case migration run verifies atomic enrolled removal, expired
cleanup rollback and mixed/cross-account cleanup rejection using the saved final
migration. A textual comparison also verifies all four accepted R04 helper
fallbacks verbatim after stripping only the separate R08 cleanup branches; the
original terminal removal function is not redefined.

R08 fixtures use disposable PostgreSQL 17.6, all actual migrations, an ordinary
non-superuser schema owner, actual account HTTP handlers with the authenticated
owner gate stubbed, and independent postgres.js readers. The worker restart
control uses actual pg-boss registration/queues. Existing Google/Microsoft API
fixtures use disposable PostgreSQL 18.6 and mocked provider HTTPS/MSAL responses.
No external IMAP or OAuth service is contacted for R08.

Controls cover configuration/password/SMTP/display identity, routine refresh and
same-principal reconnect, disabled work, ABA, repeated epoch/UID, durable intents,
small enrolled removal, >4096-row removal, >128-folder removal, restart repair,
exact batch audit, draft/outgoing conflicts, late callbacks/delivery, concurrent
publication/removal, expired cleanup COMMIT rollback, lock timeout rollback,
mixed/cross-account cleanup refusal and shared local blob snapshots.

Development evidence is retained rather than represented as passing validation:
initial fixture definitions omitted required draft/mailbox columns; these were
corrected. A composite SQL result assertion was corrected to select its columns.
An initial 128-row cleanup batch exceeded the unchanged two-second deferred
budget with auditing enabled; the final capability uses the conservative Stage 1
32-row budget, without increasing deadlines or imposing a total mailbox limit.
The initial broad run also hit a receiving metadata fixture deadline; its large
dataset is now seeded in 32-record bounded publications with the same deadline.

Three older OAuth assertions failed on `JSON.stringify` of existing R02 bigint
identity fields. One bounded comparison on accepted R07 reproduced all three
failures. Their assertions retain every field and secret check, using a bigint
replacer, and now also assert unchanged refresh identity/one-step reconnect.
An initial elected lease-loss backend-count assertion failed; one isolated
accepted-base comparison passed. The final full election file passed **15/15** in the 388-case run. No existing election assertion or timeout was weakened.

Commands (all Vitest runs use `--maxWorkers=1 --no-file-parallelism`):

```text
node node_modules/vitest/vitest.mjs run tests/receiving-account-lifecycle.integration.test.ts tests/receiving-safety.integration.test.ts tests/receiving-publication.integration.test.ts tests/receiving-cache-publication.integration.test.ts tests/receiving-bounded-publication.integration.test.ts tests/receiving-claim-phase.integration.test.ts tests/receiving-active-reads.integration.test.ts tests/receiving-inbox-bootstrap.integration.test.ts tests/receiving-topology.integration.test.ts tests/receiving-admission.integration.test.ts tests/receiving-election.integration.test.ts tests/receiving-retirement-gate.integration.test.ts tests/account-settings.integration.test.ts tests/account-settings-api.test.ts tests/account-provider-flow.test.ts tests/account-order.integration.test.ts tests/account-order-api.test.ts tests/google-oauth.integration.test.ts tests/microsoft-oauth.integration.test.ts tests/google-oauth-routes.test.ts
node node_modules/vitest/vitest.mjs run tests/receiving-account-lifecycle.integration.test.ts -t 'ordinary state deletion|expired cleanup COMMIT|cleanup refuses mixed'
pnpm typecheck
pnpm lint
pnpm exec prettier --check <changed supported files>
git diff --check
git diff --cached --check
```

Docker settings were process-local:
`DOCKER_HOST=npipe:////./pipe/dockerDesktopLinuxEngine` and
`TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`.
Final logs/JSON are `TEMP/maildock-r08-final.{log,json}`,
`maildock-r08-final-migration.log`, `maildock-r08-typecheck.log`,
`maildock-r08-lint.log` and `maildock-r08-format-check.log`.
Development/baseline logs use the same TEMP `maildock-r08-` prefix. Baseline comparison checkout is
`TEMP/maildock-r08-baseline-fef3948`, with the same existing node_modules via a
junction. pnpm refused that junction; the comparisons used the installed Vitest
Node entry point directly. No dependency installation/change was required.

## Remaining dependencies

R09 still owns credential refresh cancellation/CAS, removing legacy refresh
network work from SQL and internal diagnostic HTTP transport. R10–R14 still own
execution/reconciliation of dormant old source-bound business intents. R15 owns
due settlement; R16 owns live membership reload/cancellation, production receiving
registration and cutover. Re-enabled accounts are eligible in persisted membership
selection; refreshing an already acquired fixed candidate set remains R16 work,
as explicitly excluded from R08. R17 owns ordinary secondary-folder receiving.

No push, merge, PR, R09 implementation, Dovecot benchmark or unrelated full-suite
run is part of this task. Stop after R08.
