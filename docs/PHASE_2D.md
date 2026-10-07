# Phase 2D — Reply, Reply All and Forward

Phase 2D derives an editable plain-text outgoing message from a locally synchronized message. It adds Reply, Reply All and Forward to the existing reader and composer. **Reply/Forward does not introduce a second delivery pipeline.** Phase 2C remains responsible for outgoing persistence, immutable MIME, pg-boss scheduling, SMTP uncertainty, account/provider abstraction and Sent-copy APPEND/reconciliation.

## Preparation architecture and content

The owner-protected `POST /api/accounts/:accountId/mailboxes/:mailboxId/messages/:messageId/prepare?mode=reply|reply_all|forward` boundary calls `ComposePreparationService.prepare`. The browser supplies identifiers and mode only. PostgreSQL supplies original identities, recipients, subject, dates, RFC Message-ID, References and local content. Phase 1D's placement lookup checks all three identifiers, including message and mailbox account ownership.

Ready content prepares immediately. Unfetched content calls the existing `MessageContentService.request` and its durable content scheduler. Pending/fetching returns HTTP 202, without a prefill or an empty quote. The reader shows Preparing message and polls preparation every second, for up to one minute; a timeout allows another attempt. Failed content returns a clear error; the existing reader content retry schedules another fetch. Switching source selection cancels the UI preparation result. Preparation does not send, append or mark the source read.

Plain-text content is preferred. For HTML-only content, the server converts the existing locally sanitized Phase 1D HTML into text with jsdom, without script execution or a resource loader. Block elements and line breaks become text line breaks. Original or sanitized HTML markup is never inserted into the composer DOM. Conversion is intentionally simple; visual HTML formatting is not retained. A ready empty text body is distinct from content which has not yet been fetched. Preparation rejects quoted text exceeding the existing 500,000-character composer limit.

## Recipient derivation

Incoming mailbox addresses are validated as Internet addr-specs. Display names are cleaned of header controls and limited to 200 characters, then quoted/escaped for the recipient editor. Identity is the trimmed address compared case-insensitively, never the display name.

Reply prefers usable non-self Reply-To addresses. Invalid/unusable Reply-To falls back to From. Sender is used only if there is no usable From author address; it does not override a valid From. Addresses equal to the source account's email are excluded. When no usable recipient remains, preparation returns “No usable reply recipient is available.”

Reply All starts with that reply target, adds original To to To, then original Cc to Cc. It removes the source account address and deduplicates globally in that order. An address selected for To cannot also appear in Cc. The first useful display name is retained with its mailbox. One remaining recipient is valid. Original Bcc is never read by the derivation algorithm or propagated.

Forward starts with empty To/Cc/Bcc. All three actions default to the source owning account if it is eligible to send, otherwise the composer's existing eligible-account fallback applies. Users can switch sending account and edit To/Cc/Bcc, subject and body. Switching account does not recompute recipients. From remains server-authoritative for the final selected account.

## Subjects, threading and MIME

Subjects use deterministic case-insensitive `Re:` or `Fwd:` handling, collapsing repeated leading instances of that same prefix. No localization dictionary is used. Empty subjects become `Re: (No subject)` or `Fwd: (No subject)`. Header controls are replaced with spaces; the existing subject length bound applies.

Reply and Reply All derive In-Reply-To from a syntactically plausible RFC Message-ID. References retains valid unique source tokens and adds the source ID as the newest reference, without duplication. Invalid tokens, control-bearing tokens and malformed source IDs are ignored rather than failing the reply. Missing source Message-ID omits In-Reply-To and retains valid existing References. Local UUIDs are never substituted for incoming RFC IDs.

References is limited to 30 IDs and 4,000 characters, retaining the newest tail. Each token is limited to 254 characters; incoming scanning/storage is bounded to a 65,536-character tail. Forward always omits both reply-thread headers. Each outgoing message still obtains its own stable Phase 2C Message-ID. The existing deterministic MIME builder adds only validated threading headers and retains Bcc privacy and the one-megabyte MIME limit.

## Plain-text body defaults

Replies begin with a blank response area, followed by `On <UTC date>, <author> wrote:`. The RFC-style UTC date comes from the source sent date or its internal date, independent of browser locale. Every original line is quoted with `> `; existing `>` lines gain another `>` for nested quotation. Newlines are normalized deterministically. The composer places the cursor in the blank response area. Users may change or remove the quote.

Forwards begin with a blank area and a `---------- Forwarded message ----------` block containing only safe From, Date, Subject, To and optional Cc, followed by original plain text. No original Bcc, Received, authentication headers, internal IDs, raw MIME or provider metadata is copied. If the original has attachments, the composer says they are not included.

## Server authority, schema and Phase 2C integration

The normal `/api/outgoing` request accepts optional strict source context `{accountId, mailboxId, messageId, mode}`. It rejects arbitrary browser-supplied `inReplyTo` and `references`, including on new messages. In its existing creation transaction, `OutgoingMessageService.create` rechecks source placement and derives threading from the current PostgreSQL source under a shared lock. The source account may differ from the selected sending account, allowing normal account switching without bypassing source ownership checks.

Only user-editable fields come from the composer. Derived threading is persisted together with the normal durable snapshot and MIME before scheduling the usual outgoing job. The worker, SMTP claim/recovery behavior, uncertainty states, Sent-copy policy snapshot, APPEND and reconciliation services are unchanged. The same stored MIME bytes travel through SMTP and Sent-copy.

The forward-only `0014_flowery_patriot` Drizzle migration adds incoming `messages.references` (text), outgoing `in_reply_to` (nullable text), and outgoing `references` (non-null JSON array, default empty). It replaces the immutable snapshot trigger to protect both new outgoing fields while retaining every Phase 2C protected field. Existing outgoing rows and MIME remain intact. No historical migration is edited.

References is now included in existing metadata synchronization queries and stored alongside the envelope. Previously synchronized sources have no historical References until refreshed by the existing metadata sync; replies can still thread using their already stored RFC Message-ID. No separate remote fetch pipeline or bulk refetch is introduced.

## Security and verification

Preparation and sending require owner authentication and mutation Origin protection. Source message/account/mailbox mismatches are rejected. Incoming addresses and header values remain untrusted. Only validated threading tokens reach MIME; arbitrary incoming headers cannot be copied. Source HTML remains isolated by Phase 1D, and only plain text enters the editable textarea. Original Bcc is excluded, while user-entered outgoing Bcc retains the Phase 2C envelope-only behavior. Existing recipient, compose and MIME limits remain enforced.

Focused tests cover recipient fallback/self removal/deduplication, subjects, malformed/bounded threading, deterministic quoting, safe forward headers, HTML-to-text conversion, content states and retries, preparation API access, source isolation, final server re-derivation, immutable database/MIME snapshots, stable outgoing IDs, account switching, existing SMTP/Sent-copy paths, and reader/composer states. Existing Phase 2C crash and uncertainty tests remain part of the full suite. The migration regression also checks unchanged legacy outgoing MIME and defaults after the new forward migration.

## Deferred features

Attachments and forwarding attachments, inline images, rich-text/HTML composition, drafts/autosave, thread/conversation UI or grouping, arbitrary From/aliases, signatures, contacts, scheduled/undo send, automatic read-on-reply and message/rfc822 forwarding remain out of scope.
