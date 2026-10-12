# Network, fairness and sustained-operation results

Measured on 2026-10-12 using isolated Dovecot/PostgreSQL. Commands and pins:
[SETUP.md](SETUP.md). All raw summaries, including partial/failing runs, are
retained in [measurements.json](../../../experiments/imap-durability/outputs/measurements.json)
and timestamped gzip traces. These are laboratory observations, not provider SLAs.

## Network profiles

| Profile            | Result | Measured NOOP RTT p50 / max ms | Metadata bytes/s median | First metadata ms | Worst arrival or fault occupation ms |
| ------------------ | ------ | ------------------------------ | ----------------------- | ----------------- | ------------------------------------ |
| local              | PASS   | 1.36 / 2.33                    | 2159030.08              | 167.82            | 113.16                               |
| 20ms-requested     | PASS   | 31.08 / 32.06                  | 392184.96               | 779.61            | 377.82                               |
| 100ms-requested    | PASS   | 124.26 / 125.72                | 79060.56                | 2605.29           | 1105.87                              |
| 128KiB-per-second  | PASS   | 31.13 / 47.04                  | 90934.99                | 1326.23           | 418.90                               |
| hang-after-search  | PASS   | — / —                          | —                       | —                 | 10006.10                             |
| reset-after-search | PASS   | — / —                          | —                       | —                 | 86.57                                |
| temporary-blackout | PASS   | — / —                          | —                       | —                 | 5761.35                              |

The relay forwards TLS unchanged, with no host-wide network settings. Delay and
bandwidth are requested settings; the table gives actual measured values. A
zero-delay relay now forwards immediately; earlier retained runs incurred Windows
timer quantization even at zero requested delay. Requested 20 ms does not establish
20 ms measured RTT. There are 20 RTT samples, three throughput samples and ten
arrival samples per healthy profile. No p99 is inferred from those small arrival
samples. Arrival reference is the actor's actual APPEND acknowledgment, with
visibility from successful durable ingestion; user work intervenes deliberately.

Hung FETCH and connection reset advance no frontier and recover by replay.
The configured full turn remains 10 s. The delayed/blackout case completes within
that budget. Healthy impaired trials did not justify raising it; production policy
still needs provider/cold-authentication measurements and bounded reconnect/backoff.

Kernel netem (Dovecot namespace only): result **PASS**, requested
20 ms egress delay / 3% loss / seed 2403; actual dropped packets **30**.
RTT p50/p95/p99/max: 22.87 / 23.94 /
257.87 / 259.17 ms. Independent final
comparison: 1024 exact current identities.
The qdisc's actual byte/packet/drop counters are in its trace and it is removed
after the test. TCP blackout/reset relay tests are separate from actual packet loss.

## Eight-account worker/pool matrix

Two initial accounts have 50,000-message history, two receive continuous APPENDs,
two have coalesced simulated user flag/content work, two have external flag/delete
mutations, and the remaining profiles include slow/temporarily rejected connections.
Roles overlap across eight independent accounts. All own data operations are serial
within an account; the independent actors are additional server sessions. Due times,
owner renewal, actual SEARCH/FETCH/STORE/BODY.PEEK and PostgreSQL commits consume
shared resources. W>=2 preserves one current worker opportunity while history uses
leftover capacity; constrained PostgreSQL pools are actual client pools.

Latest result for each profile (all earlier results remain in the measurement index):

| Run  | W/DB pool | Demand    | DB boundary | Result | Arrivals | Fresh p50 / p95 / p99 / max ms       | User wire admission p95 / max ms | Core-operation worker occupation |
| ---- | --------- | --------- | ----------- | ------ | -------- | ------------------------------------ | -------------------------------- | -------------------------------- |
| 60s  | 1/1       | saturated | pre-fix     | PASS   | 134      | 920.21 / 3338.15 / 4722.98 / 5233.01 | 4493.94 / 6117.59                | 96.78%                           |
| 60s  | 2/2       | saturated | pre-fix     | PASS   | 142      | 390.61 / 695.95 / 1076.95 / 1482.16  | 1046.55 / 2044.60                | 94.72%                           |
| 60s  | 4/1       | saturated | post-fix    | PASS   | 140      | 317.93 / 482.26 / 872.07 / 928.09    | 643.14 / 1048.71                 | 85.52%                           |
| 60s  | 4/6       | finite    | pre-fix     | PASS   | 104      | 62.77 / 353.53 / 410.19 / 434.12     | 104.30 / 243.18                  | 67.34%                           |
| 600s | 4/2       | saturated | post-fix    | PASS   | 1160     | 187.17 / 317.17 / 384.42 / 1150.14   | 311.47 / 1399.21                 | 88.47%                           |

User admission in final instrumentation is the actual logged UID STORE command,
not just selector order. Fresh visibility is recorded independently of the APPEND
callback so already-ingested UIDs are not assigned an invented later timestamp.
Per-account eligible waiting, transport scopes, commits, retries and one-second
resource samples remain in the traces. Occupation includes connection preparation,
selection, SEARCH/FETCH and database admission/commit; synchronous trace serialization
and gzip backpressure are experimental observation overhead. Histories rotate again
after saturation rather than draining one mailbox at a time.

The fixed saturation reference intentionally keeps current demand eligible for all
accounts; **zero history progress under that demand is expected**. Each saturated
run checks its historical frontiers are unchanged. Finite-load history progress and
actual post-demand history admission/completion are separately measured. The
600-second run admitted 0 history rows
during saturation; its first post-demand history admissions were
746.09 ms
after current flushing began. This is admission followed by real completed history
turns, not a scheduler-order-only assertion. Full repair/convergence plus independent
oracle reading took 91261.51 ms; that total
includes expensive verification and is not the first history-resume latency.

Final long-run account counts and waits:

| Account   | Admitted turns | Eligible wait p95 ms | Worst eligible wait ms |
| --------- | -------------- | -------------------- | ---------------------- |
| p3-load-0 | 4000           | 118.46               | 276.67                 |
| p3-load-1 | 4111           | 118.57               | 546.66                 |
| p3-load-2 | 4329           | 146.69               | 586.59                 |
| p3-load-3 | 4288           | 144.13               | 631.38                 |
| p3-load-4 | 4404           | 127.05               | 458.27                 |
| p3-load-5 | 4413           | 129.68               | 382.29                 |
| p3-load-6 | 1678           | 122.24               | 574.99                 |
| p3-load-7 | 3929           | 144.09               | 902.97                 |

The slow account has different service cost and the unavailable account has retry
cooldown; neither is hidden from the table. Compare similarly eligible healthy
accounts, not unequal service costs. There is one deterministic schedule per matrix
profile, plus repeated development trials, not 30 independently seeded schedules.

## Ten-minute resource behavior

Final long reference: 2026-10-12T13-44-04-755Z-workload-W4-D2-summary.json; 32839 complete/rejected
operation records, 1160 APPEND identities, 1160 actual
EXISTS hints, 1160 coalesced durable hint flushes. Work sets are
asserted at most eight account hints/ready entries, two user intents and W running
operations. No promise is created for each notification. Gzip writers respect
backpressure; the latest resource trace also exposes their pending bytes.

| Minutes | Samples | RSS range MiB | Peak heap MiB | Max ready/user/running/hints | Max pending trace bytes |
| ------- | ------- | ------------- | ------------- | ---------------------------- | ----------------------- |
| 0–2     | 119     | 89.52–261.79  | 113.30        | 5/2/4/2                      | 2998                    |
| 2–4     | 119     | 259.11–262.30 | 116.80        | 6/2/4/1                      | 2149                    |
| 4–6     | 118     | 260.86–267.43 | 113.82        | 5/2/4/1                      | 3545                    |
| 6–8     | 119     | 264.82–267.13 | 113.76        | 5/2/4/1                      | 3000                    |
| 8–10    | 118     | 265.12–270.66 | 121.94        | 5/2/4/1                      | 3757                    |

Memory includes ImapFlow, the coordinator, PostgreSQL client/prepared statements and
measurement arrays. DB wait/transaction samples retain at most the last 20,000;
the operation ring retains 512. One-second samples miss transient peaks and do not
prove a strict allocation ceiling. Warming/GC changes are distinguished from
unbounded work-set growth. Queue bounds and final convergence are mandatory;
a flat dispatch list alone is insufficient.

Active reference DB wait p50/p95/p99/max:
2.19 / 8.20 /
11.73 / 324.15 ms.
Active DB transaction p50/p95/p99/max:
5.43 / 11.46 /
15.27 / 324.38 ms.
Retries are retained individually, mainly induced connection resets/retirement on
the unavailable account. Correctness is evaluated after quieting, completed coverage
and membership/flags repair. Every completed load profile compares all current UIDs,
message IDs, subjects, sizes and permanent flags with independent IMAP reads.

## Counterexamples and explicit limits

**Retained safety failure:** the cancelled DB callback reproduction found a newer
writer reporting success with 0/32 durable rows. Its old postgres.js callback
ROLLBACK ran on a reused connection. The post-fix boundary explicitly owns transaction
commands, invalidates SQL and lazy-query execution on retirement, and rejects that
old callback. Only rows marked post-fix above exercise the repaired store. Older
matrix/network metrics remain useful historical measurements but do not pass that
fault's safety gate. The corrected callback, atomic/crash and reconciliation cases
are rerun before dependent post-fix performance; see DURABILITY_RESULTS.md and the
retained old/new store hashes.

Worst fresh availability across **all retained load runs** is 179441.68 ms.
The initial W=1 shutdown harness withheld its last two arrivals while draining history
before the final fresh check (about 179 s). That is a retained performance failure,
not excluded from the overall worst. Final recovery flushes current work first and
rotates history. Initial utilization sampling also understated occupancy; those
legacy utilization values are invalid. Global parity could repeatedly favor one
current category; final selection alternates per account. Earlier network failures
were a stale measurement-client deadline and LOGOUT cleanup evidence, not passing
profiles; both traces remain. The first netem coordinator stage was blocked by a
concurrent uncertainty-test lease and was rerun sequentially.

Reference restoration after the 15,000-deletion case imports 15,000 synthetic
messages with fresh server-assigned UIDs into **only** the Phase 3 account. It restores
two >=50k histories for final repeats and leaves the real old numeric UID gap.
No UID index files are fabricated; original Phase 2 data is untouched.

Provisional 5 s user admission and 2 s healthy occupation hypotheses must be judged
against the relevant finite/degraded conditions, not saturation totals or selected
means. Some early saturation tails exceeded 5 s and remain reported. Provider OAuth,
production queue/notifications/business work, permanent FETCH omission and billion-
sized real UID gaps remain unproven. K=128 is a work size; measured input and parser
budgets are enforced, without a strict parser-token claim or parser fork.

Recommendation: [REQUIRES ARCHITECTURE REVISION](RECOMMENDATION.md).
