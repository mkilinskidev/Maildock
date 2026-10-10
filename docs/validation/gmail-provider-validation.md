# Native Gmail provider validation — 2026-10-10

The implementation starts from P1 `7dfe29925473d8656febfdf2909733acc2871d3e`
on `codex/gmail-api-complete-provider`. The initial tree was clean and local `test`
contained no commits absent from that baseline; a final fetch of `origin/test`
confirmed the same. No merge, deployment, live Gmail
operation, production database access or credential change was performed.

## Implemented scope

Native HTTP/OAuth receiving, canonical identity/labels, recent-first import,
durable historical work/history CAS, expired-checkpoint reconciliation,
account/revision authority, quota reservations, on-demand MIME/content and
attachment caching, native durable actions, SMTP Sent observation, local
search/conversation/notification projections and existing account diagnostics
are wired in both production composition roots. Microsoft/password IMAP and SMTP,
local drafts, renderer and remote-image policy retain their existing paths.

The sole additive DDL is migration 0037. Historical fixtures explicitly pin the
pre-native 0000–0035 boundary and native foundation 0036 rather than assuming the
last migration is forever P1. Existing assertions are retained; the P1 attachment
producer expectation now exercises the completed native path and disabled-account
fence. Compose's exact environment allowlist includes the three quota variables.

## Automated checks

Complete Vitest traversal: **110 files passed, 1 benchmark file skipped; 1,380
tests passed, 1 opt-in benchmark skipped**, in 548.59 seconds with two workers.
The final native-provider rerun after reserving interactive quota exclusively
for user operations passed **47/47 tests** in 82.00 seconds; overlapping reruns
are not added to the complete-suite total. Web/worker TypeScript, ESLint, changed-file
Prettier, `git diff --check`, Drizzle no-change generation and production build
passed. The validation commands are:

```sh
pnpm typecheck
pnpm lint
node node_modules/prettier/bin/prettier.cjs --check <changed files>
pnpm exec vitest run --maxWorkers=2
pnpm test:security:browser
pnpm db:generate
pnpm build
```

Build and schema generation use explicit synthetic test configuration and an
unreachable localhost database URL. Integration tests use disposable PostgreSQL
18.6 with the normal database-authority initialization. The security browser
harness uses local HTTP fixture servers and headless Edge, with no owner session.
Edge 154.0.4258.62 passed 10 reader scenarios and 20 composer checks, with no
third-party composer requests or editor errors. The harness verifies the actual
composer and reader security boundary; it is not a full
live authenticated Gmail UI test.

Native tests exercise HTTP classification/refresh/redirect/body limits/cancel,
MIME/base64/charset, pool-one authority, recent-first restart, stable labels/UUIDs,
remote drafts, partial failures, history expiry/cache retention, repeated history,
501-ID fragments, global actions/optimistic overlays, native move/Trash,
HTML sanitization/blob downloads, notification deduplication, quotas,
disable/reconnect and SMTP-accepted Sent observation. The full suite includes
existing OAuth, SMTP accepted/failed/uncertain, drafts, IMAP UIDVALIDITY/lifecycle,
search/conversations, security, database-authority and native restore regressions.

An intermediate full run had three failures: the Compose environment allowlist,
an extra undefined argument in the existing action handler, and a worker startup
timeout under concurrent validation load. The first two were corrected; the
unchanged MFA/real-worker scenario passed in an isolated three-file run (59/59).
The final run uses two workers to reduce contention. Failures are not excluded
or assertions weakened.

## Synthetic benchmark

Run with `MAILDOCK_GMAIL_BENCHMARK=1 pnpm exec vitest run tests/gmail-benchmark.test.ts`.
The fixture contains 41,000 native messages (100 recent, 40,900 historical) with
representative Inbox/custom/Sent/Spam/Trash memberships. It uses the real sync
service and disposable PostgreSQL with pool size one, synthetic in-process HTTP,
four concurrent metadata requests and weighted usage accounting. Quota throttling
is disabled solely to measure throughput; limiter enforcement is tested separately.

The machine-readable [result](gmail-synthetic-benchmark.json) records recent/full
times, single empty/four-message deltas, HTTP/weighted-unit totals, query roundtrip
and transaction distributions, worker object restarts, fresh content fetches
during import and RSS including the remote fixture. Transaction percentiles use
a bounded last-10,000 sample ring. Query/interactive sample counts are explicit.
The two delta values are single measurements, not percentile claims.

The benchmark passed with exactly **41,000 canonical rows**, no duplicates and
complete coverage. Its test took 2,174.00 seconds. Measured results:

| Measurement                                                             | Result                             |
| ----------------------------------------------------------------------- | ---------------------------------- |
| Recent-ready, 100 recent messages                                       | 3.208 s                            |
| Complete inventory                                                      | 2,164.686 s (36 min 4.686 s)       |
| Empty delta, one sample                                                 | 362.799 ms                         |
| Four changed messages, one sample                                       | 584.888 ms                         |
| Weighted inventory units / after deltas                                 | 825,053 / 825,147                  |
| HTTP requests including deltas                                          | 43,904                             |
| DB query roundtrip, 50 samples, median / p95 / maximum                  | 2.243 / 3.839 / 4.227 ms           |
| Transactions, 63,215 total, last 10,000 samples, median / p95 / maximum | 14.299 / 158.106 / 1,876.177 ms    |
| Fresh content requests during import, six samples, median / maximum     | 663.709 / 1,645.966 ms             |
| Service object restarts / final recovery slice                          | 4 / 1,010.576 ms                   |
| Initial / peak process RSS, including synthetic mailbox/request log     | 272.5 / 704.559 MiB                |
| FULL body fetches                                                       | 6, all explicit interactive probes |

The opt-in benchmark passed separately from the complete suite; it replaces that
suite's one skipped benchmark rather than adding overlapping native-test reruns.
The harness peak exceeds P0's proposed 512 MiB threshold. Its process retains the
entire synthetic remote mailbox and all request records, including metadata query
masks, so this result cannot establish the production worker's RSS. A separate
worker-only memory profile and the resource gate remain mandatory before release;
the threshold is not silently relaxed. Four object restarts demonstrate durable
resume; actual OS-process restarts and queue interruptions remain staging checks.

This run does not include real Google network latency, OAuth refresh HTTP,
pg-boss delivery, live quotas, SMTP or four-account concurrency. It is one cold
synthetic import, not the P0 release protocol of three cold runs and 100 warm
samples. There is no no-import reader baseline to assert the proposed 20% p95
ratio. These qualification gaps must not be presented as passed performance gates.

## Limitations and release gates

- No live Google OAuth/API/SMTP mailbox qualification has been performed.
- The actual Cloud project limits/API enablement and other applications sharing
  its quota must be checked. Local usage accounting loses deleted-account counters;
  Google remains the final quota authority.
- Folder counters settle progressively and may lag actions. No Gmail cloud-draft
  editing, Gmail API send, Pub/Sub or permanent deletion is included.
- Arbitrary move is available on the existing action endpoint with a native
  destination; the preserved UI has its existing archive/Trash controls.
- Custom Gmail Sent-copy preferences surface an explicit error; server-managed
  Sent is the supported mode.
- Full authenticated light/dark/navigation/keyboard and real Gmail MIME/CID,
  SMTP aliases/Bcc/Sent behavior still require staging checks.
- The P0 multirun/multiaccount/live performance and native 41k backup/restore
  qualification protocol remains outstanding. Existing native restore regression
  tests validate schema/authority compatibility, not a live 41k mailbox restore.
- Worker-only memory qualification remains blocked: the synthetic harness's peak
  of 704.559 MiB exceeds the proposed 512 MiB gate and includes retained fixture
  data/request logs that must be measured separately.

Code validation and synthetic correctness are distinct from release approval.
Follow the [staging runbook](gmail-staging-runbook.md); deployment remains blocked
until its live/browser/performance gates pass and the owner approves release.
