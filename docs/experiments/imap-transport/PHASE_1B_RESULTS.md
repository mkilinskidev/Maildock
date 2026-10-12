# IMAP transport hardening — Phase 1B

Date: 2026-10-12 (Europe/Warsaw). Branch: `experiment/imap-transport-hardening`. Base/verified HEAD before work: `3b0745726fa107e7d26567267937440a5de31b25`, from `experiment/imap-transport-validation`. Working tree was clean; remote refs were fetched. No branch was overwritten. The original Phase 1 reports, measurements, scenarios and architecture documents remain unchanged. The shared fixture adds only an optional `OK` greeting for an actual synthetic LOGIN failure; PREAUTH remains its default.

**Recommendation: BLOCKED — TRANSPORT ADAPTATION REQUIRED.** The experiment establishes conservative evidence validation and destruction under a responsive event loop. It does not establish the architecture's strict K-identity parser allocation bound. A parsed-response observer stops SEARCH collection, but it runs after the complete response's tokens have been allocated. A precise minimal hook is specified in [PHASE_1B_DECISIONS.md](PHASE_1B_DECISIONS.md). No new dependency patch was made; the repository's existing conditional STORE patch is unchanged.

## Environment and evidence

Actual installed dependency: ImapFlow **2.0.6**, Node **24.21.0**, pnpm **12.7.0**, tsx **4.23.15**, TypeScript **6.0.3**, ESLint **9.39.5**, Prettier **3.9.9**. Host: Windows `win32/x64`, Intel Core Ultra 7 155H, 22 logical CPUs, 33,777,467,392 bytes RAM. The real ESM export, `node_modules/imapflow/dist/esm/imap-flow.js`, is used; installed-source hashes are in [phase-1b-measurements.json](../../../experiments/imap-transport/phase-1b-measurements.json). Shared source hashes match Phase 1. The existing patch does not implement these hardening features.

The peer is the existing loopback TLS server on 127.0.0.1, an ephemeral port, with the existing disposable self-signed certificate. No real accounts, passwords, databases, mail content or remote providers were used. The LOGIN scenario uses synthetic credentials and a server-side rejection. Connection refusal uses a just-closed local ephemeral listening port. Compression, STARTTLS and auto-IDLE are outside this profile. No antivirus settings were changed.

Profile: K=128; maximum line/response 300 KiB; maximum literal 256 KiB; aggregate decrypted input 2 MiB, with smaller budgets for overshoot experiments. New command deadlines are 100/180 ms, with 40 ms for starvation and 500 ms for the deliberately staggered successful SEARCH. Phase 1 regression retains its actual 10-second trickle trial. Short deadlines accelerate fault tests; they do not revise the architecture's proposed production values.

Each scenario runs the installed client in a separate child, with a 6-second parent containment timeout and an 8-second test timeout. Parent kill is a failed experiment, never successful cancellation. No ImapFlow public method is mocked. The adapter wraps only the internal `getUntaggedHandler` lookup, observes the retained native socket with a prepended data listener, and receives warn/error logger entries plus client error events. Parser, compiler, socket pipeline and command methods remain the installed implementations.

## Reproduction and validation

The complete executed validation commands, baseline-preserving regression procedure and retained development failures are in [PHASE_1B_COMMANDS.md](PHASE_1B_COMMANDS.md).

```powershell
$env:IMAP_HARDENING_REPEATS = '3'
node --import tsx --test --test-concurrency=1 experiments/imap-transport/hardening.test.ts
Remove-Item Env:IMAP_HARDENING_REPEATS
node --import tsx experiments/imap-transport/hardening-summary.ts
```

For an independently reproducible case, use `node --import tsx experiments/imap-transport/hardening-scenario.ts search-parsed-overshoot`. All case names are in `hardening-cases.ts`. Running the summary updates only this report's marked Phase 1B table. Do not run Phase 1's summary over the new regression measurements; it would rewrite the historical report.

Final Phase 1B suite: **46 scenarios × 3 trials = 138 assertions passed**. Of these, six are explicitly labeled unsafe reproductions: three unadapted wrong-origin trials and three parser-token overshoot trials. The other 132 assertions demonstrate the specified accepted evidence or conservative rejection, within this profile. The passed overshoot assertion establishes a **failed strict safety gate**, not a safe K-allocation bound. Independent Phase 1 regression: **43/43 assertions**, retained separately in [phase-1b-regression-measurements.json](../../../experiments/imap-transport/phase-1b-regression-measurements.json). Its original committed three-trial measurement file is preserved byte-for-byte.

Relevant standalone strict TypeScript check and repository `pnpm typecheck`: PASS. Repository `pnpm lint` and experiment ESLint: PASS. Existing IMAP lifecycle/conditional STORE/download charset tests: **47/47** across three Vitest files. Formatting of all changed sources/reports/new measurement artifacts: PASS. Repository-wide formatting: FAIL on the three unchanged baseline files `SYNC_ENGINE_ARCHITECTURE.md`, `SYNC_ENGINE_VALIDATION.md`, `plaintext-interference.json`; checks against the base commit also fail. Those protected historical files were left unchanged. This formatting failure is independent of transport safety.

## H1–H5 matrix

PASS means the stated property was demonstrated for this profile. FAIL means a counterexample remains. UNCERTAIN means correlation or portability still depends on an explicit trust boundary. Assertions matching unsafe behavior do not upgrade a safety assessment.

| Requirement                                                          | Outcome                                                                       | Demonstrated property and remaining boundary                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1: aggregate SEARCH byte/identity limits before unsafe accumulation | **FAIL for strict parser K; PASS for bounded collection/input profile**       | Dense 128, sparse three, multiple replies and trickle tested. Observer rejects out-of-range identities, a 129th identity, and excess input before another chunk is admitted to the parser. But one admitted line already produces 16,384 tokens before the identity hook. A token-creation budget is required for strict K.                                                                                                                             |
| H2: complete bounded metadata FETCH evidence                         | **PASS, experimental profile**                                                | Exact distinct UID set ≤128; iterator exhausts to command completion; headers, flags, size and body structure required. Missing, duplicate, unexpected, excessive-depth, malformed, oversized, aggregate-budget and epoch-invalid results are unresolved. Missing identities require recheck and never imply deletion or coverage.                                                                                                                      |
| H3: verified partial origin and assembly                             | **PASS with internal observation; FAIL using public result alone**            | Parsed section, partial origin, UID, count and expected length checked before formatter loses origin. Correct slices accepted; wrong origin, over/short result, extra part and disconnect rejected. Continuous Base64/QP decoders reconstruct exact source. Interrupted part discarded and restarted at zero on a fresh client.                                                                                                                         |
| H4: absolute deadline/cancellation                                   | **PASS under responsive event loop; UNCERTAIN as unconditional wall clock**   | Single monotonic deadline covers preparation, commands and cleanup; timeout invalidates token, closes real transport, awaits work settlement/native close and rejects late callback. SEARCH/FETCH/DONE/trickle and malformed parsing terminate. A 140 ms CPU block delays a 40 ms deadline; arbitrary application cleanup is not made cancellable by closing IMAP.                                                                                      |
| H5: scheduler-useful classifications                                 | **UNCERTAIN for complete command correlation; PASS for fail-closed evidence** | Actual LOGIN failure, ECONNREFUSED, ETIMEOUT, parser depth/size/syntax, deadline, explicit cancellation, incomplete results, epoch mismatch and uncertain STORE tested. Parser diagnostics carry the active request tag in this profile. Tagged NO or disconnect diagnostics can arrive after `currentRequest` is cleared; these become unresolved with underlying diagnostic category retained. Logs/events are not a stable public command-error API. |

## Exact coverage

| Cases                                                                                                             | Evidence / assertion                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search-dense`, `search-sparse`, `search-multiple`                                                                | Numeric intervals and tagged completion; 128 dense identities, three sparse hits across width one billion, 128 separately emitted SEARCH responses.                                                                           |
| `search-range`, `search-invalid-number`, `search-identity-budget`                                                 | Reject UID 129 outside `[1,128]` and non-decimal `1e2`; wider interval rejects the 129th identity before original SEARCH handler retains it.                                                                                  |
| `search-large`, `search-wire-budget`, `search-parsed-overshoot`                                                   | Large single line hits 1 KiB line cap; 1 KiB aggregate wire budget rejects first 16 KiB chunk; separately allow 87,208 bytes to demonstrate 16,384 parsed tokens with only 128 retained identities.                           |
| `search-esearch-rejected`                                                                                         | Compact `ALL 1:4294967295` is rejected before original handler expands it. ESEARCH support is explicitly unresolved, not silently processed under a legacy budget.                                                            |
| `search-trickle-budget`, `search-trickle-deadline`                                                                | Repeated untagged OKs independently exhaust byte/time budget. Neither delivers completed SEARCH evidence.                                                                                                                     |
| `metadata-complete`, `metadata-missing`, `metadata-duplicate`, `metadata-unexpected`                              | Three requested UIDs; only exact complete evidence accepted. No omitted UID becomes absent.                                                                                                                                   |
| `metadata-depth`, `metadata-malformed`, `metadata-lenient-syntax`, `metadata-literal-limit`, `metadata-aggregate` | Depth log, actual parser syntax error, leniently parsed unusable metadata, literal announcement over 256 KiB, sixteen 160 KiB headers exceeding aggregate 2 MiB.                                                              |
| `metadata-epoch`, `metadata-external-epoch`, `metadata-tagged-no`, `metadata-stall`                               | Before-command wrong expected UIDVALIDITY, failed external publication validation after complete rows, NO, and no FETCH response. External callback models validation; no durable epoch transaction is proved.                |
| `slice-correct`, `slice-wrong-origin`, `slice-oversized`, `slice-truncated`, `slice-extra`, `slice-disconnect`    | Check actual protocol partial atom independently of byte count. Truncated expected part stays incomplete. Extra part rejected. Disconnect during declared literal remains unresolved.                                         |
| `slice-base64`, `slice-qp`, `slice-restart`, `raw-wrong-origin`                                                   | Seven-byte advancing requests with one decoder; interruption discards raw/decoded buffers and decoder, then restarts from zero. Unadapted `fetchOne` still accepts origin 99 for origin 0 with correct returned length seven. |
| `deadline-search`, `deadline-done`, `deadline-preparation`, `deadline-cleanup`, `deadline-starvation`             | No completion; hung real DONE prevents NOOP reaching wire; preparation consumes remaining time; delayed cleanup prevents publication even after SEARCH success; CPU block proves timer qualification.                         |
| `cancel-fetch`, `late-callback`, `socket-timeout`, `mutation-ambiguous`                                           | Explicit abort; delayed application callback calls invalid old guard; native ETIMEOUT remains distinct from deadline; actually received STORE without completion yields ambiguous outcome and no automatic replay.            |
| `authentication`, `connection-refused`                                                                            | Actual synthetic LOGIN rejection / real local TCP refusal. Not OAuth or provider authentication interoperability.                                                                                                             |

## Measurements and allocation interpretation

Trial 1 examples, with all min/max ranges below:

- SEARCH byte cap 1,024: TLS already delivered a 16,384-byte chunk, zero bytes admitted from it. Received overshoot **15,360 bytes**. This is current-chunk allocation, not proof TLS/kernel queues have the same bound.
- Metadata aggregate cap 2,097,152: received **2,097,276**, admitted **2,080,892**, rejected chunk **16,384**; received overshoot **124 bytes**. Parser snapshot at rejection retains partially assembled input; raw JSON records its line/response/literal counters. Closing synchronously destroys the parser before that rejected chunk can be processed by its existing pipe listener in this source/profile.
- SEARCH parser overshoot: received **87,208 bytes**, **16,384** parsed tokens, **128** retained identities; sampled startup heap increase **9,824,032 bytes**, duration **37.46 ms**. The increase includes setup/peer/telemetry and is not attributable solely to parser tokens. It decisively refutes an at-most-K token allocation claim; count is read from the real parsed object.
- Deadline starvation: configured **40 ms**, deliberate block **140 ms**, native socket close at **144.64 ms**. Responsive timers cannot interrupt synchronous JavaScript.
- Cleanup: configured **100 ms**, native close at **112.84 ms**, application work settlement **155.54 ms**, final unresolved return **155.59 ms**. The executor does not abandon cleanup with Promise.race. Future DB/application cancellation must provide its own remaining-time contract; transport destruction cannot force arbitrary JavaScript promises to settle.
- Parser cause evidence: `MAX_IMAP_NESTING_REACHED`, `LiteralTooLarge`, `LineTooLarge`, `ParserError21` are preserved alongside the derivative `NoConnection`. In depth/syntax cases the collector records active tag `5`, command `UID FETCH`. Socket timeout is recorded from `error` as `ETIMEOUT`; logger-only collection would miss it.

`received` counts decrypted socket event bytes during the scope, including rejected current chunk; `accepted` counts chunks observed below the aggregate cap, not retained heap or exact parser consumption. No TLS record overhead is included. `maxChunk` is measured, not assumed to be universal. Parser response bytes include declared literal sizes and may exceed currently received literal bytes. Full rows/tokens/literals can allocate copies and objects. Socket buffers, TLS, Node allocator/GC and the scripted peer are outside a strict logical byte cap.

<!-- phase1b:start -->

Run 2026-10-12T09:21:27.780Z through 2026-10-12T09:22:56.618Z (UTC). Assertions: 138/138. Independently labeled unsafe reproductions: 6. These counts are not safety-gate counts.

Per-operation values across three trials; content assembly rows include each separate slice and its interrupted attempt. Memory includes client, peer, decoder and telemetry, measured from process startup every 2 ms. A short transient peak can be missed.

| Scenario                | Final classification | Duration ms   | Received / admitted bytes         | Largest TLS chunk bytes | Sampled RSS MiB | Startup Δheap MiB |
| ----------------------- | -------------------- | ------------- | --------------------------------- | ----------------------- | --------------- | ----------------- |
| search-dense            | justified            | 18.33–29.24   | 430–430 / 430–430                 | 414–414                 | 77.75–93.29     | 0.50–0.76         |
| search-sparse           | justified            | 22.62–32.53   | 46–46 / 46–46                     | 30–30                   | 77.16–77.45     | 0.50–0.50         |
| search-range            | malformed            | 3.61–4.63     | 418–418 / 418–418                 | 418–418                 | 77.74–78.13     | 0.50–0.52         |
| search-invalid-number   | malformed            | 2.86–4.39     | 14–14 / 14–14                     | 14–14                   | 77.51–77.71     | 0.50–0.52         |
| search-multiple         | justified            | 152.30–156.53 | 1700–1700 / 1700–1700             | 182–192                 | 77.53–78.04     | 0.50–0.57         |
| search-large            | parser-limit         | 5.89–9.51     | 16384–16384 / 16384–16384         | 16384–16384             | 77.58–78.29     | 0.50–0.51         |
| search-wire-budget      | budget               | 4.18–7.31     | 16384–16384 / 0–0                 | 16384–16384             | 77.98–78.17     | 0.50–0.51         |
| search-parsed-overshoot | budget               | 37.46–45.53   | 87208–87208 / 87208–87208         | 16384–16384             | 101.86–103.65   | 8.81–9.74         |
| search-esearch-rejected | unresolved           | 3.32–5.03     | 32–32 / 32–32                     | 32–32                   | 77.20–77.37     | 0.50–1.03         |
| search-trickle-budget   | budget               | 55.16–58.96   | 92–92 / 69–69                     | 23–23                   | 77.13–77.89     | 0.50–0.52         |
| search-trickle-deadline | deadline             | 184.70–189.36 | 276–276 / 276–276                 | 23–23                   | 77.43–77.84     | 0.50–0.50         |
| search-identity-budget  | budget               | 132.85–139.64 | 1698–1698 / 1698–1698             | 182–202                 | 77.48–77.91     | 0.99–1.49         |
| metadata-complete       | justified            | 19.57–29.39   | 451–451 / 451–451                 | 315–315                 | 77.13–77.62     | 0.50–0.51         |
| metadata-missing        | incomplete           | 20.11–29.62   | 306–306 / 306–306                 | 170–170                 | 77.22–77.75     | 0.50–0.51         |
| metadata-duplicate      | incomplete           | 4.85–5.65     | 435–435 / 435–435                 | 315–315                 | 77.56–77.82     | 0.50–0.86         |
| metadata-unexpected     | incomplete           | 4.79–4.97     | 436–436 / 436–436                 | 316–316                 | 77.82–78.17     | 0.50–0.96         |
| metadata-depth          | parser-limit         | 4.88–5.88     | 735–735 / 735–735                 | 615–615                 | 77.33–77.62     | 0.50–0.51         |
| metadata-malformed      | malformed            | 3.34–4.43     | 45–45 / 45–45                     | 45–45                   | 77.09–77.81     | 0.50–0.52         |
| metadata-lenient-syntax | incomplete           | 3.65–4.81     | 48–48 / 48–48                     | 48–48                   | 77.11–77.43     | 0.50–0.52         |
| metadata-literal-limit  | parser-limit         | 2.61–3.62     | 40–40 / 40–40                     | 40–40                   | 77.41–77.70     | 0.50–0.50         |
| metadata-aggregate      | budget               | 17.55–41.04   | 2097276–2097276 / 2080892–2080892 | 16384–16384             | 86.63–87.29     | 0.50–0.54         |
| metadata-epoch          | epoch                | 1.59–3.13     | 0–0 / 0–0                         | 0–0                     | 77.16–77.34     | 0.51–0.52         |
| metadata-external-epoch | epoch                | 19.06–23.07   | 451–451 / 451–451                 | 315–315                 | 77.25–77.54     | 0.50–0.50         |
| metadata-tagged-no      | unresolved           | 3.10–3.61     | 26–26 / 26–26                     | 26–26                   | 77.65–78.05     | 0.50–0.98         |
| metadata-stall          | deadline             | 189.51–194.54 | 0–0 / 0–0                         | 0–0                     | 77.27–78.14     | 0.50–0.51         |
| slice-correct           | justified            | 6.12–9.74     | 59–59 / 59–59                     | 33–33                   | 77.52–77.79     | 0.51–0.51         |
| slice-wrong-origin      | malformed            | 3.22–7.08     | 44–44 / 44–44                     | 34–34                   | 77.31–77.73     | 0.50–0.50         |
| slice-oversized         | malformed            | 3.26–7.00     | 44–44 / 44–44                     | 33–33                   | 77.55–78.35     | 0.50–0.50         |
| slice-truncated         | malformed            | 3.24–6.05     | 42–42 / 42–42                     | 33–33                   | 77.77–77.98     | 0.50–0.52         |
| slice-extra             | malformed            | 3.64–4.20     | 61–61 / 61–61                     | 33–33                   | 77.31–77.85     | 0.50–0.52         |
| slice-disconnect        | unresolved           | 14.56–24.47   | 35–35 / 35–35                     | 33–33                   | 77.23–77.73     | 0.50–0.52         |
| slice-base64            | justified            | 2.88–16.74    | 59–62 / 59–62                     | 33–35                   | 77.58–78.25     | 0.56–1.06         |
| slice-qp                | justified            | 2.98–17.13    | 58–62 / 58–62                     | 33–35                   | 78.24–78.90     | 1.74–2.04         |
| slice-restart           | justified            | 3.35–17.72    | 35–62 / 35–62                     | 33–35                   | 77.76–78.64     | 1.18–1.53         |
| raw-wrong-origin        | unsafe-reproduced    | —             | — / —                             | —                       | 77.42–77.86     | 0.50–0.51         |
| deadline-search         | deadline             | 104.30–114.59 | 0–0 / 0–0                         | 0–0                     | 77.32–77.81     | 0.50–0.72         |
| deadline-done           | deadline             | 187.61–190.25 | 0–0 / 0–0                         | 0–0                     | 77.30–77.82     | 0.50–0.51         |
| deadline-preparation    | deadline             | 103.96–113.37 | 78–78 / 78–78                     | 23–23                   | 77.17–77.61     | 0.52–0.90         |
| deadline-cleanup        | deadline             | 142.06–155.59 | 430–430 / 430–430                 | 414–414                 | 77.67–78.82     | 0.50–0.50         |
| deadline-starvation     | deadline             | 142.04–144.67 | 0–0 / 0–0                         | 0–0                     | 77.08–77.55     | 0.96–1.87         |
| cancel-fetch            | cancelled            | 44.55–47.53   | 0–0 / 0–0                         | 0–0                     | 77.43–77.57     | 0.50–0.52         |
| late-callback           | deadline             | 105.62–115.55 | 0–0 / 0–0                         | 0–0                     | 77.69–78.00     | 0.50–0.51         |
| socket-timeout          | socket-timeout       | 72.03–73.68   | 0–0 / 0–0                         | 0–0                     | 77.73–77.92     | 0.50–0.51         |
| mutation-ambiguous      | deadline             | 190.36–196.78 | 0–0 / 0–0                         | 0–0                     | 77.72–77.87     | 0.50–0.52         |
| authentication          | authentication       | —             | — / —                             | —                       | 77.00–77.36     | 0.50–0.51         |
| connection-refused      | connection           | —             | — / —                             | —                       | 76.37–76.76     | 0.36–0.97         |

<!-- phase1b:end -->

## Retained failures and fixture correction

No assertion was weakened to hide a failure. [phase-1b-initial.json](../../../experiments/imap-transport/phase-1b-initial.json) retains 10/40 passed assertions: most failures followed meaningful rejection but the harness dereferenced `client.socket` after ImapFlow nulled it. The adapter/harness now retain the original native socket object for destruction/disposal observation. One interrupted assembly likewise failed disposal for this reason.

[phase-1b-diagnostic-failure.json](../../../experiments/imap-transport/phase-1b-diagnostic-failure.json) retains the 39/40 run: socket timeout classification failed because only logger entries were collected. Adding a public `error` listener retains ETIMEOUT before the derivative connection log. The original socket-timeout assertion remains.

[phase-1b-fixture-correction.json](../../../experiments/imap-transport/phase-1b-fixture-correction.json) retains 126/129 assertions: `BODY[HEADER] [)` was accepted by the parser and then rejected by required-field validation as incomplete, rather than producing the expected syntax error. That exact response is still tested as `metadata-lenient-syntax`; `metadata-malformed` now supplies `<abc>`, demonstrably raising `ParserError21`, and keeps its malformed classification assertion. The shared Phase 1 fixture/scenarios were not corrected or weakened for this result.

## Remaining blockers and not tested

1. Strict K parser identities require a budget check before token allocation, shared across responses. Strict byte preallocation requires a budget before the parser accepts a chunk/literal declaration, plus explicit TLS/stream overshoot headroom. Current instrumentation bounds admitted input and collection, not total process memory.
2. Origin/completeness observation relies on private, pinned source. For future production use, review a narrow supported hook or isolated dependency patch exposing parsed origin and tagged parser diagnostics. No production import of this adapter is authorized by these experiments.
3. Logger correlation can be lost after request completion; unknown diagnostics conservatively reject evidence. Concurrent command owners, raw calls bypassing the adapter, buffered pre-scope unsolicited input, source upgrades, compression, STARTTLS and rev2/ESEARCH require separate validation. A version check alone is not a source-compatibility proof.
4. The metadata wrapper is a transport experiment, not complete production metadata/schema validation. It does not prove semantic MIME validity, comprehensive envelope parsing, flags snapshot isolation, field size policies or persistence atomicity. Searched-but-missing UID resolution remains a future same-epoch membership recheck.
5. Content finality depends on an explicitly expected encoded length and verified epoch. The fixture supplies that length as an oracle; provider MIME-length reliability, zero-length parts, charset conversion, malformed transfer encoding, decoder error recovery and filesystem/cache publication are NOT TESTED. No durable decoder/slice cursor was added.
6. Timeout settles the installed transport operations tested here. Arbitrary event-loop starvation, application promises or database writers need separate containment/cancellation. A watchdog worker/process would be justified only by a separately required unconditional wall-clock SLA; none was introduced.
7. Scripted server lacks real storage/expunge races, full capability negotiation, OAuth, provider throttling and remote session retention. It shares a process/event loop with the client, affecting timing and memory. Local refusal port reuse is possible in a busy environment and fails explicitly if observed. STORE outcome is deliberately unknown; no mailbox mutation oracle or exactly-once guarantee is claimed.

Docker/Dovecot, Phase 2, a synchronization engine, scheduler, DB migration/lease/commit fences, SMTP/OAuth/drafts/UI changes, production patches, pushes, PRs and merges were **NOT RUN / NOT IMPLEMENTED**. ImapFlow 2.0.6 remains a viable dependency candidate with narrow adaptation; it does not meet the full proposed bounded-operation contract through public APIs/configuration alone.
