# Phase 3 reproduction and containment

Experimental TypeScript only, based on `8c4f9790999f850b4dd2f4365a408d24671bb575`
(`experiment/imap-dovecot-validation`). Branch: `experiment/imap-durability-validation`.
The initial working tree was clean, the base existed locally, ancestry was checked,
and Docker Desktop's Linux engine was available. No production module, migration,
dependency, approved design document or previous experiment report is modified.

## Isolated services

`experiments/imap-durability/compose.yaml` creates the separate project
`maildock-imap-durability`, its own bridge and disposable `mailbox` / `postgres`
volumes. IMAPS is published only on `127.0.0.1:32993`, PostgreSQL only on
`127.0.0.1:35433`. The old Phase 2 project and its volumes are preserved.

| Service                   | Exact reference                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Dovecot                   | `dovecot/dovecot:2.4.3-dev@sha256:d0db02b4aa9c16bc50c96faad68fcf5724c1453a98a39ada685409227e967898`                                |
| PostgreSQL                | `postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94`                                     |
| Netem helper, local image | `sha256:b2c9dce7a3d7f144f486a1cd2287aa20dc7ad529637d4adf31a238fde09f52a3`; built from the PostgreSQL pin with `iproute2=6.15.0-r0` |

The local helper digest is a locally built image identity, not a published registry
reference. Its build recipe is `Dockerfile.network`; rebuilds can have a different
digest because package dependencies/build attestations are not immutable. Set the
verified replacement identity through `PHASE3_NETEM_IMAGE` when reproducing on another host.
The environment manifest records actual runtime identities and configuration hashes.

Database: `phase3`, user `phase3`, password `disposable-phase3-only`; IMAP password
`maildock-disposable-only`. These are synthetic fixtures. TLS uses a newly generated
self-signed localhost CA, explicitly verified by ImapFlow; compression and auto-IDLE
are disabled. The database client rejects URLs outside loopback `/phase3` for the
synthetic user. It never reads the application's environment or account configuration.
The PostgreSQL startup query confirms `fsync=on`, `synchronous_commit=on`,
`full_page_writes=on`; readiness also includes authenticated IMAP SELECT.

## Commands (PowerShell, repository root)

```powershell
powershell -NoProfile -File experiments/imap-durability/setup.ps1 up
powershell -NoProfile -File experiments/imap-durability/seed.ps1
node --import tsx experiments/imap-durability/verify-fixtures.ts
docker build -t maildock-phase3-netem:local -f experiments/imap-durability/Dockerfile.network experiments/imap-durability
docker image inspect maildock-phase3-netem:local --format '{{.Id}}'
$env:PHASE3_NETEM_IMAGE = (docker image inspect maildock-phase3-netem:local --format '{{.Id}}').Trim()
powershell -NoProfile -File experiments/imap-durability/suite.ps1
```

`suite.ps1 -Smoke` uses 10-second load profiles and omits the 600-second trial.
Run suites sequentially: they deliberately share one receiving coordinator lease.
Individual runners may be used directly:

```powershell
node --import tsx experiments/imap-durability/durability.ts
node --import tsx experiments/imap-durability/commit-uncertainty.ts
node --import tsx experiments/imap-durability/late-db-callback.ts
node --import tsx experiments/imap-durability/statement-failures.ts
node --import tsx experiments/imap-durability/turn-budget.ts
node --import tsx experiments/imap-durability/db-startup-deadline.ts
node --import tsx experiments/imap-durability/search-evidence.ts
node --import tsx experiments/imap-durability/network.ts
node --import tsx experiments/imap-durability/packet-loss.ts
node --import tsx experiments/imap-durability/workload.ts 60 1 1
node --import tsx experiments/imap-durability/workload.ts 60 2 2
node --import tsx experiments/imap-durability/workload.ts 60 4 1
node --import tsx experiments/imap-durability/workload.ts 60 4 6 finite
node --import tsx experiments/imap-durability/workload.ts 600 4 2
node --import tsx experiments/imap-durability/reconciliation.ts
node --import tsx experiments/imap-durability/regressions.ts
node node_modules/typescript/bin/tsc -p experiments/imap-durability/tsconfig.json
node node_modules/eslint/bin/eslint.js experiments/imap-durability
powershell -NoProfile -File experiments/imap-durability/setup.ps1 down
```

`down` retains experiment volumes. No prune, host network change or other-project
cleanup is used. Netem verifies the target's Compose project label, creates handle
`33:` only inside Dovecot's Linux network namespace and removes that handle in
`finally`. To recover from a host/process crash during netem, inspect that namespace
and remove only the experiment handle; do not change host qdiscs.

Seed 2403 uses the Phase 2 deterministic Maildir generator in an experiment-local
copy. Two accounts (`p3-load-0/1`) contain 50,000 messages each; six independent
accounts (`p3-load-2..7`) initially contain 256 each. Bulk preparation imports the
archive with doveadm, indexes it and verifies every message ID, subject, size and
permanent flag against the manifest. Sparse/deletion fixtures use server-assigned
UIDs. Fixture archives, certificates and large manifests are ignored, not committed.
Seed refuses partial/nonempty unexpected fixtures and avoids duplicate imports.
After destructive workloads, use a fresh **Phase 3 project volume** for a pristine
initial seed; never reset the old Phase 2 volume. Small fault runners use unique
synthetic account names. Reconciliation deliberately deletes 15,000 messages from
`p3-load-0`, so repeat full suites on a fresh Phase 3 fixture.

## Schema justification

Only `schema.sql` in the disposable database is installed; there is no staging
table, receipt ledger, notification table or bootstrap state machine.
The prototype binds one mailbox path per synthetic account; another path is
rejected without changing its epoch. Multi-folder production routing is outside
this experiment; the epoch mailbox uses its own synthetic account.

| Fact                             | Recovery/correctness justification                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Coordinator singleton            | One deployment receiving authority, rather than one owner per network operation.                                         |
| Owner, generation, expiry        | Monotonic takeover, explicit ownership and DB-time expiration.                                                           |
| Mailbox account, path, epoch     | Independent accounts and explicit UIDVALIDITY; reused UID cannot address old metadata.                                   |
| Fresh and history boundaries     | Prove coverage in `[history,fresh]`; initial SELECT sets an empty interval. Restart cannot infer coverage from MAX(UID). |
| Reconciliation cursor            | Keyset pages resume/wrap instead of permanently revisiting only the newest messages.                                     |
| Revision                         | Reject an obsolete result within the same owner/epoch, including cursor wrap/ABA after confirmed deletion.               |
| Wake generation, fresh due       | Coalesced durable requests; a late wake cannot be erased by an older completed check.                                    |
| Repair due                       | Maintenance remains eligible after missed scheduling/crash. History eligibility derives directly from `history>1`.       |
| Placement account/epoch/UID key  | PostgreSQL uniqueness, replay safety and epoch visibility through `current_placement`.                                   |
| Message ID, subject, size, flags | Independent fixture comparisons and observed metadata/flag correctness; Message-ID is never the placement key.           |

Short transactions lock the lease in shared mode, then the mailbox row, validate
generation/epoch/revision, upsert bounded rows and change the frontier together.
A deferred constraint trigger revalidates authority **inside COMMIT** for an
authoritative mailbox revision. A pinned postgres.js native-socket factory observes
BackendKeyData to associate a backend PID with the connection; a transaction deadline
retires that connection after identification (before PID identification it may
retire its pool). Explicit reserved-client BEGIN/COMMIT/ROLLBACK and SQL/lazy-query
lifetime guards prevent late callback cleanup from acting on a reused connection.
This is experimental transport
adaptation, not an approved production integration. Transaction/lock statements and
commit are capped at 2 s or the remaining full turn time. The full 10 s turn includes
renewal, connection/authentication, selection, SEARCH/FETCH and DB admission/commit.

pg-boss is intentionally absent. ACK/continuation barriers test direct durable-state
rediscovery; production queue delivery, notifications and business persistence remain
unproven. Test account flags/content use the real IMAP server but do not implement
production command intent, uncertain mutation replay or content caching.

## Traces

Compressed JSON/JSONL traces and small JSON summaries live under
`experiments/imap-durability/outputs/`. Per-turn events include process/account/path,
owner generation, interval, exact returned counts, completeness, transaction result,
frontiers, revision, transport bytes/parser metrics, command completion counts,
duration, memory and failure reason. Load traces also contain actual admission,
APPEND acknowledgment/visibility and one-second resource samples. The retained
in-memory operation ring is 512 entries; DB duration/wait samples are capped at
20,000, so their percentiles describe that retained sample, not unlimited history.
Full operation events are streamed to gzip. Clock durations are process-monotonic;
cross-process correlation uses UTC plus independently read database state, not
uncalibrated server timestamps as latency truth.
