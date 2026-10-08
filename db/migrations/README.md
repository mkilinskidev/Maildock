# Database migrations

Migration files are append-only deployment history. Existing migrations must not be renamed or rewritten after they have shipped: Drizzle's journal, deployed databases, backup/recovery compatibility checks and historical release verification depend on that history remaining stable.

The early migrations were generated with Drizzle's automatic names. The names are odd, but the files are intentionally preserved. New migrations should use a short human-readable name.

## Historical migration index

| Migration | Purpose                                                          |
| --------- | ---------------------------------------------------------------- |
| 0000      | authentication and instance foundation                           |
| 0001      | mail accounts                                                    |
| 0002      | mailbox discovery and mailboxes                                  |
| 0003      | active mailbox path uniqueness                                   |
| 0004      | messages, mailbox placements and recent sync state               |
| 0005      | recent-sync UIDVALIDITY                                          |
| 0006      | persisted message content                                        |
| 0007      | incremental/delta sync checkpoints                               |
| 0008      | Microsoft OAuth account authorization                            |
| 0009      | historical metadata backfill state                               |
| 0010      | durable remote message commands                                  |
| 0011      | mailbox roles                                                    |
| 0012      | durable outgoing messages and immutable MIME snapshot            |
| 0013      | Sent-copy policy and state                                       |
| 0014      | reply/threading headers                                          |
| 0015      | blobs and attachment storage                                     |
| 0016      | local drafts and draft attachments                               |
| 0017      | conversations and conversation reconciliation                    |
| 0018      | remote-content sender preferences                                |
| 0019      | PostgreSQL full-text search                                      |
| 0020      | rich compose and inline resources                                |
| 0021      | signatures and signature defaults/resources                      |
| 0022      | sender display name                                              |
| 0023      | automatic read preference                                        |
| 0024      | desktop notification state/events                                |
| 0025      | application diagnostic events                                    |
| 0026      | database-backed OAuth provider configuration                     |
| 0027      | account ordering                                                 |
| 0028      | immutable owner binding                                          |
| 0029      | TOTP MFA foundation                                              |
| 0030      | authenticator replacement state                                  |
| 0031      | persistent authentication admission controls                     |
| 0032      | restore-safe search definitions and recovery maintenance receipt |
| 0033      | generated setup credential digest and web-process lease          |
| 0034      | host-authorized owner recovery and bounded MFA enrollment state  |

The numbered `meta/*_snapshot.json` files and `meta/_journal.json` are generated migration metadata and should remain aligned with the historical SQL files.
