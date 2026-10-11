# Phase 4 pre-deployment verification

**Decision: READY FOR DEPLOYMENT.** No blocking defect was confirmed in migration 0042 or its publication triggers. Drain/stop application writers while applying the migration: its DDL was observed waiting for an existing writer transaction.

Verified on 2026-10-11, exclusively on `codex/gmail-api-complete-provider`, against baseline `35c8b78fb90d00fcd894e64fbee3a5c0c16de663`. No production database, live mail account, production credential/configuration, deployment, branch switch, merge or tag was involved.

## Installation and migration

The new integration suite always creates its own disposable `postgres:18.6-bookworm` container, ignoring external database environment variables. PostgreSQL reported 18.6, x86_64 Linux. The existing project authority initialization script provisions the ordinary application owner; application connections use that owner, with a 20-connection test pool.

No sanitized export was supplied. Representative data was generated after applying the original Drizzle journal through 0041: an IMAP account and a native Gmail account, three mailboxes, 51 canonical messages and placements, 51 conversation members, one ready local body, an existing Gmail history checkpoint (`789`), and IMAP recent/backfill/delta UIDVALIDITY, frontier, UID and MODSEQ checkpoints. Credentials and provider responses are synthetic fixtures.

Migration 0042 was applied by executing `src/shared/infrastructure/database/migrate.ts` with Node/tsx, the same entry point as `pnpm db:migrate`. Its child environment contains only test configuration and the disposable database URL. Database authority validation, native-release compatibility validation, the normal Drizzle migration mechanism and local bootstrap all ran successfully. The journal advanced from 42 to 43 entries; all eight publication triggers were verified as deferrable and initially deferred. A subsequent Drizzle migration pass added no entry and changed no publication revision.

Full-row, sorted JSON fingerprints and row counts matched before and after for `mail_accounts`, `mailboxes`, `messages`, `mailbox_messages`, `gmail_account_sync_state`, `conversation_members` and `message_contents`. This includes stored account values, message metadata, flags, mailbox placements, bodies and synchronization checkpoints. Existing accounts initially have no marker row; their coherent snapshots correctly use revision zero until the first change.

An open pre-migration writer performed a no-op placement update. PostgreSQL reported the migration waiting on a **relation lock**, with `pg_blocking_pids` identifying that writer. Releasing it allowed the normal migration process to finish successfully, preserving the fingerprints. Total process time was 2543.52 ms, including runtime/bootstrap startup and this controlled wait; this is not the isolated DDL duration.

## Concurrent workloads and revision correctness

The dedicated deployment suite passed all five scenarios:

- **Same-account contention:** 12 writers completed 15 flag transactions each, 180 commits total, while 40 coherent publication snapshots ran. Instrumented write transactions measured 22.21 ms median, 136.21 ms nearest-rank p95 and 243.74 ms maximum. Snapshots measured 33.82 ms median and 48.29 ms maximum. These timings include statements and commit, rather than commit alone.
- **Mixed local operations:** real `MessageService.persistBatch` ingestion of 150 IMAP messages ran alongside eight placement moves, eight placement deletions, real local read/unread command creation and coherent snapshots. Mailbox unread counts and the all-inboxes count agreed within each snapshot.
- **Gmail and IMAP:** the actual `GmailProvider`/`GmailSyncService`, account lock and PostgreSQL projection processed 25 synthetic Gmail arrivals, read/unread label changes, archive membership changes and deletions concurrently with IMAP ingestion/flag replay and groups of four coherent snapshots. Gmail INBOX rows and unread counts matched the final fixture state. HTTP was supplied exclusively by `SyntheticGmail`.
- **Rollback/retry:** rolled-back flag data and publication updates stayed invisible. A retry published its own transaction ID and committed data. A no-op flag update preserved the revision. A multirow batch changed the publication tuple only once, verified by the delta in PostgreSQL transaction-local table update statistics; rolling that probe back also preserved the committed revision.
- **Long synchronization batch:** a real 1000-message IMAP projection took 3962.86 ms inside an open transaction. An independent same-account flag transaction committed while that batch remained uncommitted, and its revision remained visible until the batch committed. The batch's final deferred commit completed in 37.75 ms while a repeatable-read, read-only snapshot was still open. That reader retained its earlier revision and completed normally.

The older long-running transaction committed after a newer transaction and replaced the marker with its lower transaction ID. The coherent revision hash still changed correctly. Publication revisions are opaque change identifiers: equality is meaningful, numeric ordering is not. This behavior was tested, not treated as a defect.

## Locks and deadlocks

To make the publication row lock observable, a transaction forced its deferred publication event with `SET CONSTRAINTS mail_publication IMMEDIATE` and held the resulting lock. A competing same-account commit waited on PostgreSQL's **transactionid lock**. The blocker was identified directly through `pg_stat_activity` and `pg_blocking_pids`.

Eight coherent snapshot requests all completed while that lock was held, in 458.16 ms combined wall time. They saw the previously committed revision. The competing write finished after releasing the blocker, in 485.61 ms total; that duration deliberately includes the held-lock probe and is not an estimate of normal contention latency.

The normal long batch did not acquire a publication lock during its ingestion phase. The held read-only snapshot did not prevent its worker commit. PostgreSQL reported **zero deadlocks** in the same-account workload, and no tested provider/command transaction failed with a deadlock. The existing publication suite also passed its interleaved-commit MVCC and commit-time publication-failure rollback scenarios.

These results cover the tested transaction paths. They do not prove that arbitrary multi-account transactions or different application lock orders can never deadlock.

## Before/after write performance

The final measurements came from a standalone deployment-suite run without other integration files running in parallel. Seven samples of each workload ran before 0042 and seven after it. The initial message/placement cardinality was restored between phases. Each phase then used the same seven 150-message arrivals, replays and flag updates. Existing conversation/search triggers and indexes remained enabled.

| Workload, 150 messages/placements                  | Before median (ms) | After median (ms) | Time change | Before / after throughput (rows/s) |
| -------------------------------------------------- | -----------------: | ----------------: | ----------: | ---------------------------------: |
| IMAP ingestion through `persistBatch`              |             621.40 |            642.46 |       +3.4% |                          241 / 233 |
| Metadata/flag replay through `persistBatch`        |             520.23 |            520.55 |       +0.1% |                          288 / 288 |
| Single bulk flag UPDATE, including deferred commit |               4.01 |              5.93 |      +47.9% |                    37,430 / 25,301 |

Ingestion ranges were 582.73–649.39 ms before and 625.56–727.98 ms after; replay ranges were 504.54–568.65 and 497.13–537.13 ms; bulk flag ranges were 3.81–7.96 and 5.76–8.11 ms.

The bulk flag median increased by 1.92 ms per 150-row transaction. Percentage impact is larger for this very short SQL workload than for the application ingestion path. A preceding standalone pass measured +18.1% ingestion time and +10.0% replay time, demonstrating host/cache variability. Sequential before/after runs on one database also retain storage churn from earlier samples. These are measured local observations, not production capacity guarantees or a precise attribution of every millisecond to the new triggers. No deployment-blocking throughput failure was observed.

The final raw samples, fingerprints, lock observations and timings are retained in [deployment measurements](sync-priority-phase-4-deployment-measurements.json).

## Defects and changes

No blocking production defect was confirmed; no application code or migration was changed. Added the disposable-database deployment integration suite and this review with raw measurements. Test-harness corrections handled no-op updates, the global all-inboxes count, the correct nested Drizzle transaction type and delta-based PostgreSQL statistics. They did not require changes to publication behavior.

## Validation

- **133 existing focused tests passed** across publication, Gmail provider, resumable IMAP, incremental sync, message commands and backfill sync.
- **5 new deployment tests passed** in the final standalone run: **138 focused tests passed in total** across those runs.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed.
- Prettier checks on all three added files and `git diff --check`: passed.

Reproduction requires Docker and PostgreSQL testcontainers. Leave `TEST_DATABASE_URL` unset for existing suites; the new suite always allocates its own container. Run the deployment suite separately to avoid contaminating its performance samples:

```powershell
$env:MAILDOCK_DEPLOYMENT_REVIEW_OUTPUT = 'docs/validation/sync-priority-phase-4-deployment-measurements.json'
pnpm exec vitest run tests/mail-publication-deployment.integration.test.ts --no-file-parallelism
pnpm exec vitest run tests/mail-publication.integration.test.ts tests/gmail-provider.integration.test.ts tests/imap-resumable-sync.integration.test.ts tests/incremental-sync.integration.test.ts tests/message-commands.integration.test.ts tests/backfill-sync.integration.test.ts --no-file-parallelism
pnpm typecheck
pnpm lint
pnpm exec prettier --check tests/mail-publication-deployment.integration.test.ts docs/validation/sync-priority-phase-4-deployment-review.md docs/validation/sync-priority-phase-4-deployment-measurements.json
```

## Remaining deployment risks

1. **DDL requires a quiet write window.** Stop/drain web and worker writes before migration, then restart after successful completion. Active writers demonstrably delay trigger installation; uncontrolled concurrent DDL/DML lock ordering was not certified for a zero-downtime rollout.
2. **Same-account commits serialize on one marker row.** Deferred triggers shorten the publication lock lifetime, but large batches still queue row events and spend time at commit. Retain existing bounded synchronization batches rather than widening them based on this review.
3. **Reads still consume resources.** MVCC snapshots did not block worker commits on publication/data locks. CPU, I/O and pool saturation can nevertheless increase latency, and long-held snapshots retain old row versions. This test does not certify arbitrary request volume.
4. **Fixture and hardware limits.** Preservation was tested against generated native-schema data, not a production export. The existing 10,000-message publication fixture also passed, but substantially larger installations, production disks, network/provider latency and multi-account custom transactions require their own capacity observations.

**READY FOR DEPLOYMENT**
