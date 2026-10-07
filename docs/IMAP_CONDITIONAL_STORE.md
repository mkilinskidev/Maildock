# Generic IMAP conditional STORE correction

This fixes flag mutations for any IMAP account using CONDSTORE. Google OAuth, Microsoft OAuth, account credentials, synchronization architecture, mailbox advisory locking and durable command storage are unchanged.

## Dependency decision

Before choosing an upgrade, the published npm `imapflow@2.2.5` tarball's `dist/esm/commands/store.js`, current upstream `src/commands/store.ts` and `test/commands/store-test.ts` were inspected on 2026-10-05. The newer published code still appends UNCHANGEDSINCE after the flags, returns true for a successful tagged response without inspecting MODIFIED, and swallows STORE exceptions into false. Upstream's conditional test checks only for the existence of an UNCHANGEDSINCE argument, rather than its serialized position. An upgrade therefore does not demonstrably fix either defect.

The smallest supported solution is a version-specific pnpm patch of the existing `imapflow@2.0.6`, applied to its ESM and CommonJS STORE handlers. No package upgrade, additional dependency, protocol-client fork, runtime monkey patch or second protocol stack is introduced. Only the STORE command implementation in the two published builds is patched.

References inspected:

- [Current upstream STORE source](https://github.com/postalsys/imapflow/blob/master/src/commands/store.ts)
- [Upstream STORE tests](https://github.com/postalsys/imapflow/blob/master/test/commands/store-test.ts)
- [Published 2.2.5 package](https://registry.npmjs.org/imapflow/-/imapflow-2.2.5.tgz)
- [RFC 7162 conditional STORE](https://www.rfc-editor.org/rfc/rfc7162.html#section-3.1.3)

## Patch contract

`patches/imapflow@2.0.6.patch` makes these narrowly scoped corrections:

1. Insert the modifier immediately after the sequence set, before the flag operation:

   ```text
   UID STORE 42 (UNCHANGEDSINCE 3) +FLAGS (\Seen)
   ```

2. Preserve `UNCHANGEDSINCE 0` as a conditional modifier rather than omitting it by truthiness.
3. A tagged `OK [MODIFIED ...]`, or the RFC-permitted `NO [MODIFIED ...]`, during conditional STORE throws a fixed-message error with `code=ConditionalStoreFailed`. A tagged OK without MODIFIED returns true.
4. Plain BAD/NO, network and other command errors propagate as exceptions instead of false. No new logging is introduced. False retains its existing meaning for operations not performed locally, such as rejected flags or unavailable state, and Maildock treats it as a failure rather than proof of a concurrency conflict.

This boolean-or-coded-error boundary is internal to the dependency adapter; no `MailProvider` contract changes are needed. Maildock sanitizes protocol errors through its existing `MailProviderOperationError` path. Raw server responses and credentials are not exposed in UI/API errors.

The patch is declared under `patchedDependencies` in `pnpm-workspace.yaml` and fingerprinted in `pnpm-lock.yaml`. `pnpm install --frozen-lockfile` applies it to installed `node_modules`; maintainers should not edit installed files manually. Dockerfile copies the patch directory before the frozen dependency installation so rebuilt application and worker images also use the patched library. Running containers remain unchanged until rebuilt/redeployed.

When an upstream version corrects both defects and error classification, inspect its actual published implementation and rerun these protocol tests before replacing/removing the patch.

## Bounded conflict reconciliation

`ImapSmtpMailProvider.mutateMessage()` retains the original conditional update using the stored placement MODSEQ. Only `ConditionalStoreFailed` from an actual conditional operation starts reconciliation. A false library return or protocol error never produces the owner-facing concurrency message.

For mark read/unread and flag/unflag, after that first genuine conflict:

1. Re-select the same mailbox and verify its UIDVALIDITY against the original request. Abort with the existing epoch error if it changed.
2. Fetch the same UID's current flags and MODSEQ. A missing UID produces the existing source_missing outcome.
3. If the requested flag state is already satisfied, return applied without another STORE.
4. Otherwise add/remove just that one flag using the fresh MODSEQ. Missing fresh MODSEQ or loss of CONDSTORE is a failure, not a downgrade to an unconditional write.
5. A second MODIFIED produces conflict. There is no third STORE or reconciliation loop in this invocation.

These operations express a desired individual flag state; retry does not replace all flags or overwrite unrelated metadata. A concurrent opposite change to the same flag may be superseded by the still-pending command's intent. The fresh conditional update protects the interval between refetch and retry. MOVE/archive/trash remain outside this reconciliation path.

The existing command worker holds the existing mailbox advisory lock throughout the invocation. Terminal conflict still fails once, rolls back the optimistic local projection and schedules existing delta reconciliation. Plain protocol failures retain existing bounded durable transport retries and ultimately use safe protocol-failure text. No changes to `MessageCommandService`, queue semantics or sync code are required.

## Regression coverage

`tests/imap-conditional-store.test.ts` runs the actual installed ImapFlow client, serializer, parser and TCP transport against a strict local IMAP fixture. It verifies both ESM and CommonJS builds and exact wire output, rather than mocking messageFlagsAdd/Remove return values. Coverage includes matching/stale MODSEQ, OK/NO MODIFIED, plain BAD/NO, all four single-flag operations, already-satisfied state, fresh MODSEQ retry, unrelated flag preservation, UIDVALIDITY change, source disappearance, missing MODSEQ, the two-STORE bound, zero and protocol-sized MODSEQ, and existing non-CONDSTORE behavior.

`tests/message-actions-provider.test.ts` also verifies that an unexplained false result is a protocol/library failure. `tests/message-commands.integration.test.ts` uses real PostgreSQL to verify terminal conflict, retained transport retries, safe failure classification and reconciliation while retaining existing MOVE/lock tests. The complete existing suite includes Microsoft MSAL/migration and manual IMAP regressions.

## Validation and live follow-up

Final validation on bundled Node 24.19.0:

- `pnpm test --maxWorkers=4`: 69 files, 801 tests passed, including Microsoft/MSAL/migration and manual IMAP regressions.
- `pnpm test:security`: 2 files, 39 tests passed.
- `pnpm test:security:browser`: complete original harness passed using installed Chromium through `SECURITY_BROWSER_EXECUTABLE`.
- `pnpm typecheck`: web and worker passed.
- `pnpm lint`: zero errors; one pre-existing unused-import warning in the ignored local `.security-results/signature-settings-preview.mjs` artifact.
- `pnpm build`: Next.js production and worker TypeScript/import-fix builds passed, with process-local `APP_ORIGIN=https://mail.example.com`; `.env` was unchanged.
- `pnpm install --frozen-lockfile --ignore-scripts`: passed locally.
- Docker dependency-stage build: passed with pnpm 12.6.0 frozen install; an in-memory serialization probe inside the resulting image confirmed the installed patch produces the exact RFC command. No live Maildock container was replaced.
- Formatting of changed TypeScript/document files and `git diff --check`: passed.

During validation an additional protocol-sized MODSEQ test initially used a value outside ImapFlow's accepted RFC range. Its fixture was corrected to a valid 19-digit integer still exceeding JavaScript Number precision; the final full suite above passed. An intermediate lint invocation also included the temporary package-editing copy; that copy was moved out of the workspace after generating the durable pnpm patch, and final lint passed without ignoring or weakening checks.

No live Gmail flags are changed by the automated fixture. After rebuilding/redeploying the app and worker with this working tree, repeat the real smoke test: open an unread Gmail message, wait for auto-read, verify successful command status and `\Seen` in Gmail, and verify delta/IDLE reconciliation. Also verify mark unread, flag/unflag, unrelated flag retention, and existing Microsoft/manual IMAP accounts. A live race with another client can validate bounded reconciliation, but deterministic protocol tests cover that race without relying on timing. Existing failed durable commands are terminal and are not silently replayed by this fix; issue a new action.