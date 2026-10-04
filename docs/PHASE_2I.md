# Phase 2I — Global Mail Search

Maildock searches **all configured accounts and synchronized mailboxes** in the
local PostgreSQL database. The selected account, selected mailbox and Conversation
View setting do not scope search. Results are individual messages, never
conversation aggregates. Disabled accounts remain searchable locally.

**Search does NOT fetch missing message bodies.** Metadata search covers the
synchronized history, while body search covers locally available content. Search
has no IMAP/provider or job-scheduler dependency. Opening a result can request its
content through the existing on-demand MessageReader flow, exactly as opening a
normal mailbox message does.

## Search document and fields

Each account-level `messages` row has one `search_body` and a PostgreSQL **stored
generated `search_vector`**, indexed by `messages_search_gin_idx` using GIN.
Mailbox placements never duplicate the searchable document.

`maildock_search_vector` builds weighted vectors with explicit `simple`
configuration:

| Weight | Fields                              |
| ------ | ----------------------------------- |
| A      | Subject                             |
| B      | From and Sender names and addresses |
| C      | To and Cc names and addresses       |
| D      | Locally available body text         |

No attachment binary, attachment filename, Bcc or remote body is indexed.
The generated column recomputes in PostgreSQL when its source fields change,
including synchronization updates and historical metadata backfill.

`message_contents.search_text` holds the server-extracted local text. Content
fetch/storage writes it alongside the plain and sanitized HTML content in the same
update. A database trigger mirrors that text into `messages.search_body`; content
deletion clears it. Content status transitions preserve previously stored local
text. Search never waits for a content job.

The normal mailbox-list query explicitly selects its existing metadata fields so
adding body/vector columns does not make ordinary list requests read entire bodies.
No FTS vectors or private account credentials appear in search responses.

## Query semantics, languages and email addresses

`plainto_tsquery('simple', boundQuery)` treats input as data and joins ordinary
words with AND. `windows insider`, `sea of thieves` and `invoice 12345` require
their respective tokens. Quotes, punctuation and tsquery-looking operators are
processed by PostgreSQL's text parser; they cannot inject query operators or SQL.

`simple` provides predictable case-insensitive multilingual tokens without
English-only stemming or stop-word removal. Polish accented words retain their
accents. Numeric identifiers such as `12345` are searchable. This V1 does not
implement stemming, accent folding, fuzzy matching or partial-token/prefix search.

PostgreSQL normally retains a complete email address as one token. The immutable
`maildock_search_addresses` function adds a copy with `@` replaced by a space,
alongside the original address and display name, plus punctuation-separated address
components (including individual domain labels). Consequently
`mateusz@example.com`, `example.com` and `mateusz` all find that identity through
the same GIN-indexed FTS document, without broad ILIKE scans. A domain label such as
`microsoft` also matches an address at `microsoft.com`. More complex local
parts and domains follow PostgreSQL's normal token boundaries; arbitrary
substrings are not promised.

## Local body extraction and migration

`searchBodyText` prefers a nonempty local plain-text part. For HTML-only content it
parses the **locally stored sanitized HTML** using server-side JSDOM, with scripts
and resource loading disabled. It removes active/non-text tags, CSS, hidden
elements, and elements hidden by supported CSS selectors or inline display/
visibility rules. It reads text nodes, decodes entities and inserts whitespace
between common block/table elements. Attributes are never read as searchable
content, so image URLs, CID URLs/data, link targets and tracking attributes are
excluded. It does not run the browser renderer or activate remote resources.

Forward-only migration `0019_global_search.sql` creates the columns, immutable
functions, content trigger and GIN index. All existing metadata becomes searchable
when PostgreSQL populates the stored generated column. Existing plain bodies are
copied locally during this SQL migration.

The standard `pnpm db:migrate` entrypoint then calls
`initializeLocalSearchBodies`, which converts remaining existing local HTML in
batches of 100. This is a **local text-conversion initialization**, not a remote
body backfill. It is resumable and idempotent; conditional writes avoid replacing
text concurrently stored/refreshed by the content worker. Container startup uses
the same compiled migration entrypoint before starting web/worker processes.
Use this entrypoint rather than running only the SQL file: existing HTML-only
content needs the server parser step. No account recreation or mailbox resync is
required, and historical migrations remain unchanged.

## Ranking, placements and response

`ts_rank` uses the standard A/B/C/D weights. Subject and sender matches generally
outrank recipient/body-only matches. Ties sort by internal message date descending,
then UUID descending, so ordering is deterministic.

`GET /api/search?q=...` requires existing owner authentication. Input is bounded to
256 characters before trimming. Empty/whitespace input returns an empty page
without executing a database search. Results are bounded to **50**, with a
`hasMore` flag obtained by requesting at most 51 rows. There is no V1 cursor;
refining the query reveals more relevant messages.

PostgreSQL-incompatible NUL characters are rejected before database execution.

Each item contains message ID, subject, sender, date, size, attachment indicator,
seen/flagged state, account ID/name, mailbox ID/name and a plain-text snippet.
One SQL lateral join chooses a deterministic placement: active/selectable first,
then selectable, mailbox path under C collation, mailbox UUID and placement UUID.
Action-hidden placements are excluded. Messages with no remaining visible
placement cannot be opened and are omitted. An inactive/nonselectable placement is
the last local fallback; remote fetch/actions can be unavailable there.

`ts_headline` produces a compact matching local body fragment with its selection
markers removed. Metadata is the fallback. Snippets are capped at 320 characters
and rendered as React text, with no raw HTML or trusted highlighting path.

## Header, overlay and reader navigation

The existing header retains branding/theme/current controls and adds a central
Lucide search input with placeholder `Search all mail...`. Search is debounced by
300 ms. Changing or clearing input aborts the obsolete request; late responses
cannot replace a newer query. Loading, failure and no-match states appear in the
middle pane. Result rows show account/mailbox context and safely display snippets.

The normal mailbox list and normal message selection remain underneath the search
overlay. Search keeps an independent result selection. The existing MessageReader
receives the result's account, placement and message IDs for detail/content,
HTML render, attachments, reply/reply-all/forward and message actions. Role lookup
and queued-action tracking use that result account as well.

Opening a cross-account result never changes the sidebar's selected account or
mailbox. Clearing search immediately restores the normal mailbox/list and its
previous message selection. Explicit account/mailbox/draft navigation exits
search and follows the user's chosen navigation. Search remains message-based even
when Conversation View is enabled; normal conversation behavior is unchanged.

## Performance and security verification

Search filtering and ranking run in PostgreSQL. The GIN predicate finds matching
documents; database sorting applies relevance/date/ID and a limit. Only bounded
hits are joined back to message bodies for snippets. Placement selection uses the
existing `mailbox_messages_message_idx`; there are no application N+1 queries or
in-memory filtering/pagination of the complete match set.

Focused integration tests use disposable PostgreSQL 18.6 databases and verify both
fresh migration and upgrade with preexisting local HTML. A fixture adds 30,000
synthetic messages/placements and runs VACUUM/ANALYZE, without forcing planner
settings. It asserts the GIN index is selected both for the FTS predicate and the
actual full endpoint query with a selective term. It also checks email, local-body
and common-term plans, and bounded common-term results. Broad searches may
legitimately use sequential scans. Normal PostgreSQL autovacuum/GIN pending-list
maintenance remains necessary after large ingestion.

The synthetic seed temporarily disables only the unrelated conversation-graph
trigger in its disposable database, restoring it immediately afterward; generated
FTS/index maintenance remains enabled. This measures search performance rather
than conversation construction or remote synchronization throughput. Regenerated
JSON plans and timing evidence are saved in ignored
`.search-results/performance.json`.

Security boundaries remain the Phase 2H owner API access, inert local HTML and
existing reader sandbox/privacy policy. Search uses bound SQL parameters, accepts
no account/mailbox scope, returns no raw database errors, caches no results, has
bounded input/output, and never executes or renders searchable HTML. The original
rich reader implementation and remote-image permission flow are unchanged.

Verification on supported Node 24.19.0 includes lint, web/worker typecheck, full
tests, production web/worker build and the Phase 2H browser security harness.
Focused tests cover global accounts/placements, searchable fields/tokenization,
local content availability/migration/update/delete, ranking/order, hostile inputs,
authentication/error handling, debounce/loading/empty/error states, safe snippet
display, cross-account reader context and mailbox restoration.

| Verification                                 | Result                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| Disposable fresh database and pre-2I upgrade | Passed, including historical plain/HTML local content                                |
| `pnpm lint`                                  | Passed                                                                               |
| `pnpm typecheck`                             | Passed, web and worker                                                               |
| `pnpm test`                                  | 538 tests passed in 50 files                                                         |
| `pnpm build`                                 | Passed, production web and worker                                                    |
| `pnpm test:security:browser`                 | Passed, no default remote-resource requests                                          |
| Query plans on 30,000 synthetic messages     | GIN confirmed for selective predicate and full endpoint                              |
| Desktop header inspection                    | 1440px browser snapshot; search input remains between branding and existing controls |
| `git diff --check`                           | Passed                                                                               |

## Known limitations

- Missing remote bodies remain unsearchable until normal on-demand content fetching
  stores them locally. There is no full-body indexing fetch/backfill.
- V1 returns the top 50 messages, with a refinement hint when more exist.
- Matching uses AND tokens, with no stemming, accent folding, fuzzy/prefix matching,
  Gmail-style filters or conversation-level aggregation.
- HTML-to-text extraction is deterministic and conservative; it does not compute
  browser layout or resolve every possible CSS cascade/media-query combination.
- Attachment contents/filenames and unsent local drafts are outside search scope.
- Existing configured text-part limits also bound the locally available body text.
