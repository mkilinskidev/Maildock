# Gmail API P1 — implemented foundation

Date: 2026-10-09. Baseline: `7ae6f28f66a0e3e10ceb64fa1af53412c4d39956` on `codex/gmail-api-p0`. Implementation branch: `codex/gmail-api-p1`. The comparison with `test` found documentation changes only; its approved code fixes are already in the baseline. P1 is an increment toward the complete provider and must not be deployed as Gmail receiving.

## Storage and ownership

Migration `0036_military_daimon_hellstrom.sql` and its Drizzle snapshot add the native foundation. All previously shipped SQL migrations remain byte-identical. Shared messages, content, conversations, search, attachments, local drafts and outgoing records remain authoritative; no second message store or legacy Gmail conversion exists.

Persisted `gmail_smtp` plus Google OAuth selects generated `receive_transport = gmail`. Gmail accounts have no IMAP endpoints, credentials, capabilities or SMTP credential borrowing. Password and Microsoft OAuth identities require IMAP configuration. Native message/thread/history/label IDs use text; history IDs are decimal strings and never JavaScript numbers. IMAP placement uniqueness remains scoped to mailbox/UIDVALIDITY/UID; Gmail membership uniqueness is mailbox/message with NULL UID, UIDVALIDITY and modseq. Gmail message uniqueness is account/native message ID, and label uniqueness is account/native label ID. A virtual All Mail view has a separate identity. Tombstone and inventory-generation fields support later reconciliation.

Composite foreign keys fence account and transport ownership across mailboxes, messages, memberships, attachment sources, commands (including destination and placement), notifications and native Sent observation. Gmail notification identity is account/message, independent of labels. Command intent sequence is allocated under a message lock; account work revisions use bigint and travel in queue payloads as decimal strings.

`gmail_account_sync_state` holds coverage, inventory/history runs, durable page cursors, history candidate, error categories, due work and quota counters. `gmail_sync_work` stores deduplicated account/run/purpose/message receipts. Page intake is transactional, limited to 500 input IDs and requires draining the previous page; completed receipts are pruned before the next page. A final history page requires its response history ID. This is storage infrastructure only, without a Gmail API caller or checkpoint orchestrator.

## Routing and execution

`MailTransportRouter` owns persisted provider resolution, discriminated provider identities, readiness, revision validation, capabilities and the typed unsupported Gmail adapter. IMAP and Gmail message/part locators are separate unions. Web/account and worker roots compose this same policy. Transport is never inferred from email domain.

Google discovery creates durable blocked/unsupported state and an actionable receive diagnostic. Producers and consumers of discovery/recent/delta/backfill/content jobs validate account identity and revision; payloads contain identifiers and revisions, never credentials. Polling and IDLE select eligible IMAP accounts only. Direct content, attachment and command work passes the same policy. Missing revision in a legacy receive payload fails closed.

Receiving publication transactions acquire a shared account lock and validate the captured revision before writing provider results. Disable, configuration edit, reconnect and OAuth revocation advance the revision. Credentials are revalidated after resolution. IMAP UIDVALIDITY, session lifecycle and existing coalesced scheduling remain in place. Cached local content and draft attachments remain local infrastructure.

SMTP keeps the existing delivery/outcome model and Google OAuth scope. Google SMTP resolves independent SMTP credentials. Gmail is server-managed Sent: the coordinator cannot issue IMAP APPEND, even if a stored custom-copy preference exists. Native Sent observation remains for the later provider phases; P1 reports an unsupported receive diagnostic rather than claiming that a custom copy was saved. Remote Gmail drafts are never adopted.

## Provisioning and recovery

The release guard runs after ordinary database-authority validation and before incompatible migrations, web bootstrap or worker startup. It rejects any populated pre-native public application table, including initialized owner state. Only the shipped uninitialized singleton is exempt. Native schema recognition also requires the exact recorded foundation migration hash/timestamp. The migration repeats this refusal before its first DDL. The guard never erases or copies data and provides a fixed operator-safe diagnostic.

Authority inventory includes both native tables without adding privileged helpers. Restore verification retains exact complete migration histories and search-function checks, and additionally checks native conditional constraints, ownership FKs, generated transport and identity indexes. Literal values and AND/OR grouping are preserved while PostgreSQL deparse syntax is normalized.

| Recovery set                                                              | Supported operation                                                                                                           |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Fresh empty ordinary destination                                          | Apply full release history; perform standard owner/MFA setup.                                                                 |
| Matched native backup and native binary                                   | Exact native TOC/functions/history import, then schema/security/key/blob verification and offline maintenance before writers. |
| Populated legacy backup and legacy binary                                 | Retain the reviewed historical recovery procedure with its matched binary.                                                    |
| Populated legacy installation or restored legacy backup and native binary | Refused before incompatible DDL/bootstrap; provision separate empty storage or use the matched legacy binary.                 |

The restore helper accepts only reviewed complete legacy/native table sets, complete exact migration manifests and exact function definitions. It does not mix row-wise hash alternatives or edit dump contents. Native LF history and the reviewed historical deployed-prefix alternative are recorded separately. Importing a legacy archive is not permission to upgrade it with this binary.

## Conservative deviations and phase boundary

Drizzle cannot express PostgreSQL `ON DELETE SET NULL (selected_columns)`. The generated P1 SQL is reviewed to null only the optional attachment-source/command-destination/command-placement columns while retaining non-null ownership columns. Referenced unique indexes are ordered before their foreign keys. The snapshot uses Drizzle's general SET NULL representation; any future FK recreation must preserve the selected-column SQL.

Historical migration regressions are pinned to their actual pre-native release. Account-only synthetic fixtures are explicitly reseeded after empty P1 DDL for current service checks; this test helper is not an application migration path and does not convert received mail or Gmail identity.

The Gmail adapter deliberately fails until P2. No live Google requests, new OAuth scopes, Gmail API sending, remote editable drafts, data conversion, deployment or database reset are part of P1. P2 can implement the authenticated HTTP client, diagnostics and quota policy against these seams; inventory/history orchestration and final native feature acceptance remain in their approved later phases.

## Validation

Validation uses disposable PostgreSQL 18.6 testcontainers, synthetic credentials and fixtures. Coverage includes routing/readiness/revision, Google IMAP exclusion (including attachment producers), native account/message/label ownership, bounded durable work, fresh provisioning, populated legacy refusal, exact restore and existing IMAP/security regressions.

- Web TypeScript: `tsc --noEmit` — passed.
- Worker TypeScript: `tsc -p tsconfig.worker.json --noEmit` — passed.
- ESLint: `eslint .` — passed without errors or warnings.
- Drizzle generation against the final snapshot — no schema changes.
- Changed-file Prettier check and `git diff --check` — passed. Global `prettier --check .` reports only the unchanged P0 `docs/architecture/gmail-api-architecture-audit.md`.
- Complete Vitest traversal with four workers: 108 files, 1,333 tests; all 633 integration tests passed. One unit fixture still expected the old attachment-only queue payload. It was updated to require account/revision identifiers while continuing to reject protocol fields and secrets, then the complete unit suite was rerun.
- Final complete unit suite: 72 files, 700 tests — passed.
- Additional final regressions: attachment/routing/logging 97 passed; strengthened logging/routing 31 passed; native schema/restore 24 passed. These overlap the complete suite and are not added to its total.

All current 1,333 tests are therefore verified across the complete traversal and the final corrected unit rerun. No live Gmail API or production mailbox/database credentials were used. No merge, push, deployment or live storage reset was performed.
