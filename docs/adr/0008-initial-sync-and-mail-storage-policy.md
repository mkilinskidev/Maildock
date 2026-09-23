# ADR 0008: Initial synchronization and mail storage policy

- Status: accepted
- Date: 2026-09-23
- Supersedes: none
- Superseded by: none

## Context

The architecture requires an explicit initial usable-history window, progressive complete-history synchronization, sanitizer regeneration, and an attachment caching default before synchronization implementation begins.

## Decision

The default initial usable-history window is 30 days and remains configurable. Incremental/new-mail work has higher priority than historical backfill. Progress is reported per account using completed mailboxes plus discovered and processed message counts where the provider can supply a stable total; otherwise the UI reports an indeterminate resumable backfill phase rather than inventing a percentage.

V1 retains the original RFC 822/MIME source as a private, opaque object behind authenticated storage so parsing and sanitization can be repeated after parser or policy changes. Retention policy and optional pruning controls require operational review before production release.

Attachment metadata is synchronized with messages; binary attachment content remains on-demand by default. Threading uses provider-neutral `References` and `In-Reply-To` evidence within an account. Subject-only similarity is not identity and messages are never merged across accounts.

## Alternatives considered

- A permanent rolling window: rejected because V1 must converge to complete available history.
- Eagerly downloading every attachment: rejected because it delays initial usability and increases storage/network cost.
- Discarding raw MIME immediately: rejected because sanitizer-version regeneration and parser fixes need a trustworthy source representation.
- Cross-account or subject-only thread merging: rejected because headers are untrusted and identity boundaries must remain explicit.

## Consequences

- Storage planning must include raw MIME plus on-demand attachment cache data.
- Backfill jobs must be bounded, resumable, and lower priority than incremental work.
- Exact sanitizer allowlists and message UI remain Phase 1+ implementation work, not Phase 0 functionality.
