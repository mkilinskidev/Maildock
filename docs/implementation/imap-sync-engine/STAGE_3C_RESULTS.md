# Stage 3C — corrected harness and one real-Dovecot evaluation

2026-10-13. **PARTIAL.** The corrected W=2 run passed initial receiving, durable
history, fresh-message visibility, the independent PostgreSQL oracle and restart.
During the mandatory account-failure scenario, two healthy accounts exceeded
their four-second operation deadlines. The errors-only-on-unavailable-account
assertion failed. Evidence was preserved and execution stopped. **W=4 is NOT RUN.**
Exactly one complete smoke invocation was attempted in this follow-up.

## Base and scope

Continued on `test/imap-sync-stage-3c-dovecot`, initially clean at
`9e8cd9b29cb6540cfe2829c73eaf82fc9919931a`. Only the harness, its small independent
oracle, diagnostic artifact and this report changed. No Stage 1–3B source,
production defaults, fairness policy or worker composition changed. No push,
merge, PR, production account or Stage 4 work was performed.

## Harness corrections and preflight

The scheduler's existing `historyAllowed` API is global. The harness now runs
non-overlapping bounded waves through that gate. Before each wave an independent
SQL read selects only accounts below the durable history-publication target.
Accounts at target are omitted. Selected accounts still start with fresh discovery.
Test-only `pollMs=5000` provides quiet opportunities for ordinary history;
`historyWaitMs=30000` and scheduling policy remain unchanged. This does not replace
the sustained-fresh fairness evaluation in Stage 3B.

The first successful history completion closes the global gate synchronously.
Already-admitted turns settle before stopping the scheduler and independently
reading SQL. No same-account second history turn is admitted in that wave.
Targets are one window for recent metadata, two before injection and three after
fresh progress. Each account actually committed exactly three windows. Scheduler
instances are sequential; no parallel scheduler or full-archive download was added.

Each boundary captures frontiers, epochs, revisions, complete placement identities
and audit rows in an independent PostgreSQL repeatable-read, read-only transaction.
The fixture-only trigger records account/epoch/UID/Message-ID metadata inside the
same transaction as frontier publication. The oracle checks revision and old/new
F/E continuity, one advancing frontier, 128-numeric-UID bounds and exact inventory
membership in every published interval and current coverage. It rejects duplicates,
missing metadata, wrong identity/account/epoch and false frontier advancement.

Admissions, tagged command responses and successful-turn callbacks remain separate
from authoritative SQL publications. Actual `retireReceiving()` promises are
wrapped to mark ownership retired only after native retirement settles. Boundary
resource records include maximum ownership, per-account overlap, active slots and
sampled RSS. Fixture delivery connections are outside scheduler W/C measurements.

The independent visibility observer runs during APPENDs, approximately every 25ms.
Each sample preserves actual acknowledgement and first-observed visibility
timestamps plus monotonic elapsed time. Visibility is an observation upper bound,
not the exact commit instant.

`finally` saves diagnostics before cleanup, captures a final SQL boundary after
scheduler settlement, and saves after each cleanup attempt. Cleanup errors cannot
skip evidence emission. A 280-second cutoff reserves cleanup time; a 295-second
emergency checkpoint and the launcher's outer 300-second limit handle interruption.

Preflight passed:

- `node --import tsx experiments/imap-dovecot/stage3c.ts --check`: a valid sparse
  interval and ten rejecting controls for missing/duplicate placements, wrong
  account/identity/epoch, absent atomic metadata, broken frontier chain, revision
  mismatch and invalid advance. The actual candidate helper excludes accounts at
  target and rejects target overshoot.
- Launcher PowerShell syntax and retained-process-handle exit-code probe.
- `pnpm typecheck`, `pnpm lint`, changed-file Prettier and `git diff --check`.

These preflight checks did not execute another smoke scenario.

## Environment, workload and budget

Observed environment: Docker engine **28.5.1**, Docker Desktop **4.50.0**,
Dovecot **2.4.3 (`c1b22ef978`)**, PostgreSQL **17.6** on Alpine x86_64, Node
**v24.21.0**, patched ImapFlow **2.0.6**, pnpm **12.7.0**. The existing pinned
Dovecot digest and `postgres:17.6-alpine` were cached. No installation or image
download was needed. Actual Dovecot, ImapFlow, verified TLS and a disposable
`stage3c` PostgreSQL database were used.

Five independent accounts imported 1,000 deterministic messages each. Actual UID
100 and 500 were expunged in each INBOX, leaving **4,990 seeded messages**. Full
account-qualified UID/Message-ID inventories and UIDVALIDITY were read from
Dovecot. Gaps exist but fall outside the three historical windows exercised here;
sparse-interval handling therefore has only the offline oracle control in this
evaluation. Mixed 2001/2024 dates and different MIME/header sizes remain in the
reused fixture. Fifteen extra old-dated messages, three per account, were APPENDed
with actual acknowledged UIDs 1001–1003.

Fixture setup including containers, migrations and inventory: **27,936.94 ms**.
Entire process including cleanup: **53,025.81 ms**. Each history-target phase had
a fixed 25-second deadline; discovery, visibility, restart and failure phases had
20-second deadlines. No deadline was automatically extended. The stop was an
assertion failure, not exhaustion of the total execution budget.

## W=2 durable results

All five accounts received initial fresh discovery. The recent-metadata boundary
had 128 queryable placements/account and E=873, before historical completion.
Each second window moved E to 745. All 15 injected identities became queryable
while E remained 745; afterward a third historical window moved E to 617.

| Account   | Epoch      | Durable historical E chain | Final F | Final E | Revision | Exact placements |
| --------- | ---------- | -------------------------- | ------- | ------- | -------- | ---------------- |
| stage3c-1 | 1791895316 | 1001 → 873 → 745 → 617     | 1003    | 617     | 4        | 387              |
| stage3c-2 | 1791895320 | 1001 → 873 → 745 → 617     | 1003    | 617     | 4        | 387              |
| stage3c-3 | 1791895324 | 1001 → 873 → 745 → 617     | 1003    | 617     | 4        | 387              |
| stage3c-4 | 1791895328 | 1001 → 873 → 745 → 617     | 1003    | 617     | 5        | 387              |
| stage3c-5 | 1791895333 | 1001 → 873 → 745 → 617     | 1003    | 617     | 4        | 387              |

Each history publication spans exactly 128 numeric UIDs. Final placements are
exactly UID 617–1003 for each account, matched to actual Dovecot identity and epoch.
No missing or duplicate placement was found. Account 4 published fresh arrivals
in two transactions, explaining revision 5; the others had one fresh publication
and revision 4. The oracle checks these actual separate intervals.

After the third window the scheduler stopped and restarted on the same PostgreSQL
state. The first five restarted admissions were fresh. Independent reads preserved
F/E, epoch, revision and full placements; history was not restarted from scratch.
No history was scheduled beyond the three-window target.

All **16 saved boundary oracles passed**, including failure cleanup. There were
15 history admissions and 15 durable history publications. Diagnostics also record
68 total admissions, 63 successful-turn callbacks and 551 tagged response
observations, including the authentication rejection. Those counts are not proof
of durable publication.

Fresh acknowledgement-to-observed-PostgreSQL-visibility latency samples (ms):

| Account   | UID 1001 | UID 1002 | UID 1003 |
| --------- | -------- | -------- | -------- |
| stage3c-1 | 342.73   | 307.36   | 279.49   |
| stage3c-2 | 5180.53  | 5185.30  | 5188.93  |
| stage3c-3 | 5321.09  | 5334.75  | 5323.23  |
| stage3c-4 | 175.78   | 5572.22  | 5583.66  |
| stage3c-5 | 5316.45  | 5323.53  | 5316.85  |

Maximum observed latency: **5,583.66 ms**, across 15 samples. Exact acknowledgement
and visibility timestamps are saved in the evidence. No SLA or percentile is
claimed. Old-dated arrivals were discovered by UID before full history completion.

## Failure isolation: mandatory assertion failed

Only account 1's test factory supplied an invalid password. The other four
connection configurations were unchanged. Observed errors:

| Account   | Error                                | Reported retry delay | Monotonic timestamp (ms, process clock) |
| --------- | ------------------------------------ | -------------------- | --------------------------------------- |
| stage3c-1 | `IMAP AUTHENTICATE failed`           | 200 ms               | 49716.05                                |
| stage3c-3 | `Metadata window deadline exhausted` | 200 ms               | 52224.95                                |
| stage3c-4 | `Metadata window deadline exhausted` | 200 ms               | 53718.65                                |

The assertion `errors.slice(errorIndex).every(e => e.user === users[0])` failed.
The finalizer saved full SQL and connection evidence. Offline comparison verified
no frontier, revision or placement change between restart and final failure
snapshots, and the exact placement/publication oracle still passed.

Only the first affected-account 200ms retry was observed; the 200/400/800ms sequence
was not established. Healthy-account injection and durable progress during failure,
restoration and recovery were NOT RUN because execution stopped at the mandatory
assertion. W=4 was also NOT RUN. No successful failure-isolation or global-deadlock
claim is made.

Healthy-account deadline failures coincided with the authentication failure under
this real-server fixture. Their cause is unestablished: the evidence does not
identify an engine defect, Dovecot behavior or environmental timing as the cause.
No operation deadline was increased, no rerun was performed and no engine code
was changed.

## Resources, exact outcomes and readiness

Maximum observed scheduler-owned live connections: **2**; per-account overlap:
**false**. There are 67 native-retirement observations. Every settled boundary
reports zero live owned connections and zero active slots. Maximum boundary-sampled
process RSS was **318,963,712 bytes**, not a continuously measured peak or server
memory statistic. Both disposable containers were removed; the post-run Docker
label query found no remaining Stage 3C containers. Cleanup errors: none.

| Requirement                                                                  | Outcome | Scope                                          |
| ---------------------------------------------------------------------------- | ------- | ---------------------------------------------- |
| Real servers, five accounts, approximately 5,000 seeded messages             | PASS    | Recorded actual inventories                    |
| Initial fresh discovery for every account                                    | PASS    | W=2                                            |
| Recent metadata visible before full history                                  | PASS    | W=2, 128 placements/account after first window |
| Exactly 2–3 durable bounded history windows/account                          | PASS    | W=2, exactly three                             |
| Fresh UID discovery, injected identities, E preservation, subsequent history | PASS    | W=2, 15 old-dated arrivals                     |
| Exact interval/placement/atomic publication oracle                           | PASS    | All 16 observed W=2 boundaries                 |
| Stop/restart preserves state and prioritizes fresh                           | PASS    | W=2                                            |
| W/C=1 connection ownership and retirement                                    | PASS    | W=2                                            |
| No false advancement during failed operations                                | PASS    | Restart-to-failure SQL comparison              |
| Errors restricted to the unavailable account                                 | FAIL    | Two healthy-account deadlines expired          |
| Full bounded-backoff sequence                                                | NOT RUN | Stopped after healthy-account errors           |
| Healthy durable progress during failure and restored-account recovery        | NOT RUN | Stopped at isolation assertion                 |
| W=4 scenarios                                                                | NOT RUN | Earlier mandatory condition failed             |
| Diagnostic evidence in finally and container cleanup                         | PASS    | Final snapshot saved; containers absent        |
| Typecheck, lint, formatting and diff whitespace                              | PASS    | Focused checks                                 |
| Full regression, soak, 50k benchmark, Stage 4                                | NOT RUN | Excluded                                       |

**PARTIAL; Stage 4 readiness is not established.** Initial real receiving, durable
history, fresh visibility and restart now have independent evidence. Failure
isolation and W=4 remain mandatory gaps. This task stops after this one evaluation.

## Evidence and reproduction

The original `stage3c-evidence.json.gz` remains immutable. The corrected evaluation
is separately retained as `experiments/imap-dovecot/stage3c-rerun-evidence.json.gz`.
It contains inventories, boundary snapshots with full placements, atomic audit
metadata, latency timestamps, admissions, responses, callbacks, retirements,
errors and cleanup. SHA-256 of its uncompressed JSON:
`48a7f10b15d8e650a038c49fa8df7b482242528affd0d7cd143a7c4d0b407c4c`.

The raw W=2 outcome remains `PARTIAL: started`; this report distinguishes the
passed earlier scenarios and exact failure. W=4 is explicitly `NOT RUN`.
Offline replay of all 16 saved boundary snapshots through the same oracle passed.
The launcher correctly reported exit code 1 for this attempt.

Use the existing image/certificate preparation in the historical record below:

```powershell
node --import tsx experiments/imap-dovecot/stage3c.ts --check
pnpm typecheck
pnpm lint
powershell -NoProfile -ExecutionPolicy Bypass -File experiments/imap-dovecot/stage3c.ps1
```

Run only one instance at a time because fixture files and cleanup labels are
shared. Generated uncompressed JSON and root logs remain ignored.

---

## Original attempt — historical record

### Stage 3C — original real Dovecot integration smoke

2026-10-13. **PARTIAL — Stage 3C acceptance is incomplete.** The single real-server
attempt stopped at its explicit 20-second historical-progress deadline. No
deadline was increased and no second smoke run was performed. Stage 4 and
production cutover must remain pending.

## Base and isolation

The initial working tree was clean on `feature/imap-sync-stage-3b-scheduler`.
HEAD was exactly `1189a484b4d2132dbea5d2da061cb795cf6dd509`; the base ancestry check
passed. Remote: `git@github.com:mkilinskidev/Maildock.git`. Work is on
`test/imap-sync-stage-3c-dovecot`. No push, merge or PR was performed.

The standalone `experiments/imap-dovecot/stage3c.ts` calls the existing Stage 3B
`ReceivingScheduler` and Stage 1 executor. It does not import worker composition,
enroll a production account or use an application database. Stage 1–3B source,
persistence semantics and scheduling policy are unchanged. The existing Stage 2
Dovecot fixture/configuration, fixture generator, Stage 3A/3B reports and scheduler
integration fixture APIs were reviewed and reused. No scripted IMAP peer was used.

## Environment and fixture

| Component                                               | Observed version           |
| ------------------------------------------------------- | -------------------------- |
| Docker Desktop                                          | 4.50.0 (209931)            |
| Docker client / Linux engine                            | 28.5.1 / 28.5.1, API 1.51  |
| Docker Compose (available; harness uses Testcontainers) | v2.40.3-desktop.1          |
| Dovecot                                                 | 2.4.3 (`c1b22ef978`)       |
| PostgreSQL                                              | 17.6, x86_64-pc-linux-musl |
| Node / pnpm                                             | v24.21.0 / 12.7.0          |
| ImapFlow                                                | installed patched 2.0.6    |

Dovecot image: `dovecot/dovecot:2.4.3-dev`, pinned to
`sha256:d0db02b4aa9c16bc50c96faad68fcf5724c1453a98a39ada685409227e967898`.
PostgreSQL image: `postgres:17.6-alpine`. Both were already cached; no dependency
installation or image download was needed. Testcontainers created disposable
containers with dynamically mapped ports, fixture-only credentials and a separate
`stage3c` PostgreSQL database. TLS used the existing experiment certificate and
explicit CA verification with server name `localhost`.

Five independent Dovecot users were created: `stage3c-1` through `stage3c-5`.
`fixture.generate(1000)` produced the deterministic maildir tar; `doveadm import`
imported 1,000 messages into each INBOX, 5,000 total. The controlled fixture client
expunged actual UID 100 and 500 in each account, leaving 998 per account, 4,990
total. Independent IMAP UID/envelope enumeration verified the actual inventory,
count and unique Message-IDs, rather than deriving UID from sequence position.

The existing generator provides 2001/2024 message dates and varying MIME headers,
sizes and structures. Message-IDs are deterministic and repeat across isolated
accounts by design; the correctness key includes account/mailbox/epoch/UID. The
planned injection helper generates account-specific Message-IDs and old dates.
Those additional arrivals were **NOT RUN**.

| Account   | Recorded UIDVALIDITY | Recorded UIDNEXT | Recorded inventory               |
| --------- | -------------------- | ---------------- | -------------------------------- |
| stage3c-1 | 1791894154           | 1001             | 998 identities; gaps at 100, 500 |
| stage3c-2 | 1791894158           | 1001             | 998 identities; gaps at 100, 500 |
| stage3c-3 | 1791894163           | 1001             | 998 identities; gaps at 100, 500 |
| stage3c-4 | 1791894167           | 1001             | 998 identities; gaps at 100, 500 |
| stage3c-5 | 1791894172           | 1001             | 998 identities; gaps at 100, 500 |

Fixture preparation, container startup, migrations and inventory verification took
**29,664.54 ms**. The entire attempt including normal cleanup took
**51,365.70 ms**, within the five-minute total budget. Setup cost is included,
not hidden or subtracted. Workload was not silently reduced.

## W=2 observations and durable frontiers

The run used D=2, W=2, C=1, test timing `pollMs=250`, `operationMs=4000`,
`retryMs=200`, `maxRetryMs=800`, and unchanged scheduler tuning defaults including
the 30-second protected-history age. The required second W=4 run was never started.
These accelerated fixture polling settings are not production latency guarantees.

The first five admissions were fresh, in account registration order, with five
distinct accounts. Independent PostgreSQL reads then captured these states:

| Account   | Mailbox                              | Epoch      | F    | E    | Revision | History admissions over attempted scenario |
| --------- | ------------------------------------ | ---------- | ---- | ---- | -------- | ------------------------------------------ |
| stage3c-1 | 84033de4-a5d6-458c-8626-331551f876af | 1791894154 | 1000 | 1001 | 0        | 8                                          |
| stage3c-2 | 352d1912-e343-4195-9fa7-923081208719 | 1791894158 | 1000 | 1001 | 0        | 8                                          |
| stage3c-3 | d22a2fcd-ca7d-4c9d-8fcf-dc99d54191e1 | 1791894163 | 1000 | 1001 | 0        | 1                                          |
| stage3c-4 | 2b997388-8245-455f-95ea-3b4b256961c9 | 1791894167 | 1000 | 1001 | 0        | 8                                          |
| stage3c-5 | d7b91cc8-685b-407c-aca5-cfcf31e1f4dd | 1791894172 | 1000 | 1001 | 0        | 8                                          |

These are the **initial durable enrollment snapshots**, not final history
frontiers. In this API first fresh on an unenrolled mailbox establishes F/E;
the existing archive's newest metadata comes from subsequent history windows.
The original predicate checked enrollment frontiers but did not check placement
visibility, so it does **not** prove recent metadata was durably visible.

The independent audit query did not observe at least two history publications
for every account within 20 seconds. Exact stopping error:

```text
PARTIAL: two historical windows per account exceeded 20000ms scenario deadline
```

There were 33 history admissions and 92 fresh admissions; no account errors were
recorded. All admission `active` values were at most 2. Account 3 had one history
admission while the others had eight. Admissions do not establish commits or
coverage. The final PostgreSQL audit/placement oracle was located after all
scenarios and was not reached; final database rows were not captured before
the disposable database was removed. No final E or claimed complete interval
can therefore be certified from this attempt.

## Exact outcomes

| Requirement                                                              | Outcome | Evidence / limitation                                                         |
| ------------------------------------------------------------------------ | ------- | ----------------------------------------------------------------------------- |
| Real Dovecot, real ImapFlow, separate PostgreSQL                         | PASS    | Actual fixture connections and database migrations                            |
| Five accounts, approximately 5,000 deterministic seeded messages         | PASS    | 5,000 imported; 4,990 retained after controlled gaps; full recorded inventory |
| Every account receives initial fresh opportunity, W=2                    | PASS    | First five admissions are distinct-account fresh                              |
| Initial F/E and epoch persisted, W=2                                     | PASS    | Independent PostgreSQL snapshots above                                        |
| Recent metadata durable before historical completion                     | NOT RUN | Original initial predicate did not query placements                           |
| At least two history windows for every account by scenario deadline, W=2 | FAIL    | Independent audit completion predicate timed out after 20 seconds             |
| Bounded numeric history intervals and exact atomic metadata/F/E oracle   | NOT RUN | Final oracle was not reached; do not infer from callbacks                     |
| W=2 admission capacity                                                   | PASS    | Maximum diagnostic active allocations 2                                       |
| Actual per-account sockets C=1 and global live socket cap                | NOT RUN | Measured in memory but not saved on early failure                             |
| W=4 scenarios                                                            | NOT RUN | Stopped at first scenario deadline                                            |
| Fresh injection, old-dated arrivals, E preservation and resumed history  | NOT RUN | No APPEND injections executed                                                 |
| Injection-to-independent-visibility latency samples / maximum            | NOT RUN | Zero samples; no SLA or percentile claimed                                    |
| Shutdown/restart with saved PostgreSQL state                             | NOT RUN | Scenario not reached                                                          |
| Account failure, bounded backoff, healthy progress, recovery             | NOT RUN | Scenario not reached                                                          |
| No duplicates / no advancement on failed operations                      | NOT RUN | Independent final oracle not reached                                          |
| Normal scheduler/executor stop and disposable container cleanup          | PASS    | Awaited stop calls returned; post-run Docker label query found no containers  |
| Typecheck (app and worker)                                               | PASS    | `pnpm typecheck`                                                              |
| Lint                                                                     | PASS    | `pnpm lint`                                                                   |
| Changed TypeScript/Markdown formatting                                   | PASS    | Prettier check                                                                |
| Diff whitespace                                                          | PASS    | `git diff --check`                                                            |
| Full repository regression, 50,000-message benchmark, soak               | NOT RUN | Explicitly excluded                                                           |

## Confirmed harness limitations and engine assessment

The harness lacked an early history cap: while waiting for all five accounts,
four accounts accumulated eight history admissions, exceeding the intended
2–3-window experiment. This is a confirmed **test-control limitation**; actual
complete-archive publication was not independently preserved or certified.
The attempted run did not intentionally wait for full historical completion.
It also failed to save final oracle/resources on its early exit and marked an
incomplete started W=2 run as `NOT RUN` in its raw outcome map. The report's
explicit W=2 failure classification above corrects that summary interpretation;
the original raw evidence remains unchanged.

After stopping, the committed harness was hardened to save failure snapshots,
mark a started run, check recent metadata explicitly, and use a diagnostic-only
history gate at three observed history completions. Concurrent already-admitted
turns can still settle after the gate closes; PostgreSQL remains the authority.
The PowerShell launcher now retains the process handle to preserve its exit
code. These post-attempt harness corrections received static validation only;
they were **not smoke-tested**, and are not evidence of acceptance or a repaired
engine. No deadline or production implementation was changed.

The observed unequal history admissions under 250ms polling do not establish
an integration defect. The scenario deadline was 20 seconds, shorter than the
unchanged 30-second protected-history threshold. Missing final audit data and
the harness's excessive-history control prevent a stronger diagnosis. There is
no confirmed real-server parser, persistence or scheduler defect from this run,
and no compatibility claim for unexecuted scenarios.

Resource evidence is limited to admission allocation diagnostics and returned
normal stop calls. No peak RSS, saved socket-retirement trace or Docker resource
statistics were captured. Neither historical Stage 3B W=4 teardown risk nor
safe restart behavior was independently resolved by this attempt.

## Reproduction and retained evidence

The immutable original JSON is compressed in
`experiments/imap-dovecot/stage3c-evidence.json.gz`; it includes all 4,990
account-qualified UID/Message-ID inventory entries, five initial DB states,
125 admissions, empty account-error list, exact timeout/stack and elapsed time.
The uncompressed generated JSON is ignored. The raw `W2: NOT RUN` field is a
recording defect described above; it must not be used to claim W=2 was absent.

Images must be available and the existing `.runtime/tls` fixture must contain
a valid localhost certificate before execution. To generate a fresh fixture
certificate without starting the earlier experiment's Compose services:

```powershell
$tlsDir = [System.IO.Path]::GetFullPath('experiments/imap-dovecot/.runtime/tls')
New-Item -ItemType Directory -Force -Path $tlsDir | Out-Null
docker run --rm --mount "type=bind,source=$tlsDir,target=/tls" --entrypoint openssl dovecot/dovecot:2.4.3-dev@sha256:d0db02b4aa9c16bc50c96faad68fcf5724c1453a98a39ada685409227e967898 req -x509 -newkey rsa:2048 -nodes -keyout /tls/tls.key -out /tls/tls.crt -days 30 -subj /CN=localhost -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
powershell -NoProfile -ExecutionPolicy Bypass -File experiments/imap-dovecot/stage3c.ps1
```

The launcher enforces a 300-second process deadline and removes only labeled
Stage 3C containers in `finally`, including hard-watchdog interruption. Run
only one instance at a time because fixture generation and cleanup labels are
shared. The harness writes per-scenario evidence to `stage3c-evidence.json` and
logs to ignored root log files. A hard process timeout may prevent JSON emission;
the launcher error and logs then remain the evidence. Image downloads and fixture
certificate preparation must be recorded separately if needed on another machine.

**Stage 4 readiness: NOT ESTABLISHED.** Complete Stage 3C's real-server correctness,
fresh visibility, restart, W=4 and failure-isolation checks before considering
production wiring. This task stops at Stage 3C.
