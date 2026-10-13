# Stage 3C — real Dovecot integration smoke

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
