# R04 completion — Fenced cache and bounded publication authority

2026-10-14. **R04-B PASS; R04-C PASS; overall R04 PASS for the requested
publication/authority and deterministic-fixture scope.** R05 may proceed.
This accepts SQL capabilities, not production receiving execution or cutover.

Base: `fad8d5903c1dc9687fc65516ed519e3f2b546aa6`.
Branch: `feature/imap-sync-r04-fenced-publication`.

Checkpoint commits:

- R04-B: `59e5f4a9d9f4b05850c0f28ef4ab649391df7361`.
- R04-C and final cache hardening: `8d27a694007c5619a755cf326c1d931a23f8e129`.
- Final C recovery-scope control: `bbf1db97c094678ec49f67d54d2480dc2139616b`.

The final documentation commit is reported separately in the task response.
[R04_RESULTS.md](R04_RESULTS.md) retains the historical BLOCKED result;
[phase unblock](R04_PHASE_UNBLOCK_RESULTS.md) retains its accepted lifecycle
implementation and historical validation, including the Stage 3B failures.

## R04-B acceptance

Append-only migration `0040_receiving_cache_publication.sql` supplies
`maildock_receiving_content_result` and
`maildock_receiving_attachment_result`. Both operate on one existing claimed
business row through the original revocable receiving executor. They validate
actor/generation, exact attempt UUID/kind/phase, fetching status, source account,
mailbox/path, epoch, UID, configuration, captured account lifecycle and current
revision. The original matching failure capability is retained.

Completed evidence requires BODY.PEEK, original part identity, origin zero,
nonnegative encoded length, proven EOF, successful tagged completion, completed
stream and successful decoding. These are normalized completed-evidence
certificates; wire transfer, MIME interpretation and continuous slice decoding
remain R11/R12 work. False, malformed or mismatched certificates cannot publish
ready data.

Content publication atomically writes ready status, decoded plain text,
sanitized HTML, search text, current HTML policy, remote-content blocking state,
fetch/update times and the terminal attempt marker. The application capability
uses the existing sanitizer and computes search text from the completed body;
it does not trust a supplied search-body value. Sanitizer/search modules load only
on this content path, outside SQL. Completed evidence is conservatively bounded
to 2 MiB; both null display payloads are rejected, while an evidenced empty text
part remains possible.

Attachment publication verifies the existing immutable storage object outside
SQL: existence, complete read, exact size and SHA-256, and a final existence
check. It retains the current UUID storage-key convention and 15 MiB attachment
ceiling. SQL validates the original part/source and normalized finalized evidence,
registers the blob, checks registry identity/size/digest, links ready status and
blob ID, and fills existing incoming draft references with null blob IDs in the
same transaction. Other local references are preserved. A failed transaction
leaves an unlinked physical object under the existing conservative cleanup
convention; it does not delete shared local snapshots or introduce a new blob
platform. Local staged uploads remain ordinary local business writes.

Each successful settlement advances the source revision once, with F/E/R,
configuration and epoch unchanged. Failure cannot replace ready data, a newer
attempt or a canceled/stale operation. The new publication entry points cap SQL
admission/execution by the earlier operation deadline and two seconds.

### Shared derived search exception

The existing search-body trigger receives an exact temporary OLD/NEW certificate
for the one source-bound content row. It may change only `messages.search_body`;
the existing generated vector follows automatically. The certificate checks
every other message field and is cleared after use. It also checks the current
active source before the trigger update. Other enrolled placements of that same
message need no revision change for this approved derived-only effect.

Envelope, MIME, account identity, timestamps, placements and canonical flags
cannot be changed using that exception. Subsequent mixed writes fail and roll
back the entire publication. The conversation trigger still fires only for its
original identity/header columns; conversation membership and notification
behavior are preserved.

Final B fixture acceptance: **36/36 passing cases**. Controls include complete
sanitized/search publication with a second enrolled placement, malformed/incomplete
evidence, wrong epoch/UID/part/origin, stale revision/configuration/lifecycle/actor/
attempt, an old failure against a newer ready result, forbidden message-field
writes, missing/truncated/digest-mismatched blobs, cancellation during verification,
atomic incoming draft references and independent local uploads. A canceled callback
with a prepared DELETE cannot touch the replacement's 32 placements. Content and
attachment each have separate before-L rollback and post-L conflicting-lock
controls, including registry rollback for attachment failure.

## R04-C acceptance

Migration `0041_receiving_bounded_publication.sql` adds one nullable
`outgoing_messages.receiving_attempt` marker and explicit bounded functions.
There is no new receiving ledger, SECURITY DEFINER writer, public execution grant,
remote operation implementation or worker registration. Schema snapshots 0040/0041
preserve the existing schema, adding only the outgoing marker at 0041.

| SQL capability                               | Authority and result                                                                                                                                                                                                                                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maildock_receiving_move_claim/result`       | Two distinct same-account enrolled scopes, exact existing archive/trash command, frozen source/destination and role mapping, actor/attempt/configuration/lifecycle identity. Known destination UID/epoch and evidenced destination flags/MODSEQ publish placement, source removal and command result atomically. |
| `maildock_receiving_append_claim/result`     | One enrolled destination and existing sent-copy intent. Freeze account, path, epoch, actor/attempt/lifecycle, RFC message ID and immutable MIME ID/hash. Known UID publication links validated existing metadata and settles sent-copy state; it does not create or refresh envelope/MIME facts.                 |
| `maildock_receiving_data_failure`            | Exact current MOVE/APPEND attempt only; pre-execution failure or remote uncertainty, with no canonical rollback. Uncertainty records repair demand using existing mailbox/business rows.                                                                                                                         |
| `maildock_receiving_data_recover`            | Conflicting locked recovery of all original operation scopes and the original business row. MOVE requires both original scopes; APPEND requires its actual destination. A wrong or incomplete scope cannot establish recovery.                                                                                   |
| `maildock_receiving_topology_capture/result` | Separate complete account-topology identity/evidence boundary; bounded metadata/missing/role publication, with no message, placement, content, attachment or receiving-state deletion authority.                                                                                                                 |
| `maildock_receiving_terminal_remove/recover` | Authenticated lifecycle composition capability for complete physical removal, including workers-stopped operation and conflicting recovery of removal outcome. No live receiving lease is required for removal.                                                                                                  |

The new typed API is `ReceivingBoundedPublication`. Evidence and authority values
are copied before SQL admission. Existing Stage 1–R04-A default guard bodies are
preserved exactly behind the new bounded branches; a textual comparison verified
all four default write/command/revision/COMMIT bodies. A bounded operation also
cannot acquire a third scope through the old single-mailbox claim/recovery path.
New helper functions use exact row certificates and default-deny mixed writes;
they do not expose an application callback with arbitrary writer authority.

### Transactions, revisions and uncertainty

Lock order is coordinator SHARE, the existing account discovery/role advisory
mutex, account SHARE (data) or UPDATE (topology/removal), mailbox UUID order UPDATE,
receiving-state UUID order UPDATE, then business/role/reference rows. The mutex
uses the existing `mailbox-discovery:<account>` convention and serializes actual
manual-role service changes. Data scope accepts at most two unique enrolled
mailboxes. Reversed input order produces the same ordered captured scopes.

Claims and settlements are separate bounded transactions. Every affected enrolled
scope advances revision exactly once per successful transaction. All other state
fields, including F/E/R, epoch and configuration binding, remain unchanged.
Mandatory deferred checks cover the full scope and current account/actor identity;
their final DB-clock lease comparison remains logical point L, with conflicting
locks held through completion (D15 Variant A). Existing single-scope semantics
remain the fallback.

Missing destination UID never manufactures a placement: MOVE records failed with
`uncertain_remote_execution` and repair demand for both folders; APPEND records
uncertain and destination demand. A known APPEND UID without metadata records
saved plus `sent_copy_sync_pending`, retaining due work. Only a matching completed
targeted lookup can link metadata and clear that flag. It cannot replace the
saved UID/epoch, fail a newer saved result or overwrite a conflicting placement.
A matching already-published lookup placement is preserved. Ordinary writes
cannot erase claimed/saved sent-copy facts by resetting them to pending.

Historical source-command references retain SET NULL behavior through exact
certificates, without allowing arbitrary command mutation. This ancillary MOVE
reference scope is conservatively limited to 128 rows; a conflicting active
command or overflow fails the transaction.

Actual lost-COMMIT-response fixtures demonstrate recovery of committed MOVE and
complete account removal using conflicting locks. An unresolved observation is
not permission to resend. Takeover adoption and remote reconciliation remain
business execution work for later stages.

### Complete topology

The union of captured existing and observed identities must be at most **128**;
normalized evidence must be at most **2 MiB**. Coverage is the complete namespace,
not subscribed-only, with successful correlated request/completion UUIDs and
unique normalized paths/identities. Captured mailbox/state identities and complete
manual mapping rows must still match. Bigint snapshot values use strings to avoid
JSON number precision loss. Demand hints are excluded from identity comparison
and preserved by publication.

Unseen mailboxes can become missing only with complete evidence. New identities
remain unenrolled, with no invented selected epoch. Existing epoch, cursor/cache
facts and placements are preserved. Path changes require existing stable provider
identity; a path-only identity cannot be silently renamed. Manual mappings win;
autodetection requires one unambiguous special-use candidate. Missing/nonselectable
evidenced results are permitted by this capability's deferred lifecycle check,
without weakening ordinary data publication guards.

### Terminal physical removal

Removal locks the coordinator, account and entire mailbox/receiving-state set,
validates exact configuration/lifecycle identity and refuses retained drafts or
outgoing rows. Existing native RESTRICT dependencies remain unchanged. It removes
business/cache/placement facts, receiving state, folders and account together.
Deferred terminal checks require the complete account identity to be absent;
recreating it in the same transaction is rejected. Standalone receiving-state
DELETE/reset remains forbidden, and old callbacks/initialization cannot recreate
the removed identity. Blob registry/storage objects are retained for existing
reference-aware cleanup and local snapshots.

Conservative removal limits are 128 folders, 4096 remote/associated fact rows and
2 MiB of PostgreSQL row footprint, in addition to the executor's two-second limit.
Terminal L also compares an explicit two-second DB-clock transaction deadline,
without requiring an elected owner. Overflow, lock timeout, stale identity,
retained dependencies or expiry before L fail atomically. This is intentionally
not an unrestricted deletion bypass or a claim that large accounts can be removed
within that budget. R08 must surface these refusals; no deletion orchestration was
implemented here.

Final C acceptance: **65 cases have passing evidence**: 64 in the final B/C file
run, plus the final recovery-scope case in a six-case affected run. Controls cover
opposite-order claims, source/destination rollback, actual cross-account and third-
scope rejection, stale state/path/role/attempt, destination UID uncertainty,
conflicting placements, duplicate flags, APPEND metadata due/lookup settlement,
mixed canonical writes, a 32-placement canceled callback, complete topology at
the 128-identity boundary, partial/missing/oversized/overflow/duplicate/late-
malformed topology, manual replacement, whole-account deletion/RESTRICT/timeout/
resurrection/budget checks, lost replies and before/after-L controls for MOVE,
APPEND, topology and removal.

## Validation evidence and bounded comparisons

Fixtures use disposable PostgreSQL **17.6**, an ordinary non-superuser schema
owner, all actual migrations and independent postgres.js readers. Concurrency
faults use explicit gates, advisory locks, observed PostgreSQL waits or DB-clock
expiry barriers, not arbitrary fault sleeps. No old assertion or deadline was
relaxed.

| Run                                                         | Result                                                                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| B validated before starting C                               | 31/31; four existing regression files also passed 87/87.                                                            |
| Final selected nine-file receiving run                      | **222/222 passed**: B/C, R04-A, phase unblock, Stage 1 safety, R02 boundary, R03 admission/election and retirement. |
| Final B/C focused run after fixture/evidence hardening      | **100/100 passed** (36 B, 64 C).                                                                                    |
| Final ordinary sent-copy reset control                      | 1 passed, 63 skipped.                                                                                               |
| Final recovery-scope affected run                           | **6/6 passed**, 59 skipped; includes the additional C recovery-scope case, reply loss and canceled callback.        |
| Application/worker typecheck; repository lint               | Passed.                                                                                                             |
| Changed supported-file Prettier; working/staged diff checks | Passed; no SQL formatter is configured.                                                                             |

There are **225 distinct selected cases with passing evidence in nine files**,
not 225 cases in one run. A development nine-file run had **215 passed / 4 failed
out of 219**: three new APPEND controls exposed an ambiguous SQL UID reference,
which was corrected, and the existing election missing/duplicate-wake case did
not reach its unchanged ten-second fresh barrier. Exactly one bounded isolated
comparison of that election case ran on base `fad8d59` and once on the final
working code, with the same installed dependencies: **1/1 passed on each**.
The final full election file then passed in the 222-case run. The earlier failure
remains evidence; this is not a claim of general scheduler timing stability.

Earlier development also corrected JSONB operator grouping, SQL record/column
ambiguity, fixture JSON parameter encoding and a test that tried to issue
`SET CONSTRAINTS` through the executor. The executor correctly rejected that
transaction-control statement; the test now uses an actual post-L deferred
trigger barrier. Those development failures are not acceptance results.

The historical Stage 3B failures and bounded comparison in the phase-unblock report
remain unchanged. Stage 3B was not rerun or declared resolved. There was no deadline
increase, open-ended retry campaign, Dovecot benchmark or unrelated application-wide
suite.

Commands:

```text
pnpm exec vitest run tests/receiving-cache-publication.integration.test.ts tests/receiving-bounded-publication.integration.test.ts tests/receiving-publication.integration.test.ts tests/receiving-claim-phase.integration.test.ts tests/receiving-safety.integration.test.ts tests/receiving-cutover-boundary.integration.test.ts tests/receiving-admission.integration.test.ts tests/receiving-election.integration.test.ts tests/receiving-retirement-gate.integration.test.ts --maxWorkers=1 --no-file-parallelism
pnpm exec vitest run tests/receiving-cache-publication.integration.test.ts tests/receiving-bounded-publication.integration.test.ts --maxWorkers=1 --no-file-parallelism
node node_modules/vitest/vitest.mjs run tests/receiving-election.integration.test.ts -t 'missing and duplicate wakes preserve due' --maxWorkers=1 --no-file-parallelism
pnpm exec vitest run tests/receiving-bounded-publication.integration.test.ts -t 'recovery|lost COMMIT reply|32-row MOVE|APPEND publishes known destination' --maxWorkers=1 --no-file-parallelism
pnpm typecheck
pnpm lint
pnpm exec prettier --check <changed supported files>
git diff --check
git diff --cached --check
```

Docker settings were process-local:
`DOCKER_HOST=npipe:////.\pipe\dockerDesktopLinuxEngine` and
`TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`.
Logs remain in TEMP: `maildock-r04-completion-final.log`,
`maildock-r04-completion-final-focused.log`,
`maildock-r04-final-sentcopy-guard.log`, `maildock-r04-final-recovery-guard.log`,
`maildock-r04-completion-election-baseline.log`,
`maildock-r04-completion-election-comparison.log`,
`maildock-r04-completion-validation.log`,
`maildock-r04-completion-typecheck.log` and `maildock-r04-completion-lint.log`.
The bounded base archive is preserved at
`TEMP/maildock-r04-completion-baseline-c11b61884fc6406a8578581dbc658fa8`;
no dependencies were installed or changed for the comparison.

## Readiness and remaining execution work

**R05 is ready to start against these accepted authority capabilities.** It must
still enforce active placement/cache provenance on public reads, effective search
vectors, conversations, downloads and compose references. This task does not
claim those read paths are fixed.

The new SQL APIs remain unregistered as receiving producers. Later consumers must
bind them to the existing admitted preparation and retired-result phases on the
same revocable executor; they may not introduce a parallel executor, revive a
retired client or bypass W/C/D. The accepted R04-A and phase-unblock implementation
and its mandatory COMMIT semantics were preserved. MIME transfer/decoding,
production downloads, MOVE/APPEND/LIST execution, takeover reconciliation,
authenticated removal orchestration and worker cutover remain their named later
stages. No push, merge, PR or R05 implementation was performed.

**Stopped after R04 completion.**
