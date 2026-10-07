# Phase 3G.3 — Runtime Reliability

This phase fixes two independent generic runtime issues observed during the live
Gmail smoke test. Neither correction depends on Google OAuth, Gmail paths, or
account provider identity. No OAuth provider code changes are required.

## pg-boss stately activation

Maildock pins pg-boss 12.33.7. Its `job_common_i3` index makes
`(name, state, COALESCE(singleton_key, ''))` unique for stately jobs in `created`,
`retry`, or `active`. One row in each of those states can coexist for a key.
An active run with a pending successor is therefore valid.

The original fetch SQL excludes active keys using periodically refreshed queue
statistics. A stale cache can select a pending successor beside an active row,
hit SQLSTATE 23505, return an empty batch, and repeat every two seconds. This can
also delay unrelated keys behind the conflicting candidate. Abrupt process death
leaves active rows until expiration and amplifies the problem.

`patches/pg-boss@12.33.7.patch` adds a correlated `NOT EXISTS` predicate only for
stately fetch selection. It checks a **live active row in the same queue and with
the same normalized singleton key**. The existing index and pg-boss's handling of
genuine concurrent-claim races remain intact. No PostgreSQL logging is suppressed.
This is a version-specific pnpm dependency patch, applied on frozen install and
in Docker through the existing `COPY patches` build step. No hand-edited installed
dependency is required after installation.

The RCA inspected the actual pg-boss 12.36.0 source and intervening release notes;
the newer source still uses the cached exclusion list for stately jobs. An upgrade
alone does not fix activation churn. Attempt fencing introduced in 12.35.0 is a
separate improvement and is not included in this narrowly scoped phase.

## Atomic enqueue coalescing

Delta producers, backfill polling, and backfill continuations use
`enqueueCoalescedSync`. It opens a pinned pg-boss transaction, obtains a
transaction-scoped advisory lock keyed by queue and singleton key, and performs
`findJobs(queued: true)` and, if needed, `send` using that same transaction.
The built-in pg-boss adapter provides `beginTransaction`; unsupported adapters
fail explicitly rather than falling back to an unlocked check.

| Existing state              | Incoming request                                                   |
| --------------------------- | ------------------------------------------------------------------ |
| Created                     | Coalesce into the existing pending run                             |
| Active, with no pending run | Insert one durable successor                                       |
| Retry                       | Coalesce without changing data, retry count, limit, or start-after |
| Active plus pending         | Keep the existing pending successor                                |

An incoming event is not discarded just because a run is active. A later run
reads current server state, including events after the active run's snapshot.
Coalesced delta reasons retain the first pending request's diagnostic reason;
the reason does not alter synchronization behavior.

Backfill coalesces only identical `mailboxId:frontier` keys. Distinct frontiers
remain distinct continuation jobs, including the existing five-second delay.
The poller continues to repair a crash between persisted progress and enqueue.
The new producer lock does not replace or alter the mailbox execution lock.

An active job failing can itself become a retry while its already-durable
successor remains created; this is an existing permitted stately transition.
This phase neither deletes those durable jobs nor rewrites pg-boss failure
accounting. New requests coalesce into existing pending work rather than adding
another created row. Existing retry budgets and backoff remain authoritative.

## Provider-owned ImapFlow lifecycle

Every short-lived client passes through `ImapSmtpMailProvider.createImap` directly
after construction, before `connect`, including injected event-capable factories.
`guardImapClient` attaches a persistent error listener, records the first failure,
and closes that client. Event-free test doubles may omit the optional event API;
real ImapFlow clients always expose it.

The guard checks recorded failure before protocol calls and after read/connect
promises and FETCH iterator steps. Provider code also checks after awaited
application sinks and content consumption, so a failure between protocol calls
cannot be mistaken for successful synchronization. Existing promise rejections
remain rejections and reach existing typed errors and durable retry handling.

Positive STORE, MOVE, and APPEND acknowledgements survive a later connection or
cleanup error. The listener stays attached through logout, mailbox close, and
late teardown events. Cleanup cannot revoke acknowledged success. A failure
while APPEND is in flight retains the existing uncertain-delivery result; no
automatic APPEND or MOVE retry is introduced. No raw error payload is logged.

The guard covers discovery, recent/delta/backfill sync, message commands,
attachments/content, connection tests, and Sent-copy append/recovery. IDLE keeps
its existing listener, close-driven reconnect loop, and backoff ownership.
There are no global exception/rejection handlers or no-op error suppressors.

## Recovery and scope

The 900-second sync expiration, supervision, retry budgets, mailbox advisory
locks, and graceful shutdown remain unchanged. An abrupt process death is
recovered by normal pg-boss expiration/retry. No shorter timeout or overlapping
retry is introduced to conceal stale active jobs.

Production files changed:

- `imap-smtp-mail-provider.ts`: use the lifecycle boundary and check failure at
  application-work boundaries; no synchronization or transport redesign.
- `imap-client-lifecycle.ts`: new client-scoped error ownership and checks.
- `coalesced-sync-job.ts`: new transaction-bound producer coalescing helper.
- `delta-sync-jobs.ts`: route enqueue through the atomic helper.
- `backfill-sync-jobs.ts`: route polling and continuation enqueue through it.
- pnpm workspace/lockfile and the pg-boss patch: reproducible dependency correction.

No OAuth contract, OAuth provider, database schema, command durability, SMTP,
notification, diagnostics, or shutdown implementation changes.

## Automated verification

`runtime-jobs.integration.test.ts` uses a separate disposable PostgreSQL container
and the actual patched dependency. Direct fetch SQL with an explicitly stale
active-key cache must succeed without 23505, skip blocked keys, run unrelated
work, and later run the successor. Concurrent independent producer pools,
created/retry coalescing, immutable retry metadata, backfill frontiers, and the
unique-index backstop are exercised. Direct SQL deliberately does not use the
library catch that would otherwise disguise a constraint violation as `[]`.

`imap-client-lifecycle.test.ts` includes a child-process test using a real
ImapFlow EventEmitter, proving process survival and typed operation failure
without global handlers. Further tests cover FETCH timeouts, application-work
boundaries, promise rejection, late cleanup events, acknowledged flag/MOVE
results, uncertain APPEND, and password/OAuth credentials. Existing IDLE tests
exercise an error event followed by close/reconnect. Existing protocol STORE,
Microsoft, manual IMAP, security, and synchronization tests remain required.

## Remaining live smoke verification

After the owner deploys a reviewed build:

1. Run Gmail discovery, recent, delta, and historical sync; monitor PostgreSQL
   logs for repeated same-key activation conflicts and verify unrelated mailboxes
   continue progressing.
2. Deliver new mail and change flags while delta is running; verify a successor
   eventually reconciles the new state.
3. Interrupt IMAP connectivity during sync; verify the affected operation fails
   and retries while worker/web processes remain alive and credentials stay valid.
4. Restore connectivity and confirm normal sync/IDLE recovery.
5. Verify Gmail and Microsoft/manual IMAP read/unread, flag/unflag, MOVE, sending,
   and Sent-copy behavior.
6. Perform a controlled worker restart and confirm durable job recovery through
   the existing expiration policy. Never delete live queue rows to make this pass.

Automated tests use local fixtures/disposable databases. They do not establish
successful external Gmail or Microsoft smoke verification.

## Validation results

- Complete unit/integration suite: 71 files, 823 tests passed.
- Security suite: 39 tests passed; Chromium browser security harness passed.
- Web and worker typecheck passed.
- Lint passed with no errors and one pre-existing unused-import warning in an
  ignored `.security-results/signature-settings-preview.mjs` artifact.
- Local Next.js production build and worker compilation passed.
- Frozen pnpm install passed locally and in Docker with pnpm 12.6.0.
- Docker Linux build stage and complete production runtime image passed with both
  dependency patches installed. Runtime-image checks verified the pg-boss live
  predicate and ImapFlow ESM/CJS STORE serialization and MODIFIED handling after
  production pruning and packaging. The Linux build image also passed 34 protocol
  and lifecycle tests.
- `git diff --check` passed.

All implementation changes remain uncommitted. Live containers and their data
were not changed by this phase's validation.
