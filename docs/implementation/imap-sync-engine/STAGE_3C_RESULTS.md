# Stage 3C — remaining acceptance completed

2026-10-14. **PASS — Stage 3C acceptance complete.** Continued clean on
`test/imap-sync-stage-3c-dovecot` at
`8579ee17eef902eef1982a3e9a4a7a1709b63eb1`. Read the latest report first. Ran
exactly one W=2 `-FailureOnly` invocation, then exactly one W=4 invocation through
`-WorkersFourOnly` (passes `--workers=4`). No fixture, harness or production code
changed. Completed W=2 history/injection/restart scenarios were not repeated.
Earlier evidence below remains a historical record.

## Configuration and bounded execution

Both live fixture instances reported Dovecot **2.4.3 (c1b22ef978)** and effective
`doveconf -n` output with `service anvil / unix_listener anvil-auth-penalty / mode = 0`.
The penalty socket `/run/dovecot/anvil-auth-penalty` was absent. Normal static
password authentication and `auth_failure_delay = 2 secs` remained enabled.
Invalid credentials produced actual `IMAP AUTHENTICATE failed` errors; valid
credentials continued to authenticate. The fixture correction from the previous
commit was sufficient; no additional configuration correction was required.

The two invocations shared a **300,000 ms** outer budget. W=2 retained its
120,000 ms process cap; W=4 received only the remaining outer budget. Both retained
the existing execution cutoff and cleanup reserve. W=2 process including cleanup:
**28,407.82 ms**; W=4: **57,328.67 ms**; combined launcher wall time including
cleanup and process startup: **92,637 ms**. No timeout or assertion was relaxed.
The unchanged test timing was operationMs=4000, pollMs=5000, retryMs=200,
maxRetryMs=800 and historyWaitMs=30000; W=2/W=4, D=2, C=1.

## W=2 failure isolation and recovery

The minimal real-server fixture enrolled five empty INBOXes, then independently
inventoried one imported UID 1 per account. History remained disabled. All epochs
were **1791953372**; identity remains qualified by account/mailbox/epoch/UID.
The fixed 20-second failure observation produced **seven authentication errors**,
all on account 1, with retry delays **200, 400, 800, 800, 800, 800, 800 ms**.
Trace assertions confirmed no retry admission before its backoff expired.
There were **zero healthy-account errors or deadline failures**. All **23**
`doveadm penalty` samples returned exit 0 and a header-only empty table, including
the final cleanup sample. Healthy AUTHENTICATE round trips were **5.97–10.63 ms**.
This live counterfactual confirms absence of the previously observed shared-IP delay
within this bounded run.

Independent repeatable-read PostgreSQL boundaries preserve failure and recovery
separately (`failure-diagnostic-final`, `recovery-final`):

| Account   | During invalid credentials: F / E / revision / placements | After credential restoration: F / E / revision / placements |
| --------- | --------------------------------------------------------- | ----------------------------------------------------------- |
| stage3c-1 | 0 / 1 / 0 / 0                                             | 1 / 1 / 1 / 1                                               |
| stage3c-2 | 1 / 1 / 1 / 1                                             | 1 / 1 / 1 / 1                                               |
| stage3c-3 | 1 / 1 / 1 / 1                                             | 1 / 1 / 1 / 1                                               |
| stage3c-4 | 1 / 1 / 1 / 1                                             | 1 / 1 / 1 / 1                                               |
| stage3c-5 | 1 / 1 / 1 / 1                                             | 1 / 1 / 1 / 1                                               |

Each healthy account durably published its inventoried UID 1 while account 1
remained invalid. Restoring account 1's valid credentials permitted the same
pending UID to publish. Restoration-to-observed recovery boundary, including stop
and audit, was **206.51 ms**. All **24** captured SQL boundaries passed the oracle
and offline replay. Failure did not advance account 1's F, E or revision.

## W=4 durable history, fresh visibility and restart

Five real Dovecot accounts each imported 1,000 messages, with controlled expunges
at actual UIDs 100 and 500. Independent UID/envelope enumeration retained **4,990**
account-qualified identities. All five first admissions were fresh and distinct.
Each account then committed exactly three 128-UID historical windows, preserving
incomplete history throughout. E progressed **1001 → 873 → 745 → 617** per account.
Recent metadata was durable after window one (128 placements/account); after window
two each had 256 placements. No complete archive synchronization was required.

Three old-dated messages per account were APPENDed while E=745 and history was
incomplete. All **15** exact UID/Message-ID identities became independently visible
in PostgreSQL. F advanced 1000→1003; E stayed **745** for every account. Window three
then moved E to 617, with 387 placements/account. Stop/restart used the same database,
first admitted fresh work for all five accounts, and preserved the complete saved
frontier/epoch/revision/placement state exactly.

The existing W=4 failure/recovery phase also passed: five invalid-password errors
were confined to account 1, starting with 200/400/800 ms backoff. One further message
per healthy account advanced F to 1004 while account 1 remained at 1003. After valid
credential restoration, its further message advanced F to 1004. Final SQL state:

| Account   | Epoch      | E progression    | Final F | Revision | History windows | Exact placements | Maximum initial-arrival visibility, ms |
| --------- | ---------- | ---------------- | ------- | -------- | --------------- | ---------------- | -------------------------------------- |
| stage3c-1 | 1791953403 | 1001→873→745→617 | 1004    | 5        | 3               | 388              | 375.07                                 |
| stage3c-2 | 1791953406 | 1001→873→745→617 | 1004    | 6        | 3               | 388              | 5705.12                                |
| stage3c-3 | 1791953411 | 1001→873→745→617 | 1004    | 5        | 3               | 388              | 5139.03                                |
| stage3c-4 | 1791953416 | 1001→873→745→617 | 1004    | 5        | 3               | 388              | 5098.42                                |
| stage3c-5 | 1791953420 | 1001→873→745→617 | 1004    | 5        | 3               | 388              | 5378.23                                |

Account 2's extra revision corresponds to splitting the fresh arrivals across two
durable publications; the independent audit reconstructs each consecutive revision
and exact interval. All **15** W=4 SQL boundaries passed live verification and offline
replay, including full placement account/epoch/UID/Message-ID comparisons and atomic
publication audit. There were no duplicate placements, false frontier advances or
account overlap. Fresh visibility measures APPEND acknowledgement to independent
SQL visibility, with the observer active during the initial delivery batch. Maximum
across all **20** injections (initial arrivals plus failure/recovery arrivals) was
**5705.12 ms**. These are bounded smoke observations under 5-second polling, not a
production latency guarantee. Healthy authentication round trips in W=4 were at
most **51.46 ms**; the final penalty table was empty.

## Resources, exact outcomes and remaining risk

Peak scheduler-owned IMAP connections were **2 / 4** for W=2/W=4, observed owned
PostgreSQL sockets peaked at **2** in each run, and per-account overlap was false.
Final owned IMAP connections, PostgreSQL sockets and active scheduler slots were
all **zero**. W=2's two measured stops took **1.23 / 9.15 ms**; W=4's ten measured
scheduler stops took **0.16–0.79 ms**. Both executor stops completed. Both cleanup
statuses were PASS with empty error lists; a post-run Docker label query found no
remaining disposable Stage 3C containers.

| Check                                                                                | Outcome                 |
| ------------------------------------------------------------------------------------ | ----------------------- |
| Effective live fixture penalty disabling; normal authentication and rejection        | PASS                    |
| W=2 bounded backoff, four healthy durable publications and restored-account recovery | PASS                    |
| W=2 independent F/E, epochs, revisions, placements and resources                     | PASS                    |
| W=4 five accounts / approximately 5,000 seeded messages / initial fresh discovery    | PASS                    |
| W=4 exactly three durable historical windows per account, incomplete history         | PASS                    |
| W=4 old-dated fresh visibility, E preservation and resumed history                   | PASS                    |
| W=4 restart against same SQL state and fresh-first admissions                        | PASS                    |
| W=4 exact placements / revisions / epochs, no duplicates or false advancement        | PASS                    |
| W=4 failure isolation and restored-account durable progress                          | PASS                    |
| W/D/C limits, no account overlap, clean retirement and container cleanup             | PASS                    |
| 300-second combined budget; one invocation per required scenario                     | PASS                    |
| Focused harness preflight, offline boundary replay and changed-report formatting     | PASS                    |
| Stage 1–3B regressions, soak, 50k benchmark and Stage 4 implementation               | NOT RUN — outside scope |

**Stage 3C acceptance: PASS. Stage 4 readiness: the Stage 3C acceptance gate is met.**
This authorizes no production wiring or Stage 4 work, and none was started. The
historical intermittent W=4 teardown timeout was **not reproduced** in this single
run; its intermittent nature remains a risk and is not proven resolved by ten fast
stops. This is bounded acceptance, not soak or full-archive coverage. Existing W=2
history/injection/restart evidence below combines with today's isolated W=2 failure
check and complete controlled W=4 run to close the required acceptance gaps.

## Retained independent evidence

Two new immutable gzip artifacts preserve the original raw JSON, full SQL boundary
snapshots/audit/placements, actual server inventories, passive per-turn traces,
socket retirement and Dovecot logs. Earlier artifacts are unchanged. SHA-256 values
are of the uncompressed JSON:

| Artifact in experiments/imap-dovecot      | SHA-256                                                            | Replayed boundaries |
| ----------------------------------------- | ------------------------------------------------------------------ | ------------------- |
| stage3c-accepted-failure-evidence.json.gz | `8bba0d0e43d1eb85acf59ad7589d4701eed04ef8973da575b5ed1f42ee8edda9` | 24                  |
| stage3c-accepted-w4-evidence.json.gz      | `cadc60c1403f8f75de89d6d04a54473cbe3e81299c52741afe0aad11e782415a` | 15                  |

The raw files' NOT RUN entries describe the other invocation: W=4 is separate from
the failure-only file, and completed W=2 history is intentionally excluded from the
W=4-only file. The combined classifications above are authoritative for this task.
Runtime JSON and launcher logs remain ignored. Only this report and new evidence
artifacts changed; no fixture or harness correction was needed. Work stops at Stage 3C.

---

# Stage 3C — final acceptance attempt

2026-10-13. **BLOCKED: fixture startup failed; acceptance remains PARTIAL.**
Continued on `test/imap-sync-stage-3c-dovecot`, clean at the requested base
`a2ac46f81d4bd30fd6a15c72f851f969fcdfb168`. Read the latest diagnosis below first.
Production Stage 1–3B code, IMAP settings, operation deadlines, retry limits,
executor capacities and scheduling policy were not changed. No regressions,
push, merge, PR or Stage 4 work were performed.

## Fixture correction and effective configuration

Stage 3C mounts its own `stage3c-dovecot.conf`, which includes the unchanged
shared experiment configuration. The supported Dovecot 2.4 setting is:

```text
dovecot_config_version = 2.4.3
!include /etc/dovecot/stage3c-base.conf
service anvil {
  unix_listener anvil-auth-penalty {
    mode = 0
  }
}
```

The listener setting follows the
[official Dovecot 2.4 documentation](https://doc.dovecot.org/2.4.1/core/config/auth/penalty.html).
The final file was checked with the pinned Dovecot 2.4.3 image using its actual
`doveconf -n` parser, without starting a server or receiving scenario. Exit code
was **0**, and effective output contains the exact anvil listener with `mode = 0`,
the static passdb, required TLS and the original rootless listener ports. Normal
password configuration and `auth_failure_delay` were not edited. This confirms
the configured disabling, **not runtime absence of penalties or password rejection**.

## Single attempted execution and stopping evidence

One invocation of the existing `-FailureOnly` launcher was attempted at
2026-10-13 19:13:29 Europe/Warsaw (17:13:29 UTC). The new wrapper initially omitted
the first-setting version declaration. The attempt failed during Dovecot fixture
startup with HTTP 409:

```text
container stopped/paused - container
2da8109d5bd5f299cbfd3a335f937cc80b87097cdfa3be07dadc33bee2455382 is not running
```

A subsequent parser-only diagnostic returned exit **89** and:

```text
doveconf: Fatal: Error in configuration file /etc/dovecot/dovecot.conf line 2:
The first setting must be dovecot_config_version
```

The missing declaration was corrected, then parser validation passed. There was
**no second smoke invocation**. W=4 was not dispatched after the failure, as
required by the mandatory-condition stop rule. No deadline was raised.

The harness recorded **2,434.27 ms**, including its cleanup. The outer execution
measured **6,041 ms**, including launcher cleanup, well below the combined
300-second budget. Cleanup errors were empty. A post-run Docker query found no
containers labeled `maildock.stage3c=disposable`. No scheduler or owned receiving
resources were created. Testcontainers removed the failed startup container before
the harness could retain server logs; the raw Docker error, launcher logs and
independent parser diagnostic are retained. No live penalty samples were obtained.

## Harness preparation, validation and exact outcomes

The failure-only path now checks all four healthy durable frontiers, exact
200/400/800ms backoff, no early readmission, empty IP penalty samples and existing
SQL/resource oracles. It saves the failed-account boundary separately, restores
valid credentials and captures independent recovery state. `--workers=4` selects
only the existing W=4 scenarios; its evidence filename is separate. Passive
diagnostics also measure D=2 PostgreSQL socket ownership in W=4. The launcher can
receive a reduced remaining process budget; the original caps cannot increase.
These new runtime checks are **unexecuted** because fixture startup failed.

| Mandatory check                                                       | Outcome | Evidence                                                               |
| --------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------- |
| Supported fixture setting and final effective parser configuration    | PASS    | Dovecot 2.4.3 `doveconf -n`, exit 0, listener mode 0                   |
| Disposable fixture startup in the single smoke attempt                | FAIL    | HTTP 409; parser diagnostic identifies missing initial version setting |
| Runtime penalty disabling and invalid-password rejection              | NOT RUN | Server scenario never started                                          |
| W=2 failure isolation, durable healthy progress and bounded backoff   | NOT RUN | No scheduler lifetime or SQL snapshots                                 |
| Restored-account recovery                                             | NOT RUN | No failure/recovery lifetime                                           |
| W=4 initial fresh discovery, exactly 2–3 history windows              | NOT RUN | Stopped after fixture failure                                          |
| W=4 durable E progression, F, epochs, revisions and all placements    | NOT RUN | No W=4 SQL state; no per-account E values to report                    |
| W=4 old-dated fresh visibility and E preservation                     | NOT RUN | No injections or latency measurements                                  |
| W=4 same-state restart, no duplicates/overlap and resource retirement | NOT RUN | No W=4 execution                                                       |
| Cleanup of attempted fixture                                          | PASS    | Empty cleanup errors and no labeled containers remaining               |
| Focused oracle/diagnostic preflight, typecheck, lint, formatting      | PASS    | Checks completed; no regression suites                                 |

The previous accepted W=2 durable history, fresh visibility and restart evidence
below remains unchanged. It does not establish this attempt's failure isolation
or W=4 acceptance. The historical intermittent W=4 teardown timeout remains an
unresolved risk; neither reproduction nor resolution is claimed here. The repaired
fixture and new harness assertions still require a separately authorized bounded
acceptance execution. **Final Stage 3C: PARTIAL; Stage 4 readiness: NOT ESTABLISHED.**
Work stops after Stage 3C.

## Retained evidence

`experiments/imap-dovecot/stage3c-final-acceptance-evidence.json.gz` preserves the
unchanged raw smoke JSON, launcher stdout/stderr, failed and repaired parser output,
and exact report classifications. The raw JSON's fixture `NOT RUN` is a preexisting
recording limitation for startup failure; the fixture attempt is **FAIL** above.
Older compressed evidence artifacts remain unchanged. Runtime files remain ignored.
SHA-256 of the uncompressed final evidence JSON:
`b977e6733d36f161a7ca21a27bb477b5fa529aff962bc25d48ad81ab22d09e24`.

---

# Stage 3C — healthy-account timeout diagnosis

2026-10-13. **TEST ENVIRONMENT ISSUE — shared-IP Dovecot authentication penalty.**
One W=2 failure-only diagnostic reproduced healthy-account deadline failures and
localized them to waiting for AUTHENTICATE, before SELECT/SEARCH/FETCH or metadata
persistence. Dovecot applied an authentication penalty to the shared fixture IP.
When that observed penalty returned to zero, all four healthy accounts committed
bounded metadata work with the same four-second deadline and capacities.
No production fix or fixture-policy correction was implemented.

## Base, execution mode and limits

Started clean on `test/imap-sync-stage-3c-dovecot` at
`44fd36205f751895741e6c758bd1a4321728afa4`. The existing harness now supports
`--failure-only`, exposed by the existing PowerShell launcher as `-FailureOnly`.
It reuses the same disposable Dovecot/PostgreSQL images, TLS, database migrations,
account provisioning, Stage 1 executor, Stage 3B scheduler and independent oracle.

Minimum fixture: five independently enrolled empty INBOXes with actual epoch and
UIDNEXT=1, F=0/E=1/revision=0, followed by one `doveadm import` message per account.
Actual UID/envelope reads recorded all five pending UID 1 identities. No receiving
history, previous arrival batch or scheduler restart was replayed. Account 1 used
the identical invalid-password factory method; the other four credentials were
unchanged. History was disabled through the existing global gate.

Exactly **one** diagnostic scheduler lifetime ran for a fixed **20 seconds** with
W=2, D=2, C=1, `operationMs=4000`, `pollMs=5000`, retry delays 200/400/800ms and
unchanged production selection policy. Scheduler-managed backoff retries are
observations within that lifetime, not diagnostic reruns. No complete smoke or
W=4 execution was performed.

The process budget was reduced to 120 seconds, reserving 20 seconds for cleanup
and an emergency evidence checkpoint five seconds before the outer limit. Actual
fixture/enrollment/one-message preparation: **7,397.89 ms**; observed scenario
through scheduler drain: **20,012.03 ms**; entire process including cleanup:
**28,666.38 ms**. No deadline or capacity was increased.

## Passive instrumentation and independent evidence

All instrumentation is in `experiments/imap-dovecot/stage3c-diagnostics.ts` and the
standalone harness. No production source or ImapFlow/postgres.js patch was edited.
The helper observes the actual Node TCP/TLS streams without changing connection
arguments or return values, and restores the process-local observers in `finally`.
Authentication data is redacted: command observations contain verbs/tags only.

Per-turn monotonic records cover scheduler admission, first execution guard,
authority/lease and recovery transaction requests, actual transaction callback
entry/exit, lease-row lock/renewal, TCP connect, TLS secure completion, IMAP greeting,
command sends/tagged replies, native socket closure, IMAP retirement, persistence
transaction settlement and scheduler allocation release. AsyncLocalStorage assigns
owned executor sockets to the active account turn.

`postgres.*.request → admitted-work-start` includes executor admission, TCP/driver
startup, BEGIN and timeout setup; it is not mislabeled as pure queue wait.
`work-end → settled-slot-released` includes COMMIT/ROLLBACK and driver retirement;
no claim is made to separately time an internal COMMIT packet or driver `onclose`.
Native socket close is independently recorded. Scheduler completion/error callbacks
run after the implementation deletes its active allocation. Cancellation at stop
is separately marked `scheduler.drained-on-stop`.

The reported eligible wait precedes scheduler allocation and is derived from
observed eligibility/previous completion/backoff. It is an observer estimate of
waiting for W/selection, not operation execution duration. For these first fresh
admissions the five accounts were simultaneously eligible; no history competed.
The four-second turn deadline begins at admission, not at earlier eligibility.

Once-per-second observations also capture `doveadm penalty` and PostgreSQL
`pg_stat_activity`. `finally` preserved Dovecot logs, the final server sample,
22 repeatable-read SQL boundaries, full placements, publication audit, connection
counts, retirement, all ten errors and all 15 turn traces. All 22 SQL oracles
passed, including the final failure/cleanup boundary and offline replay.

## Phase timings: affected accounts 3 and 4

All values are milliseconds. Eligible wait is outside the operation budget.
Execution start, TLS, AUTH send/reply and total slot duration are relative to
scheduler admission. Lease and recovery columns are whole transaction durations
including connection/commit/retirement. A dash means AUTH did not reply before
cancellation; consequently SELECT/SEARCH/FETCH/persistence were **not reached**.

| Turn | Account   | Eligible wait outside deadline | Execution start | Lease transaction | Recovery transaction | TLS secure | AUTH sent | AUTH reply | Total allocated duration |
| ---- | --------- | ------------------------------ | --------------- | ----------------- | -------------------- | ---------- | --------- | ---------- | ------------------------ |
| 3    | stage3c-3 | 2135.55                        | 0.07            | 24.99             | 33.82                | 72.15      | 74.63     | -          | 4011.84                  |
| 4    | stage3c-4 | 4003.06                        | 0.07            | 32.54             | 37.85                | 84.83      | 86.87     | -          | 4010.89                  |
| 8    | stage3c-3 | 5675.17                        | 0.05            | 41.78             | 27.55                | 81.80      | 84.17     | -          | 4000.54                  |
| 9    | stage3c-4 | 5941.41                        | 0.08            | 34.88             | 35.84                | 85.34      | 88.20     | -          | 4001.63                  |
| 13   | stage3c-3 | 1518.21                        | 0.02            | 27.52             | 36.01                | 76.04      | 80.51     | 89.34      | 157.80                   |
| 14   | stage3c-4 | 3.91                           | 0.07            | 43.75             | 25.54                | 83.31      | 86.41     | 92.78      | 165.88                   |

For account 3's first affected turn, TCP connected at +61.26ms, TLS at +72.15ms,
and AUTHENTICATE was sent at +74.63ms. There were **no further incoming bytes**
before retirement at +4011.13ms. Account 4 similarly connected TCP at +73.06ms,
secured TLS at +84.83ms and sent AUTHENTICATE at +86.87ms, with no subsequent
incoming bytes before retirement at +4010.11ms. Thus approximately 3.92–3.94 seconds
were spent waiting for authentication protocol progress, rather than fetching or
publishing metadata. The few milliseconds beyond 4000 are timer dispatch and
settlement observations, not an increased operation deadline.

When the server penalty had cleared, account 3 authenticated in **8.83ms** and
account 4 in **6.37ms**. Successful work then followed:

| Successful turn    | SELECT round trip | UID SEARCH round trip | UID FETCH round trip | IMAP retirement | Persistence transaction including commit/retirement | Total allocated duration |
| ------------------ | ----------------- | --------------------- | -------------------- | --------------- | --------------------------------------------------- | ------------------------ |
| Account 3, turn 13 | 1.64              | 0.97                  | 1.97                 | 0.50            | 57.25                                               | 157.80                   |
| Account 4, turn 14 | 1.98              | 1.32                  | 1.72                 | 0.63            | 61.42                                               | 165.88                   |

Across all traces, admission-to-first-execution lag was at most **0.69ms**. Whole
lease transactions were at most **54.17ms**, lease-row lock acquisition at most
**15.60ms**, and whole recovery transactions at most **49.29ms**. Observed owned
PostgreSQL sockets never exceeded D=2; every activity sample had no retained
Stage 1 backend. The sampling could miss brief SQL locks, but per-turn timings
bound them far below the failed authentication wait. No multi-second database
or socket-retirement bottleneck was observed.

## Server-side shared resource and root-cause assessment

Before the scheduler started, `doveadm penalty` was empty. All fixture sessions
were logged by Dovecot with source IP **172.17.0.1**, regardless of IMAP user.
The next sample after the first invalid-password request showed:

```text
IP         penalty last_penalty        last_update
172.17.0.1 1       2026-10-13 13:09:14   13:09:14
```

That score remained 1 throughout repeated healthy authentication stalls. The
sample at monotonic 26604.12ms showed score **0**, after which successful healthy
turns appeared. Dovecot's effective configuration reported
`auth_failure_delay = 2 secs`; account 1's first AUTH failure reply took
**2014.29ms**. Dovecot logs reported the failed healthy sessions as
`auth_waiting_client`, with the SASL exchange unfinished at the client's close.
That log label alone is not blamed on ImapFlow: the actual receive-byte observer
shows no server continuation/reply reaching those clients after AUTHENTICATE.

Dovecot documents that authentication penalties are tracked **per IP**, before
password lookup, and grow from the initial two-second failed-auth response to
four-second and longer delays. This is the server-side shared state that makes
an invalid password on one fixture user affect other users connecting through
Docker's same source IP. A four-second server auth delay does not fit within the
remaining ~3.9 seconds of this turn's unchanged total operation budget.
[Official Dovecot authentication penalty documentation](https://doc.dovecot.org/2.4.1/core/config/auth/penalty.html).

**Assessment: TEST ENVIRONMENT ISSUE.** Reproduced phase localization, live shared
penalty state, same source IP, absence of auth bytes during penalty and fast
healthy authentication after the penalty cleared support this mechanism. The
shared resource is Dovecot's IP-scoped authentication penalty, not a global
PostgreSQL admission deadlock or lost connection retirement.

Limitations: no server-internal penalty timer trace or penalty-disabled
counterfactual was run, and this diagnosis does not prove the cause of every
individual timeout in the earlier uninstrumented 5,000-message run. The documented
four-second penalty is consistent with the observed premature client closes;
its full server delay was not observed because the client deadline fired first.
No universal healthy-account latency guarantee or repaired engine is claimed.

## Durable progress, backoff and cleanup

All five actual selected epochs were 1791896952 in this minimal fixture; epoch
uniqueness across users is not assumed. The key is account/mailbox/epoch/UID.
Independent final state:

| Account   | Epoch      | F   | E   | Revision | Exact placements |
| --------- | ---------- | --- | --- | -------- | ---------------- |
| stage3c-1 | 1791896952 | 0   | 1   | 0        | 0                |
| stage3c-2 | 1791896952 | 1   | 1   | 1        | 1                |
| stage3c-3 | 1791896952 | 1   | 1   | 1        | 1                |
| stage3c-4 | 1791896952 | 1   | 1   | 1        | 1                |
| stage3c-5 | 1791896952 | 1   | 1   | 1        | 1                |

Each healthy account durably published exactly its inventoried UID 1 and Message-ID
with a single bounded fresh transaction. The bad account published nothing and
retained F=0/E=1/revision=0. There were no duplicates or false frontier advances.
Healthy progress occurred during the same diagnostic lifetime while the invalid
password remained configured, without restoring account 1.

Account 1's error/retry records were:

| Error                                | Monotonic timestamp | Retry delay |
| ------------------------------------ | ------------------- | ----------- |
| `IMAP AUTHENTICATE failed`           | 12282.87ms          | 200ms       |
| `Metadata window deadline exhausted` | 22169.94ms          | 400ms       |
| `IMAP AUTHENTICATE failed`           | 27925.53ms          | 800ms       |

Actual readmissions were later than retry eligibility because W=2 was occupied:
first retry had an additional **5678.46ms** eligible wait, next **3767.82ms**.
The scheduler did not admit the account before its backoff delay expired.
A fourth account-1 turn was canceled at the fixed scenario stop and is recorded
as cancellation, not a successful operation or retry error.

Seven healthy deadline errors occurred: account 2 twice, account 3 twice, account 4
twice and account 5 once. Those failed turns never reached SELECT/SEARCH/FETCH or
metadata persistence. Four later healthy turns succeeded; one final bad-account
turn was canceled. Maximum scheduler-owned IMAP connections: **2**, per-account
overlap: **false**, maximum owned PostgreSQL sockets: **2**. Final owned IMAP/PG
connections and scheduler execution slots were all zero. Both disposable containers
were removed, and cleanup errors were empty.

## Smallest recommended correction and exact outcome

For a later authorized smoke evaluation, isolate the fixture's invalid-password
fault from the IP-wide penalty. The smallest documented fixture-only correction
is to disable the anvil authentication-penalty listener in the disposable Dovecot
configuration:

```text
service anvil {
  unix_listener anvil-auth-penalty {
    mode = 0
  }
}
```

Keep the normal failed-password response delay, four-second turn deadline, W=2,
D=2, C=1 and scheduler policy. The snippet is a **recommendation only**: it was
neither applied nor tested here. No production configuration change is recommended
from this fixture diagnosis. The same official documentation above specifies this
listener setting; disabling `auth_failure_delay` alone would not address the
shared-IP penalty mechanism.

| Check                                             | Outcome                                                |
| ------------------------------------------------- | ------------------------------------------------------ |
| Single isolated W=2 diagnostic                    | COMPLETE; symptom REPRODUCED                           |
| Account 3/4 timeout phase                         | CONFIRMED: authentication protocol wait                |
| Shared-IP penalty attribution                     | TEST ENVIRONMENT ISSUE, evidence and limitations above |
| Bad-account bounded backoff                       | PASS: 200/400/800ms, no early readmission              |
| Healthy-account bounded durable progress          | PASS: all four published UID 1 before stop             |
| Independent final state and 22 boundary oracles   | PASS                                                   |
| W/D/C limits and native resource settlement       | PASS                                                   |
| Container cleanup and evidence in finally         | PASS                                                   |
| Typecheck, lint, formatting, diagnostic preflight | PASS                                                   |
| Penalty-disabled verification / correction        | NOT RUN / NOT IMPLEMENTED                              |
| Complete Stage 3C smoke, W=4, Stage 4             | NOT RUN                                                |

Stage 3C remains **PARTIAL** and Stage 4 readiness is unestablished. This diagnosis
ends here; it does not implement a production fix or authorize another evaluation.

## Retained evidence and reproduction

`experiments/imap-dovecot/stage3c-failure-evidence.json.gz` preserves all per-turn
monotonic events, effective failure-delay settings, 21 server samples, full
Dovecot logs, ten errors, durable snapshots, UID inventory and retirement evidence.
SHA-256 of uncompressed JSON:
`10fa5bf7929d96fccd396964ec34c724c4789551bf7f610ea7b75c3d9bcee1f1`.
Earlier smoke artifacts remain unchanged. Runtime JSON is under the ignored
`.runtime` directory, and the launcher writes separate ignored failure-mode logs.

```powershell
node --import tsx experiments/imap-dovecot/stage3c.ts --check
powershell -NoProfile -ExecutionPolicy Bypass -File experiments/imap-dovecot/stage3c.ps1 -FailureOnly
```

The preflight checks oracle negatives plus diagnostic attribution, deadline,
credential redaction and observer restoration without starting a server scenario.
The full smoke path is unchanged in scope and was not executed in this task.

---

## Previous corrected smoke evaluation — historical record

### Stage 3C — corrected harness and one real-Dovecot evaluation

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
