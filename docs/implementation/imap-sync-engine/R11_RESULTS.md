# R11 — On-demand message content retrieval

## Completion audit (2026-10-15, before changes)

The original R11 below remains historical evidence. The effective bottlenecks
are the 256 KiB content admission and automatic request, 256 KiB aggregate
encoded/decoded policy, and the 64 KiB + maxBytes socket ceiling. The latter must
also carry headers, repeated BODYSTRUCTURE, per-window framing and tagged replies.
The adapter's 256 KiB response ceiling is per response; 32 KiB slices and 16 KiB
headers fit without raising it. Its download maxBytes limits intermediate
transfer/charset/flowed streams as well as output and needs the full group plus a
sentinel. Strict validation retains one bounded encoded part and concatenates it
once; the consumer collects decoded chunks and concatenates once per part.

R04-B serializes raw then sanitized evidence with two 2 MiB checks. SQL's shared
complete-read validator also has 2 MiB; attachment authority shares that helper
and must retain its limit. Sanitizer and search derivation parse inert DOMs with
no explicit byte ceiling of their own; input and publication envelopes bound
them. SQL JSON parameters have no smaller application/driver size limit here;
the actual constraints are the evidence check, trigger OLD/NEW permit copies,
PostgreSQL JSON/text processing and existing two-second transaction timeout.
R05 reads committed source-matching text with no 256 KiB body ceiling. R03's
absolute ten-second operation includes preparation, transfer and publication;
it will remain unchanged unless measured large-body tests establish a need.

2026-10-15. Isolated R11 implementation on
`feature/imap-sync-r11-content-retrieval`, based on accepted R10
`bc814043978b5e600c67cd309050b62e7b5d2fcf`.

**PARTIAL overall validation: R11 execution is implemented and its 46 distinct
scenarios passed, but four existing scheduler scenarios failed in the selected
regressions. One reproduces on accepted R10; the other three did not reproduce in
the single bounded comparison and remain unclassified.**

## Request and execution lifecycle

The reader and content route retain their existing response shapes and
pending/fetching/ready/failed behavior. R02 creates or coalesces the existing
source-bound `message_contents` intent. Enrolled work still refuses the legacy
content worker. No new queue, worker, connection factory, persistent staging
area, ledger or service is introduced.

The elected coordinator discovers content only when its trusted registry contains
`"content-slice": { content: true }`. Election, account wakes and existing renewal
opportunities perform one coalesced control scan. An indexed, materialized keyset
page reads at most 32 original intents **before** eligibility joins and active
source checks. The cursor wraps after an empty page, so retained obsolete or
exhausted intents do not permanently hide later valid demand. Selection retains
only identities, one submitted intent per account per page, and a bounded
in-flight identity set. Queue acknowledgements never clear durable demand.

Each operation uses the existing R03 selector, W/C/D allocation, saved credential
binding, ten-second lifetime, preparation phase and single owned ImapFlow socket.
Original account/mailbox/message/UID/epoch/configuration are validated again under
R04 conflicting recovery locks. A matching claim commits and is recovered by its
exact UUID before client construction; post-claim credential/configuration and
lifecycle validation still precede the socket. Concurrent reader requests coalesce
in R02; account C=1 and the terminal claim predicate prevent duplicate publication.

Append-only migration `0047_receiving_content_claim.sql` provides a narrow
content-only claim/restart on that same row. Pending work gets a fresh attempt;
a crashed fetching read can restart only against its unchanged visible source,
retaining the predecessor attempt ID and a bounded read count. At most three
read admissions are allowed across an interrupted chain. Read restart can rebind
the current elected actor/lifecycle, since it authorizes only a new PEEK read.
Old epoch/configuration/path/UID bytes are never retargeted. The usual exact
OLD/NEW permit, source revision increment, lock order and deferred COMMIT checks
remain mandatory. The function is invoker-only and revoked from PUBLIC.

## MIME structure and transfer evidence

The owned client EXAMINEs the frozen path and checks raw UIDVALIDITY, selected
library UIDVALIDITY and selected path. A UID FETCH obtains BODYSTRUCTURE without
RFC822 source. A raw collector validates required MIME fields, sizes, line counts,
parameter/disposition shapes and duplicate parameters, with bounded depth/node
counts, before the installed adapter's normalized MIME tree is used.

Existing `normalizeMimeStructure` and `selectDisplayParts` retain product policy:
one plain and one HTML alternative at most; mixed/related choose the first usable
body subtree; named or attachment-disposition branches are excluded. Single-part
messages use TEXT; numeric parts use their original dot-separated identities.
Nested multipart structures and large attachment descriptors need no attachment
literal transfer. A missing display body fails safely.

Installed ImapFlow 2.0.6 `download()` supplies the existing streaming transfer,
format=flowed and charset decoders. Each request is UID-addressed BODY.PEEK with
32 KiB partial windows. BINARY is disabled on this owned content socket, even
when advertised. No full RFC822 source or attachment body is requested.

The collector observes **all** internal download FETCHes, including part-1
structure discovery and MIME headers. It correlates request tags and successful
tagged completions, rejects duplicate/wrong UIDs, sections and offsets, requires
literal buffers, and accounts for every encoded display byte. Every returned
window must be at most its requested length. EOF requires both exact declared
BODYSTRUCTURE length and a final short window (an empty final window for exact
multiples). Missing rows, incomplete literals, NO/BAD, disconnect without final
tagged OK, oversized answers and early short reads cannot produce ready evidence.

Decoded UTF-8 is accumulated only within the admitted bound. Strict checks reject
invalid UTF-8/ASCII, unsupported charsets/transfer encodings, invalid base64 or
quoted-printable and null bytes. Additional fatal TextDecoder validation checks
the original charset bytes; it does not supply the published text. The existing
ImapFlow pipeline remains the output decoder. The installed mailparser parses
only bounded MIME headers to check their type/charset against the selected
structure. Charset aliases are normalized conservatively; unsupported or
contradictory metadata fails closed.

## Exact resource limits and fairness

| Resource                                                 | Limit                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Admitted complete display group                          | 256 KiB encoded **total** and 256 KiB decoded UTF-8 **total**, or a smaller submitted `maxBytes` |
| Individual BODY.PEEK window                              | 32 KiB                                                                                           |
| MIME header literal accepted by collector                | 16 KiB per selected part, at most two parts                                                      |
| Adapter literal / complete response                      | Existing 256 KiB maximum, or smaller admitted literal bound                                      |
| Non-literal response line                                | 64 KiB                                                                                           |
| Entire socket input including protocol/structure/headers | Existing 64 KiB plus admitted `maxBytes`, at most 320 KiB                                        |
| MIME structure                                           | 128 nodes, depth at most 16                                                                      |
| Durable request page                                     | 32 rows before eligibility evaluation                                                            |
| Interrupted read admissions                              | Three per chain; explicit failed-state reader retry remains R02 behavior                         |
| Operation / SQL scope                                    | Existing ten seconds / at most two seconds and remaining lifetime                                |
| R04-B evidence JSON                                      | 2 MiB before and after sanitization; SQL retains its own 2 MiB check                             |

There is no unbounded multipart or message buffer. One selected part's retained
encoded buffers total at most 256 KiB; concatenation adds at most another
256 KiB. Strict validation temporarily creates a Latin-1 string, transfer-decoded
buffer and charset-validation string, each derived from those bounded bytes.
Streaming decoder input, intermediate output and final UTF-8 accumulation retain
the installed limiter policy. Each part's stream output is capped at 256 KiB
plus one sentinel byte, and the shared consumer stores a chunk only if aggregate
UTF-8 stays within 256 KiB. At rejection, the previous parts plus the currently
received chunk can transiently total at most 512 KiB plus one byte; that excess
chunk is not stored or published. Joined accepted decoded buffers add at most
256 KiB; retained plain/HTML together have at most 256 KiB of UTF-8. JavaScript
UTF-16 strings use at most twice their code-unit count in payload storage.
Sanitizer/search DOMs and JSON copies are bounded by these inputs and the 2 MiB
publication checks; this is not a measured or promised process-RSS ceiling.

A complete bounded display group is the scheduler unit, with internal network
windows and continuous decoding. The selector regains control after the group;
partial decoded results are never persisted between admissions. Messages exceeding
the group bound fail visibly, rather than silently truncating or repeatedly
downloading a large message. This is deliberately more conservative than the
legacy configurable per-part ceiling. R11 does not raise the accepted R03 network
budget or SQL/operation deadlines. Larger body support would require a separately
approved continuation/budget design.

Content, flags, metadata and diagnostics use the same W and account C=1, with
existing `min(W, 2D-1)` data admission and serialized control headroom. Startup
fresh-first, current/user rotation and protected history are unchanged. The
allocation lasts through actual socket and SQL retirement, including cancellation.

## Publication, safety and recovery

Only a complete group produces the normalized R04-B TEXT certificate. The owned
socket retires before `maildock_receiving_content_result`. R04-B atomically stores
decoded plain text, existing-policy sanitized HTML, derived search text, remote
blocking state and terminal attempt marker, advancing the source revision once
without moving coverage. Search text is computed from validated decoded content;
supplied provider/search metadata is not trusted.

The existing sanitizer preserves its blocked remote-image representation and
`data-maildock-cid` references for R12. Reader iframe isolation, HTML policy,
remote-content controls, reply/forward source validation and local draft/outgoing
snapshots are unchanged. R05 detail/search only expose a matching current source.
Reading content sends no STORE; R10 automatic/explicit mark-as-read remains a
separate durable flag command.

Lost claim COMMIT replies recover the exact claim under conflicting locks before
opening a socket. Lost result COMMIT replies recover the original attempt under
those same locks: matching ready/succeeded acknowledges the committed result;
only an unresolved uncommitted result at the same revision can be republished.
Remote completion alone never proves committed ready state. Stale owner,
configuration, lifecycle, epoch, attempt or revision cannot publish old bytes.

Ordinary transfer failures use the existing matching R04 failure capability after
socket retirement. Timeout/cancellation or loss before settlement can leave
fetching with no readable payload; a later admission restarts from zero against
the original source within the three-read limit. An exhausted interrupted chain
remains non-ready for diagnosis; there is no infinite retry or implicit reset.
An ordinary failed row remains eligible for the existing explicit reader retry.

## Validation

**537 distinct selected scenarios passed; four failed, across 26 files (541
distinct scenarios).** Baseline comparison results are separate from these counts.
This is not a claim of a completely green combined invocation.

| Invocation                                                        | Evidence                                                                                                                                                                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R11/R10/R03/R04 core, six files                                   | 159/159 passed: then-39 R11, 29 R10, 20 R03 admission, 17 claim phase, 18 R04-A publication, 36 R04-B cache publication                                                                                            |
| Selected regressions, 20 files                                    | 412/416 passed; all four failures are in unchanged Stage 3B scheduler tests                                                                                                                                        |
| Final compatibility selection                                     | 3/3 passed, 56 intentionally skipped: existing legacy content lifecycle, rechecked content/flags/fresh/history fairness, and an added deterministic content-plus-flag queue behind an actual owned metadata socket |
| One accepted-R10 comparison                                       | 3/4 selected scheduler cases passed, one failed, 27 unrelated cases skipped                                                                                                                                        |
| Application and worker typecheck                                  | Passed                                                                                                                                                                                                             |
| Repository lint                                                   | Passed without warnings                                                                                                                                                                                            |
| Changed supported-file Prettier; working/staged whitespace checks | Passed                                                                                                                                                                                                             |

The regression run includes the final full R11 file at 42/42, R02 intents (26),
R03 election (15), R04-C (65), R05 active reads (21), R06 bootstrap (31), R09
credentials/diagnostics (37), Stage 1 safety (26), global search (8), reader
interactions (33), unread counts (2), MIME descriptors (9), display-part selection
(6), selective provider (4), sanitizer (18), derived search text (3), and rendering
service/UI/API (24/10/5). Its 31 scheduler cases passed 27 and failed four.
The final compatibility run adds the 43rd R11 scenario and the existing core
content lifecycle; its fairness case overlaps the full R11 run. No unrelated
application-wide suite or Stage 3C Dovecot benchmark ran.

The final complete R11 invocation passed **45/45**, including all previous cases,
an aggregate alternative limit control, and a flowed-decoding completeness
control. The existing decoder's intermediate input limits must retain the full
bounded part even when decoding shrinks its bytes; limiting those stages to the
remaining aggregate output allowance can silently truncate a later flowed part.
R11 instead keeps bounded complete decoder input and checks aggregate output
before retaining each chunk. The regression retains the trailing marker of a
flowed HTML alternative after a large legacy-charset plain alternative. This last
full invocation is separate from the earlier 42-case run. The final MIME-literal
grammar extension then passed 5/5 selected cases (41 skipped): valid literal MIME
strings plus wrong-UID, malformed-structure and two missing/ambiguous-structure
controls. MIME strings may legally be literals; numeric UID/size evidence still
rejects literals. Together these runs cover 46 distinct R11 scenarios; no single
46-case full invocation is claimed.

Fixtures use disposable PostgreSQL 17.6, all actual migrations, an ordinary
schema-owning application role, independent PostgreSQL readers, installed
ImapFlow 2.0.6 and deterministic TLS peers. Protocol counters prove selective
UID PEEK and absent unintended STORE/attachment/source transfer. Barriers and
observed SQL lock waits order interruption, takeover, queued work and lost-COMMIT
recovery. The content crash-shaped cases use cancellation/owner replacement
around a retained durable claim; they do not claim a new hard-process-kill
content harness. Existing election regressions separately exercise process crash.
Reader integration uses the actual content service behind the unchanged route,
with existing API/UI regressions; no new browser-to-TLS end-to-end harness is
claimed.

### Bounded scheduler comparison

Neither `receiving-scheduler.ts` nor its test file differs from accepted R10.
Four failures occurred in the one complete scheduler invocation:

| Case                                        | Working-source failure                                                                               | One archived accepted-R10 result                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Startup barrier W=4/D=1                     | Expected no diagnostic errors at line 552                                                            | Passed, 1934 ms                                    |
| W=1 bounds/cancellation/restart             | Expected complete historical E=1, got E=257 at line 730                                              | Passed, 11480 ms                                   |
| W=1 due fresh at returning history boundary | Fixture barrier deadline at line 794; subsequent cleanup hook exceeded its existing 120-second bound | Passed, 3088 ms                                    |
| Hung account versus healthy account         | Healthy first turn 227654.3138 did not precede hung error 227602.4005 at line 1145                   | Same assertion failed: 30529.0276 versus 30437.137 |

The comparison ran those four cases **once**, sequentially after the main
regressions, from a `git archive` of exact accepted R10 with the same installed
dependencies and runtime. The known healthy-first failure reproduces; one
comparison passing does not establish the other failures as pre-existing or
resolved. There was no retry campaign, scheduler repair, relaxed assertion or
deadline increase. This unresolved regression evidence is why the overall status
is PARTIAL despite passing R11 cases.

The initial R11 development invocation was 27/29: two fixture expectations were
corrected to use the existing `data-maildock-cid` representation and to filter
global-search assertions by the tested message. The subsequent 35/35 focused run,
39-case core run, 42-case regression run, additional C=1 case, 45-case full run
and final five-case MIME-literal selection are retained as
separate evidence, not substituted for a claimed entirely green first attempt.

Commands (all Vitest runs use `--maxWorkers=1 --no-file-parallelism`):

```text
pnpm exec vitest run tests/receiving-content.integration.test.ts tests/receiving-flags.integration.test.ts tests/receiving-admission.integration.test.ts tests/receiving-claim-phase.integration.test.ts tests/receiving-publication.integration.test.ts tests/receiving-cache-publication.integration.test.ts
pnpm exec vitest run tests/receiving-content.integration.test.ts tests/receiving-election.integration.test.ts tests/receiving-cutover-boundary.integration.test.ts tests/receiving-active-reads.integration.test.ts tests/receiving-inbox-bootstrap.integration.test.ts tests/receiving-credentials-diagnostics.integration.test.ts tests/receiving-safety.integration.test.ts tests/receiving-bounded-publication.integration.test.ts tests/receiving-scheduler.integration.test.ts tests/message-content-provider.test.ts tests/display-parts.test.ts tests/sanitize-email-html.test.ts tests/search-body-text.test.ts tests/mail-interactions.test.tsx tests/mail-client-unread-count.test.tsx tests/email-rendering.test.ts tests/email-rendering-ui.test.tsx tests/email-rendering-api.test.ts tests/global-search.integration.test.ts tests/attachment-mime.test.ts
pnpm exec vitest run tests/receiving-content.integration.test.ts tests/core-platform.integration.test.ts -t "content and flags wait|content, flag commands|fetches display content asynchronously"
pnpm exec vitest run tests/receiving-content.integration.test.ts
pnpm exec vitest run tests/receiving-content.integration.test.ts -t "literal MIME|rejects uid evidence|rejects structure evidence|rejects missing or ambiguous"
node <installed-vitest>/vitest.mjs run tests/receiving-scheduler.integration.test.ts -t "targeted startup barrier W=4 D=1|W=1 bounds simultaneous|W=1 selects due fresh|backs off one hung account"
pnpm typecheck
pnpm lint
pnpm exec prettier --check <changed supported files>
git diff --check
git diff --cached --check
```

The `node <installed-vitest>` command runs in the archived R10 checkout. Docker settings are
process-local `DOCKER_HOST=npipe:////./pipe/dockerDesktopLinuxEngine` and
`TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`. Logs and JSON remain
in TEMP as `maildock-r11-core`, `maildock-r11-regressions`, `maildock-r11-final-content`,
`maildock-r11-final-compatibility`, `maildock-r11-mime-literals`, `maildock-r11-r10-comparison`, with validation
logs `maildock-r11-typecheck.log`, `maildock-r11-lint.log` and
`maildock-r11-format.log`. Earlier `maildock-r11-dev.log` and
`maildock-r11-focused.{log,json}` retain development evidence. The archived base
directory is recorded in `maildock-r11-r10-comparison-path.txt`.

## Remaining dependencies and limitations

This is isolated deterministic TLS/PostgreSQL evidence, not a real-provider or
production-cutover claim. Strict malformed-structure/charset/header checks may
reject nonconforming providers rather than accept repaired or ambiguous content.
The established arbitrary-process-suspension/socket-retirement limitation remains.
No new behavior is registered in the production worker.

R12 resolves/downloads attachments and CID resources through owned admission.
R13 owns sent-copy APPEND; R14 owns MOVE/general repair, including any future
handling of obsolete/exhausted attempts; R15 owns due settlement and membership;
R16 installs the coordinated registry/credential bindings and removes competing
legacy consumers. Secondary synchronization remains R17. SMTP, draft and outgoing
snapshot behavior is unchanged. No push, merge, PR, R12 implementation or Dovecot
benchmark is included. Stop after R11.

## R11 completion — 5 MiB display groups (2026-10-15)

This section supersedes the original size/memory table, not its historical
PARTIAL validation evidence. Work continues on the existing R11 branch.

### Final boundaries and authority

The complete selected plain/HTML group supports **5,242,880 bytes (5 MiB)** of
aggregate encoded part data and separately 5 MiB of decoded UTF-8. Attachments
are excluded from both selection and transfer. Automatic elected requests now
submit that full allowance; callers may still submit a smaller bound.

| Resource                                    | Completion limit                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| Encoded selected parts, aggregate           | 5 MiB                                                                  |
| Decoded UTF-8 plain + HTML, aggregate       | 5 MiB                                                                  |
| UID BODY.PEEK window / literal              | 32 KiB / 32 KiB                                                        |
| Selected MIME headers                       | 16 KiB each, at most two                                               |
| Complete adapter response / nonliteral line | Existing 256 KiB / 64 KiB                                              |
| Content socket input                        | Submitted maxBytes + 256 KiB protocol allowance; maximum 5.25 MiB      |
| MIME nodes / depth                          | Existing 128 / 16                                                      |
| Content publication JSON in application     | 64 MiB including escaping, sanitized HTML, derived search and metadata |
| Content publication JSONB text in SQL       | 64 MiB + 4 KiB for PostgreSQL's JSONB whitespace representation        |
| Shared attachment complete-read evidence    | Unchanged 2 MiB                                                        |
| Absolute operation lifetime                 | Unchanged 10 seconds, including preparation and publication            |
| Result SQL transaction                      | Unchanged min(2 seconds, remaining operation lifetime)                 |

The publication envelope is independent of the 5 MiB input limit. In particular,
plain text and its derived search representation already exceed 5 MiB together
at the maximum input; JSON escaping and sanitized markup need further overhead.
Pathological output exceeding the finite envelope fails; it is never truncated.

Only the content branch of admission/socket policy changes. Attachment slices
retain 256 KiB admission, and metadata, flags, topology, MOVE and APPEND keep
their budgets. W, C=1, D, control headroom, ownership and actual retirement remain
unchanged. Selective UID PEEK, original part/offset/UID/epoch validation, exact
declared length, final short/empty EOF and successful tagged completion remain
mandatory. No complete RFC822 or attachment literal is requested.

Migration 0048 replaces only the existing content-result function and adds one
fixed content-only failure outcome to the existing fenced failure function.
Source/owner/configuration/lifecycle/epoch/revision/attempt checks, exact OLD/NEW
write permits, revision advancement and deferred COMMIT validation are retained.
The shared complete-read validator receives compact content metadata, excluding
plain/sanitized/search payload fields; attachment validation still receives the
whole original evidence with its 2 MiB ceiling. Content SQL independently checks
encoded size and the normalized pre-sanitization display-byte certificate, and
rejects plaintext larger than that certificate. No new unrestricted writer or
PUBLIC function grant is introduced. Exceeding the production group limit
persists a fixed diagnostic explicitly naming the 5 MiB encoded/decoded limit,
visible through the existing reader error field.

### Transfer, retention and deadlines

One part retains at most 5 MiB encoded chunks; validation concatenates once and
releases the chunk array immediately. Unencoded input reuses that buffer instead
of creating full Latin-1 and binary copies. Base64 decodes once and validates
canonical padding with nonrecursive regexes; quoted-printable retains bounded
string/decoded representations. Fatal charset validation consumes 32 KiB views,
avoiding a second full decoded validation string. ImapFlow continues to produce
the actual charset/transfer/flowed output.

Each decoder's intermediate streams retain the full submitted allowance plus
one sentinel byte. The shared consumer retains decoded chunks only while the
aggregate stays within 5 MiB, then concatenates once per part. At rejection,
previous accepted output plus one incoming decoder chunk can transiently reach
10 MiB + one byte; that excess chunk is not stored or published. Accepted decoded
buffers and joined buffers are each bounded by 5 MiB; retained plain/HTML strings
have at most 5 MiB UTF-8 combined (UTF-16 storage depends on code units).

Publication captures immutable scalar/string references before its first await;
it no longer serializes and reparses a duplicate raw-content JSON payload.
Only the sanitized/search publication JSON is serialized for SQL. Existing DOM
sanitization/search and PostgreSQL permit/JSON copies are still substantial,
finite input-dependent costs. There is no claim of a 5 MiB RSS ceiling or a
universal DOM peak-heap bound. Tests sample buffer/heap use during real transfers,
bound sampled ArrayBuffer growth by 96 MiB including the fixture, and when GC is
exposed check retained heap growth below 128 MiB after a full collection. Peak
heap observations are reported separately from retained memory.

Deterministic TLS cases delay each slice by 2 ms and exercise the full installed
adapter and real PostgreSQL publication. The large-body measurements below
demonstrate completion within the existing lifetime, so **no content-specific or
global deadline was extended**. These are local deterministic transfer results,
not a guarantee for arbitrary provider throughput or latency. A slower transfer
still cancels and retires within existing ownership rules.

### Scheduler investigation

One bounded targeted invocation ran on exact accepted R10
`bc814043978b5e600c67cd309050b62e7b5d2fcf` in a detached comparison checkout,
and one on the current R11 working tree. Both used the same installed adapter,
Node 24.21.0, disposable PostgreSQL 17.6, deterministic TLS fixtures, unchanged
assertions/timeouts, `--maxWorkers=1 --no-file-parallelism`, and this filter:

```text
startup barrier W=4 D=1 grants|W=1 bounds simultaneous|W=1 selects due fresh
```

**R10: 3/3 passed, 28 skipped. R11: 3/3 passed, 28 skipped.** Startup asserts all
five ordered fresh opportunities precede history; cancellation/restart checks W=1,
actual socket closure, no overlap, current-first recovery and the exact committed
history frontier sequence. Returning-history checks the observed due-fresh
boundary, scheduler activity, durable source placements and publication state.
Reported five-account fresh visibility was 945.60–1811.39 ms on R10 and
893.16–1638.64 ms on R11. These are observations, not relaxed timing thresholds.

Inspection of the exact R10→R11 diff finds no scheduler/coordinator architecture
change. These three tests instantiate ReceivingScheduler directly, with metadata
accounts and no elected content registry, content intents, content scans or
content operation lifetime. R11's elected content control scan is coalesced and
returns before SQL unless its trusted content registration and connection loader
exist. The new integration is instead exercised by R11's automatic discovery and
content/flags/actual-metadata fairness tests.

**Classification: the three historical failures remain inconclusive and did not
reproduce in this bounded comparison.** Neither a concrete R11 regression nor
pre-existence of these three failures is established. No scheduler fix or negative
regression control is justified by this evidence. The separately known healthy
versus hung-account intermittent scenario was not rerun or redesigned.

### Completion validation record

Local ignored `.r11-completion-*.log` files retain all intermediate outcomes:

- Initial retained R11 suite: 46/46 passed.
- First expanded R11 + R04-B run: 103/103 passed (67 R11 + original 36 R04-B).
- First selected regression run: 166/167 passed. Its one old R03 assertion still
  expected 256 KiB content rejection. The control now rejects above 5 MiB and
  independently proves attachment rejection above the unchanged 256 KiB.
- Additional memory/reader instrumentation run: 104/107 passed. One 2 MiB HTML
  cleanup hook timed out; two new arbitrary 256 MiB transient heap assertions
  failed (458,052,080 and 299,143,792 bytes). These were not operation-deadline or
  content-publication failures. Transient DOM heap is now reported separately
  from retained memory after GC; original transfer/SQL assertions are retained.
- First GC validation invocation: 122/127 passed; five new size cases failed
  before transfer because parent `node --expose-gc` did not expose GC in Vitest
  child workers. The corrected retention invocation passes
  `--execArgv=--expose-gc` to the worker. Normal invocations retain buffer checks
  and do not require an optional diagnostic GC hook.
- Reader/provider/rendering regressions: 43/43 passed across four files.

Final verification on the completed code:

| Selection                                                                                                                          | Result                                     |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Full R11, including all original 46 scenarios                                                                                      | **67/67 passed**, one complete invocation  |
| R04-B publication, including four new SQL size controls                                                                            | **40/40 passed**                           |
| R03 admission, including unchanged attachment ceiling                                                                              | **20/20 passed**                           |
| R05 active reads, claim phase, R10 flags, R04-A publication, Stage 1 safety, MIME, display selection, sanitizer, search derivation | **147/147 passed** across nine files       |
| Selective content provider, rendering service/UI/API                                                                               | **43/43 passed** across four files         |
| Three specified scheduler cases on current R11                                                                                     | **3/3 passed**, 28 unrelated cases skipped |
| Same scheduler cases on exact accepted R10                                                                                         | **3/3 passed**, separate baseline evidence |

The selected completed-code coverage is **320 distinct passing scenarios**:
67 R11 plus 250 publication/admission/reader/regression scenarios plus the three
specified scheduler scenarios. Baseline and intermediate reruns are not added
to that count. R04-B/R03 passed together in the 127-case invocation whose five
GC-runner setup failures are recorded above; the final complete 67-case R11
invocation separately supersedes those five setup failures. This is not a claim
that every intermediate combined invocation passed.

Observed complete admitted operation timings (including SQL publication):

| Display input             | Display + MIME-header literal bytes fetched | UID FETCH commands | Operation time |
| ------------------------- | ------------------------------------------- | ------------------ | -------------- |
| 300 KiB plain             | 307,276                                     | 12                 | 1,047.60 ms    |
| 2 MiB HTML                | 2,097,227                                   | 67                 | 3,107.85 ms    |
| Nested 4.5 MiB plain/HTML | 4,718,743                                   | 147                | 4,445.47 ms    |
| Exact 5 MiB plain         | 5,242,956                                   | 163                | 4,160.36 ms    |
| Exact 5 MiB plain/HTML    | 5,243,031                                   | 163                | 4,763.21 ms    |

All five include a 50,000,000-byte attachment descriptor in a mixed MIME tree;
the peer rejects unknown requested sections. Protocol assertions prove only
selected display sections and their MIME headers were fetched, all partial
requests use 32 KiB, and no attachment body, RFC822 source, BINARY PEEK or STORE
was requested. The 2.5 MiB HTML alternative was actually sanitized/published,
and both exact 5 MiB bodies were actually fetched and committed, not simulated
by a payload-size counter. Automatic discovery separately publishes a 3 MiB
plain body without a caller maxBytes override. R05 reader/search checks reject
visibility before publication and expose the body token after committed ready.

For those five transfers, largest sampled ArrayBuffer growth was 26,098,238 bytes;
largest sampled transient heap growth was 372,430,688 bytes. With GC explicitly
exposed to the workers, maximum retained heap growth after collection was
463,296 bytes. These include fixture/application allocations and are sampled
diagnostics, not a process-wide maximum RSS claim. All retention assertions
passed. The previously timed-out HTML cleanup did not reproduce in the bounded
final full run; explicit coordinator/peer cleanup start/completion traces all
completed. Its cause remains inconclusive; no production fix or timeout change
is claimed for that intermediate hook failure.

Final commands use `node node_modules/vitest/vitest.mjs run <selection>
--maxWorkers=1 --no-file-parallelism`; the final R11 invocation additionally uses
`--execArgv=--expose-gc --reporter=verbose`. Complete local evidence is retained in
`.r11-completion-content-retention.log`, `.r11-completion-verified.log`,
`.r11-completion-final-regressions.log`, `.r11-completion-reader.log`,
`.r11-scheduler-r10-comparison.log` and `.r11-scheduler-current-comparison.log`.
The temporary detached R10 comparison checkout was removed after comparison.

**Completion implementation: PASS. Overall historical validation: PARTIAL.**
The required 5 MiB behavior and final selected checks pass. The three historical
scheduler failures and one intermediate fixture-cleanup timeout remain
unclassified despite the bounded passing comparisons/verification. The known
healthy-versus-hung timing issue remains outside this completion. No confirmed
implementation blocker was found. Real-provider/production activation and the
previously documented process-suspension limits remain outside R11.

Application and worker typecheck (`pnpm typecheck`), repository lint
(`pnpm lint`), changed supported-file Prettier and `git diff --check` all
**passed** after the final code changes. SQL follows the existing migration
style and is verified by the actual migrated PostgreSQL tests; no SQL Prettier
plugin is configured.
No Dovecot benchmark, unrelated application-wide suite, push, merge, PR or R12
work was performed.
