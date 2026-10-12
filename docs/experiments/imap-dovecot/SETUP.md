# Dovecot synchronization experiment setup

Experiment only, 2026-10-12. Base: `experiment/imap-transport-hardening` at `14ebf1da2960bfc4e513443f79c9e497c8fabbe5`. Work branch: `experiment/imap-dovecot-validation`. Production code, dependencies, original research and approved design documents are unchanged.

## Pins and isolation

- Official image: `dovecot/dovecot:2.4.3-dev@sha256:d0db02b4aa9c16bc50c96faad68fcf5724c1453a98a39ada685409227e967898`; server identifies as 2.4.3, `c1b22ef978`.
- Compose project: `maildock-imap-experiment`, dedicated bridge and disposable `mailbox` volume mounted at `/srv/vmail`. Container limits: two CPUs, 1 GiB. Only IMAPS is published, `127.0.0.1:31993` to container 31993.
- Rootless UID/GID 1000, `SYS_CHROOT` capability. Custom configuration includes the image's `vendor.d/rootless.conf`; Maildir storage is `~/mail`, without direct index manipulation.
- Only synthetic user `fixture` is used. The publicly documented password `maildock-disposable-only` is test material, not a real credential. Static authentication would accept other usernames with the same password; this disposable service must remain confined to loopback.
- Generated self-signed TLS certificate has localhost/127.0.0.1 SANs. Client trusts that certificate as its CA and verifies its hostname. Generated private key, mailbox tar archives and manifests are ignored by Git. No antivirus settings were changed.
- IMAP4rev1, optional CONDSTORE, no QRESYNC, compression or automatic IDLE. Byte limits: line/literal 256 KiB, single response 2 MiB, aggregate operation 2 MiB; baseline inventory explicitly allows aggregate 16 MiB. Active operation deadline 10 seconds; connection/authentication setup 10 seconds. Passive socket inactivity timeout is 60 seconds, independently of active deadlines.

The image layout and ports were inspected directly. See the official [Dovecot 2.4.3 Docker instructions](https://doc.dovecot.org/2.4.3/installation/docker.html) and [image repository](https://hub.docker.com/r/dovecot/dovecot). On this Docker Desktop, an `internal: true` network did not expose the published port; the dedicated bridge with loopback publishing worked. It permits container egress, but no experiment command contacts real mail services.

## Reproduction from the repository root

Prerequisites: Docker Desktop Linux engine, Docker Compose, repository-installed Node 24, pnpm and dependencies. Measured host versions: Node 24.21.0, pnpm 12.7.0, Docker Engine 28.5.1, Compose 2.40.3, Docker Desktop 4.50.0. Do not upgrade dependencies to run the harness.

```powershell
# Startup includes authenticated TLS login and actual INBOX SELECT readiness.
powershell -NoProfile -ExecutionPolicy Bypass -File experiments/imap-dovecot/setup.ps1 up
powershell -NoProfile -ExecutionPolicy Bypass -File experiments/imap-dovecot/seed.ps1 -Count 100
node --import tsx experiments/imap-dovecot/benchmark.ts progressive 100 C1
node --import tsx experiments/imap-dovecot/benchmark.ts arrivals 100 C2 fetch

# Reset only this project's disposable volume, then populate the primary fixture.
powershell -NoProfile -ExecutionPolicy Bypass -File experiments/imap-dovecot/setup.ps1 reset
powershell -NoProfile -ExecutionPolicy Bypass -File experiments/imap-dovecot/setup.ps1 up
powershell -NoProfile -ExecutionPolicy Bypass -File experiments/imap-dovecot/seed.ps1 -Count 50000
node --import tsx experiments/imap-dovecot/suite.ts 50000
node --import tsx experiments/imap-dovecot/restart.ts

# D/E changes are destructive to this fixture. Run after the latency comparisons.
node --import tsx experiments/imap-dovecot/changes.ts 50000 condstore
node --import tsx experiments/imap-dovecot/scripted-regression.ts
node --import tsx experiments/imap-dovecot/evidence.ts
node --import tsx experiments/imap-dovecot/report.ts

pnpm exec tsc -p experiments/imap-dovecot/tsconfig.json
pnpm exec eslint experiments/imap-dovecot
pnpm exec vitest run tests/imap-client-lifecycle.test.ts tests/imap-conditional-store.test.ts tests/imapflow-download-charset.test.ts
```

For one scenario: `node --import tsx experiments/imap-dovecot/benchmark.ts arrivals 50000 C1 search`. Modes: `baseline`, `progressive`, `arrivals`; profiles: `C1`, `C2`, `C5-one`, `C5-two`; triggers: `search`, `fetch`, `after`, `waiting`, `idle`. `suite.ts 50000 arrivals` resumes only B/C after completed A. A restrictive optional fourth argument selects a profile or `one-lanes`. Major profiles have three trials; boundary cases have one trial per C1/C2 and remain limited evidence.

The suite runs child processes sequentially, alternates A execution order and reverses connection-profile order. Its 120-second parent timeout is emergency containment and never successful cancellation evidence. During runs it samples Docker CPU/memory and `doveadm who`. Avoid running the evidence/report collectors concurrently with a benchmark suite.

## Fixture preparation and independent verification

`fixture.ts` writes a streaming ustar Maildir archive and JSONL ground-truth manifest. Archive paths can contain POSIX Maildir flag suffixes even on Windows. Seed 2403 produces 50,000 unique Message-IDs/subjects, reproducible Date headers and tar timestamps, Seen on every third message, mostly small plain text, multipart on 5%, attachments on 1%, and larger bodies on approximately 1%. Every 97th message has an old Date; injected arrivals also have old Dates.

`seed.ps1` refuses a populated INBOX, copies the archive into the disposable container, extracts it into `/tmp/maildock-fixture`, invokes supported `doveadm import -u fixture maildir:/tmp/maildock-fixture "" all`, then `doveadm index`. It does not fabricate UIDs or edit index files. `cli.ts verify COUNT` retrieves every actual UID and complete metadata in closed 128-wide windows, checks unique identities, all subjects/sizes/permanent flags against the external manifest and saves `assigned.jsonl`. Session-specific `\Recent` is excluded from permanent-flag comparisons. BODYSTRUCTURE is required for every metadata record. Full MIME semantic/charset validation is outside this fixture verifier.

The first measured primary preparation took 316.535 seconds, including verification; generation took 8.482 seconds. Initial IMAP count was exactly 50,000, UIDNEXT 50,001, UIDVALIDITY 1791799138; assigned manifest SHA-256 `491ac00dd03241f4e9d598059b06f3088d9101e163468314baf2f01ad7c19deb`. Later disposable resets have different UIDVALIDITY. Fixture preparation is excluded from synchronization timing. Verification warms indexes and metadata caches, so these are warm-server measurements; cold server/storage performance was not measured.

## Outputs, cleanup and recovery from failed trials

Timestamped JSON records contain exact requested UID sets, intervals, transport outcomes, command/tag completion times, bytes, operation occupation, process CPU/memory and event-loop measurements. The evidence collector preserves lossless gzip copies and creates `outputs/summary.json`. APPEND events exported by Dovecot contain actual server completion UTC and APPENDUID. Client monotonic ACK timings are measured independently; cross-clock estimates are explicitly uncalibrated. See [results](BENCHMARK_RESULTS.md).

Successful latency runs remove only their ten appended UIDs with UIDPLUS and undo their single simulated Flagged action. A failed run preserves its trace and stops dependent suite work. `node --import tsx experiments/imap-dovecot/cli.ts cleanup` removes at most 100 messages whose Message-ID matches the synthetic arrival fixture; it cannot reset deletion experiments. Reseed after D, or after partially completed destructive changes. The JSON restart checkpoint tests orderly process replacement only; it has no fsync/transaction crash contract.

```powershell
# Preserve the volume while stopping the service:
powershell -NoProfile -ExecutionPolicy Bypass -File experiments/imap-dovecot/setup.ps1 down
# Delete only this Compose project's mailbox volume and network:
powershell -NoProfile -ExecutionPolicy Bypass -File experiments/imap-dovecot/setup.ps1 reset
```

There are no broad Docker pruning commands, real account connections, production database access, pushes, PRs or merges. Generated archives, emails, volume contents and TLS private keys must remain outside commits.
