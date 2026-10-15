# R11 — On-demand message content retrieval

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
