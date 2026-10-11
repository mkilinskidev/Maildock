# Sync Engine v2 — Provider Capability Matrix

Status: **Design draft; repository/static and protocol evidence, not live qualification**
Date: 2026-10-11
Scope: IMAP (password and Microsoft OAuth) and native Gmail REST (Google OAuth)
Related: [Product contract](PRODUCT_CONTRACT.md), [v1 audit](CONTRACT_REVIEW_AND_V1_AUDIT.md), [Issue #5](https://github.com/mkilinskidev/Maildock/issues/5)

## Evidence conventions

- **P**: provider/protocol capability backed by linked official specification.
- **R**: source implementation currently observed on branch `sync-engine-v2`; not proof of passing runtime behavior.
- **V**: requires live-provider/integration validation.
- **D**: proposed v2 design implication, not approved implementation.

Do not conflate provider features with guarantees already met by Maildock. No production tests, auth requests, database resets, code changes or migrations were performed for this matrix.

## Capability matrix

| Capability | IMAP | Native Gmail REST | v2 implication |
| --- | --- | --- | --- |
| Account discovery | R: `listMailboxes`, selectable paths, special-use metadata; capabilities negotiated | R: Gmail labels/profile via native adapter | D: discover INBOX before any account history; missing/inaccessible INBOX is visible failure |
| Initial INBOX window | P: UID search/fetch and server date predicates; R: recent sync by cutoff, UID slices | P: `messages.list` with INBOX `labelIds`, query `q` where supported, paginated IDs, `messages.get` metadata; R: recent-first sync | D: 30 days / max 200 / fill to 50 from any age. Specify cutoff clock, deterministic ordering and fixed baseline by provider; do not assume full snapshot pagination |
| New mail wakeup | P: IMAP IDLE exists when server advertises capability; R: `idle-watchers.ts` for eligible INBOX; polling fallback | P: history polling; optional Gmail watch/PubSub; R: periodic Gmail poller without mandatory Pub/Sub | D: continuous background sync independent of browser; wakeup is hint, reconciliation establishes correctness |
| Incremental changes | P: mailbox-scoped UIDs, flags, optional CONDSTORE/QRESYNC, remove detection fallback | P: account-wide `users.history.list`: messageAdded/Deleted and labelAdded/Removed | D: do not force account-wide Gmail history into IMAP-style per-folder cursors |
| Durable checkpoint | R: mailbox UIDVALIDITY, last UID, optional MODSEQ; no portable account-wide IMAP cursor | P: Gmail historyId as opaque decimal string; R: account-wide history checkpoint plus separately durable progress | D: separate safe provider checkpoint from bounded batch/backfill progress; never advance past unfinished covered work |
| Checkpoint invalidation | P: changed UIDVALIDITY invalidates UID identity; optional resync support | P: expired/out-of-range historyId can return HTTP 404, requiring full reconciliation | D: controlled reconciliation; no DB reset or destructive disappearance based on partial enumeration |
| Identity | P: UID unique only within mailbox + UIDVALIDITY; RFC Message-ID not unique | P: native message ID account-scoped, independent of label membership; R: unique canonical row proposal/implementation | D: discriminated locators; never fabricate Gmail UID or assume IMAP MOVE preserves UID |
| Folders / labels | P: mailbox membership by path/UID; MOVE capability varies by server | P: many labels per message; removing INBOX doesn't delete message | D: canonical identity versus placement/membership must stay separate |
| Read/unread, star | P: IMAP flags, sometimes conditional MODSEQ | P: add/remove message label IDs | D: existing optimistic durable intent + remote confirmation; guard stale responses |
| Archive/trash/move | P: MOVE optional; copy/delete fallback semantics require separate analysis | P: remove INBOX/add label; trash endpoint; label operations | D: preserve meaning of archive vs delete and provider-specific identity |
| Full body / attachments | R: on-demand IMAP part fetch | R: on-demand Gmail MIME / attachment retrieval | D: keep existing renderer, sanitizer, caching, blob and attachment infrastructure |
| Quotas / concurrency | P: operational server connection and request limits vary by provider and account; no universal units/session | P: weighted units/user/project/minute; quota policy can differ across projects; R: `gmail-quota.ts` | D: Inbox First, History With Leftovers within Maildock-controlled capacity, account fairness, reserve usable provider capacity; do not treat interactive quota allocation as proof of INBOX reservation |
| Retry & backoff | R: IMAP reconnect, timeouts and controlled jobs | R: classified errors, 403/429 backoff and quota tracking | D: show degraded/stale, persist retry deadline, no busy retry loops |
| Sending/drafts | R: SMTP, durable sending and local drafts | R: SMTP still sends for Gmail accounts; received SENT is server managed; local drafts unchanged | D: out of receive-engine redesign; prevent regressions |

## Primary source references

- Gmail synchronizing clients: https://developers.google.com/workspace/gmail/api/guides/sync
- Gmail `messages.list`: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
- Gmail `history.list`: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list
- Gmail quotas: https://developers.google.com/workspace/gmail/api/reference/quota
- Gmail push (optional): https://developers.google.com/workspace/gmail/api/guides/push
- IMAP base protocol RFC 9051: https://www.rfc-editor.org/rfc/rfc9051
- IMAP IDLE RFC 2177: https://www.rfc-editor.org/rfc/rfc2177
- IMAP CONDSTORE/QRESYNC RFC 7162: https://www.rfc-editor.org/rfc/rfc7162

**Important freshness caveat:** Google's usage-limit page has a May 2026 change and grandfathered project behavior; never hard-code the historical documented daily threshold or assume all projects have identical account allocations. Read actual configured Cloud limits during implementation/qualification. The current `gmail-quota.ts` budgets are application-defined ceilings, not proof of Google quotas.

## Current repository seams inspected

- `src/modules/accounts/domain/mail-provider.ts`: IMAP-oriented MailProvider, UID/epoch requests, metadata and mailbox-scope interfaces.
- `src/modules/accounts/domain/receive-transport.ts`: transport identity and discriminated Gmail/IMAP message locators, capability presentation.
- `src/modules/accounts/infrastructure/imap-smtp-mail-provider.ts`: IMAP fetch/search/mutate and SMTP implementations.
- `src/modules/accounts/infrastructure/gmail-client.ts`: native Gmail API client, typed payloads.
- `src/modules/mail/application/delta-sync-service.ts`: current IMAP delta and epoch behavior.
- `src/modules/mail/application/backfill-sync-service.ts`: IMAP backfill frontier.
- `src/modules/mail/application/gmail-sync-service.ts`: Gmail account-level state and bounded slices.
- `src/modules/mail/infrastructure/gmail-sync-jobs.ts`: Gmail account queue and periodic wakeups.
- `src/modules/mail/infrastructure/idle-watchers.ts`: IMAP IDLE triggers.
- `src/modules/mail/infrastructure/gmail-quota.ts`: application-side weighted quota budgets.
- `docs/adr/0013-gmail-message-identity-and-label-membership.md` and `docs/adr/0014-gmail-account-history-and-progressive-sync.md`: original design rationale; marked proposed.
- `docs/architecture/gmail-api-complete-provider.md`: implementation report; not live-provider signoff.

## Critical unresolved questions

1. **Initial-window ordering:** Is the 30-day filter defined by server internal receipt timestamp? How are forwarded/imported/backdated messages handled, and can the 50-message fallback be selected with deterministic tie-breaking?
2. **Bootstrap vs first delta:** How is a stable provider baseline captured and replayed while INBOX changes, without waiting for a quiet mailbox or letting history run first?
3. **IMAP capability degradation:** Which exact behavior applies when IDLE, CONDSTORE, QRESYNC, UIDPLUS, MOVE or stable object identifiers are missing?
4. **IMAP UIDVALIDITY:** What gets invalidated and how can content/UUID references be preserved only when identity is proved? Avoid false universal guarantees.
5. **Gmail history expiry:** What complete reconciliation can run under quotas without indefinitely starving new INBOX checks?
6. **Quota realism:** Are per-account and project budgets shared fairly? Test quota depletion, 403/429 and project-specific effective limits; measure costs of history and fresh read.
7. **Concurrent local actions:** What transport-specific operations are safe to retry after an uncertain response, and what state must be observed before retry?
8. **Cross-provider presentation:** How does the existing frontend preserve IDs, counts, folder memberships, unread flags and read-on-demand semantics without leaking fake protocol identities?

## Recommendation and next gate

**Do not design one giant generic `syncMailbox()` interface.** Define a small shared *product and persistence contract* with provider-specific enumeration, delta/identity and mutation semantics. Preserve stable UI-facing identities and existing features, but implement no provider-agnostic guarantee unsupported by either transport.

Next artifact: `SYNC_STATE_MODEL.md`, with a minimal state graph distinguishing bootstrap, current-INBOX eligibility, provider checkpoint, historical progress and retries. Separately plan the fresh-install instrumentation to reproduce the reported P2-before-INBOX bug. Design choices above remain proposals until reviewed.

No implementation authorized by this document.
