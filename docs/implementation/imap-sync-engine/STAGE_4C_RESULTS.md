# Stage 4C — Worker cutover compatibility blocker

2026-10-14. **BLOCKED. Stage 4C is not implemented or accepted.**

Base: accepted Stage 4B `5e7084a3ec7fcd836aeba396f9d9ef5b1c625914`.
Branch: `feature/imap-sync-stage-4c-worker`, created from the clean accepted base.
This commit adds executable blocker evidence and this report. Application code,
migrations, worker registration and receiving fencing remain unchanged. An
exploratory, uncommitted coordinator edit was discarded before validation.
No feature flag, second engine, execution ledger, production migration, push,
merge, PR, Stage 4D/5/6 implementation or Dovecot smoke was performed.

## Blocking dependency

Directly enrolling INBOX while retaining the existing business consumers cannot
satisfy the requested preservation of commands, content and attachments.
Migration `0035_receiving_authority.sql` deliberately prevents those existing
writers from operating on enrolled accounts. The guard is behaving correctly;
weakening it would break the accepted Stage 1 boundary.

`MessageCommandService.create` first requires
`recentSyncUidValidity === uidValidity`. New receiving initialization sets the
epoch but never sets the old recent-sync completion field. Thus a newly
published message cannot accept a command. Even pre-populating the old field
does not resolve the problem: the optimistic placement UPDATE is unfenced and
fails with `Receiving authoritative write context missing`. Its transaction
rolls back the newly inserted command intent, not just the visual projection.

`MessageContentService.request` cannot even insert a pending intent:
`maildock_receiving_write_guard` explicitly raises
`Receiving content capability disabled` for content belonging to any account
with an enrolled mailbox. This also applies when a Stage 1 context is supplied;
passing the coordinator's identity to the existing callback cannot enable it.

`AttachmentService.request` cannot change the attachment discovered by the new
metadata writer to pending. Its UPDATE lacks Stage 1 context. Keeping its queue
registration does not restore the write capability or durable business intent.

There is also a deployment capacity/ownership conflict: content, commands,
attachments and sent-copy workers directly invoke provider IMAP operations,
with independent pg-boss concurrency, mailbox/outgoing locks and no elected
owner admission. Retaining them as currently composed allows receiving sockets
in followers and outside W/C/D accounting. Removing them breaks the requested
business functions. This is a source-audit finding, not a new measured socket
overlap claim.

The approved [implementation plan](../../design/imap-sync-engine/IMPLEMENTATION_PLAN.md)
explicitly assigns these routes to Stage 6a/6b/6c and states: “Gate complete
account cutover on all three so no direct unbudgeted client remains.” The
requested Stage 4C cutover also forbids beginning Stage 6. Implementing the
necessary route here would cross that boundary. A separate scope/ordering
decision is required before the active cutover can safely proceed.

## Executable PostgreSQL evidence

`tests/receiving-cutover-boundary.integration.test.ts` uses disposable
PostgreSQL 17.6, a non-superuser database owner, all application migrations,
the actual Stage 1 executor/initialization/persistence, actual business APIs,
the existing JobRuntime with actual pg-boss, and an independent postgres.js
reader. It never connects to the configured application database or a provider.

The control test publishes legacy metadata to an unenrolled account. The same
command, content and attachment APIs persist pending business rows and three
real `created` pg-boss jobs, observed independently in PostgreSQL. The enrolled
cases publish one message through Stage 1 with epoch 7, revision 1, F=1/E=1/R=0.
The independent reader proves that rejected operations leave facts unchanged.

| Probe                       | Independently checked outcome                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Unenrolled control          | Command/content/attachment pending rows and three actual pg-boss jobs exist                                               |
| New receiving INBOX         | One visible placement; retired recent-sync epoch remains NULL; command rejected before intent                             |
| Pre-populated old readiness | Optimistic command UPDATE is fenced; inserted command rolls back; flags and revision unchanged                            |
| Content request             | Explicit capability rejection; no content intent; metadata/frontiers unchanged                                            |
| Attachment request          | Missing-context rejection; original attachment status/blob remain unchanged                                               |
| Legacy LIST reconciliation  | INBOX UPDATE is fenced; all reconciliation writes roll back; manual Sent role and secondary due/generation unchanged      |
| Old secondary metadata path | Unenrolled secondary folder still cannot write account message metadata after INBOX enrollment; zero secondary placements |

These tests intentionally assert the existing failure boundary. Passing them
confirms a blocker; it does not establish functioning Stage 4C business work.

## Actual worker lifecycle and registration order

The active worker remains the accepted 4B baseline. Database authority is checked
first. Owner MFA readiness precedes pg-boss startup. Registration/start order is
attachment worker/poller, sent-copy worker, outgoing worker/poller, recent-sync,
delta-sync, backfill-sync, content, message commands, mailbox discovery, delta
poller, backfill poller, command poller, sent-copy poller, independent IDLE watchers.

READY to NOT READY stops pollers/watchers and awaits JobRuntime shutdown.
Signals request supervisor cancellation; teardown awaits startup before stopping
resources and closing the application database. These are existing behavior,
not new Stage 4C lifecycle acceptance results. No elected receiver, account wake
consumer, due repair timer, election retry or membership refresh is registered
in the actual worker. **No legacy execution path has been removed.** Leaving
the active lifecycle unchanged prevents an unsafe partial cutover.

Stage 4B's isolated election, follower ACK, release/takeover and retirement
behavior is retained. Its fixed 128-account cap and supplied receiving executor
capacity remain unchanged. Worker-level readiness/election races, new account
membership/credentials, renewal headroom and global business socket admission
are still Stage 4C dependencies, not established by isolated Stage 4B evidence.

## Durable demand and secondary-folder boundary

Stage 4A stores due and request generation on account/mailbox rows before the
best-effort wake. Delivery ACK does not clear due. Stage 4B still does not settle
due; generation-aware result CAS and its active-turn race tests remain unwired.
This commit adds no due-clearing API, so a failed/stale turn cannot newly erase
demand. This is absence of a change, not proof of a completed settlement design.

| Remaining producer                                             | Existing consumer/route                                     | Cutover dependency                                                                                         |
| -------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| MessageService manual/recent refresh; web recent/delta facades | Recent/delta secondary jobs; INBOX durable account wake     | Replace secondary submission with explicit deferred state while preserving due; attach INBOX wake to owner |
| Worker recent facade; delta/backfill enqueue and continuations | Recent/delta/backfill workers                               | Retire executor registration and continuation/poller lifecycle together                                    |
| Account creation, enablement, IMAP/OAuth identity edits        | Account due trigger plus old discovery enqueue              | Refresh bounded candidate membership; preserve pending discovery until Stage 5                             |
| Mailbox discovery, including INBOX insertion                   | LIST/reconciliation, then requestSync on selectable folders | Existing LIST modifies enrolled INBOX and fails; elected, bounded topology publication belongs to Stage 5  |
| IDLE EXISTS/FLAGS/EXPUNGE/close/reconnect                      | Old watcher to demand-aware delta enqueue                   | Remove old watcher lifecycle; polling correctness remains required                                         |
| Command source/destination post-result callback                | Demand-aware delta enqueue for each mailbox                 | Preserve command intent/outcome and both repair demands; Stage 6a routing                                  |
| Attachment stale-epoch metadata refresh                        | Worker recent facade                                        | Preserve attachment business rows and demand; Stage 6b routing                                             |
| Sent-copy post-APPEND/exact lookup refresh                     | Worker recent/delta facade                                  | Keep saved/uncertain copy identity and pending refresh; Stage 6c routing                                   |
| Existing pending command/content intents                       | Stage 4A correlated bounded repair eligibility              | Preserve original rows; signals alone do not provide execution capability                                  |

Secondary demand already has durable storage: no new execution ledger is needed
merely to retain/defer it. The LIST rejection test proves the secondary
generation/due and manual role survive the failed operation. However, an explicit
deferred API/UI state has **not** been implemented because the active cutover is
blocked. Existing secondary legacy consumers remain active at the baseline.
Their executions are not represented as a newly safe compatibility boundary.

`SentCopyService.requestSync` clears `sentCopySyncPending` when its boolean sync
callback returns true. A future deferred facade must make that acceptance
semantics explicit and retain the pending business refresh when unsupported.
Demand retention must not become a claim that the Sent folder is synchronized.
The accepted INBOX scheduler supplies neither LIST/topology, secondary history
nor flags/membership repair. Those remain Stage 5 work. There is no claim that
secondary folders or sent-copy metadata are synchronized by the new route.

## Validation and acceptance

Combined validation: **12 files, 237/237 passed**, 193.48 seconds. This includes
the seven new boundary/control probes, Stage 1 retirement/authority and Stage
3A/3B/4A/4B regressions, existing commands, attachments, outgoing messages,
sent-copy jobs and worker logging boundaries. Stage 4B regressions exercised
actual pg-boss and isolated coordinator child processes; the new boundary tests
exercise database/business APIs rather than an integrated Stage 4C worker.

After the test logger's config literal was corrected to `fatal`, the exact final
boundary source passed again: **7/7**, 9.35 seconds. Application and worker
typecheck, repository lint, final changed-test lint, changed-file Prettier and
diff whitespace checks passed. The combined run used one worker, serial files
and `--bail=1`; no unexplained runtime failure occurred and no retry campaign
was needed. No complete Stage 3C Dovecot smoke or unrelated benchmark ran.

```text
pnpm exec vitest run tests/receiving-cutover-boundary.integration.test.ts tests/receiving-election.integration.test.ts tests/receiving-wakes.integration.test.ts tests/receiving-scheduler.integration.test.ts tests/receiving-coordinator.integration.test.ts tests/receiving-safety.integration.test.ts tests/receiving-retirement-gate.integration.test.ts tests/message-commands.integration.test.ts tests/attachments.integration.test.ts tests/outgoing-messages.integration.test.ts tests/sent-copy-jobs.test.ts tests/security/worker-logging-boundaries.test.ts --maxWorkers=1 --no-file-parallelism --bail=1
pnpm exec vitest run tests/receiving-cutover-boundary.integration.test.ts --bail=1
pnpm typecheck
pnpm lint
pnpm exec eslint tests/receiving-cutover-boundary.integration.test.ts
pnpm exec prettier --check docs/implementation/imap-sync-engine/STAGE_4C_RESULTS.md tests/receiving-cutover-boundary.integration.test.ts
git diff --cached --check
```

Full run output remains in the local temporary directory as
`maildock-stage4c-regressions.log` and `maildock-stage4c-boundary-final.log`.
The original explained fixture failure is retained in
`maildock-stage4c-boundary.log`; corrected six-probe evidence is in
`maildock-stage4c-boundary-corrected.log`.

| Requested Stage 4C scenario              | Status at this stop                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1–3: MFA startup, READY and pause        | No new worker integration; not verified for Stage 4C                                                   |
| 4–5: election, takeover and durable F/E  | Existing isolated 4B regression passed; actual worker integration pending                              |
| 6: integrated startup/shutdown races     | Not implemented; no Stage 4C resource claim                                                            |
| 7: lost/duplicate/ACKed wakes            | Existing isolated 4A/4B regressions passed; actual worker delivery pending                             |
| 8: late request versus due settlement    | No settlement added; integration/CAS pending                                                           |
| 9: live enablement/credential membership | Trigger regression retained; elected membership refresh pending                                        |
| 10: secondary deferred execution         | Demand/role retention independently verified on rejected LIST; explicit deferred state not implemented |
| 11: legacy INBOX cannot execute          | Not satisfied: baseline registrations remain active; no cutover performed                              |
| 12: business functionality               | Unenrolled control/regressions pass; enrolled commands/content/attachments demonstrate blocker         |
| 13: capacity and fencing                 | Existing isolated receiving regressions pass; global business admission conflict remains               |

The six originally added blocker probes passed before adding the unenrolled
pg-boss control. The first fixture run failed with the explained
`mail_accounts_auth_credential` constraint: the fixture omitted password JSON.
The fixture was corrected without changing application logic or assertions.
Typecheck also identified an incorrect import and unsupported `silent` config
literal; both fixture mistakes were corrected. They are not unexplained runtime
or retirement failures. No deadline was increased.

No receiving resource/cleanup measurement for the integrated Stage 4C worker is
available because it was not activated. Fixture teardown stops its JobRuntime,
receiving executor, both SQL clients and disposable container. Baseline regression
resource observations must not be presented as cutover measurements. Historical
intermittent W=4 retirement remains unresolved; any new unexplained failure ends
the run without open-ended retries.

**Stage 4 acceptance: BLOCKED. Stage 4D cleanup readiness: NOT READY.**
Required readiness/election/shutdown, durable settlement, account refresh and
legacy retirement scenarios remain unverified in the actual worker. SMTP,
drafts, outgoing and sent-copy application code is unchanged; successful baseline
business regressions cannot demonstrate compatibility after enrollment. The
concrete command/content/attachment counterexamples must be resolved before
making a functioning cutover claim.

Stop at this Stage 4C blocker report. Reconcile the cutover/Stage 6 ordering and
authorize the missing owner-routed business capabilities separately; do not
bypass Stage 1 guards or construct a competing executor to obtain a green result.
