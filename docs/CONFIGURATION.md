# Configuration

Maildock validates application configuration at process startup. Invalid required values fail closed instead of silently falling back.

The base Docker Compose file deliberately exposes only the small set of values needed for a normal deployment. Keep `.env` private; rendered Compose configuration can contain secrets too. Advanced application settings remain supported by the application but should be supplied only through a reviewed Compose override or platform-specific container configuration.

## Required production values

| Variable | Purpose |
| --- | --- |
| `APP_ORIGIN` | Exact canonical browser origin. Production requires HTTPS and no path/query/fragment. |
| `POSTGRES_PASSWORD` | Password for the bundled PostgreSQL application login. Compose builds `DATABASE_URL` from it. |
| `AUTH_SECRET` | Better Auth / MFA secret material. Must decode from base64 to at least 32 bytes. Preserve it for backup/recovery. |
| `CREDENTIALS_ENCRYPTION_KEY` | Active AES-256-GCM master key. Canonical base64 of exactly 32 bytes. Preserve it for backup/recovery. |
| `MAILDOCK_BOOTSTRAP_SECRET` | First-run owner authorization only. Canonical base64 of exactly 32 bytes. Remove after successful initialization. |

Generate independent random values for the three base64 secrets:

```sh
openssl rand -base64 32
```

Never reuse one value for multiple purposes.

## Core settings

| Variable | Default / base Compose behavior | Notes |
| --- | --- | --- |
| `MAILDOCK_ENV` | `production` in base Compose | The development Compose override changes this to `development`. |
| `DATABASE_URL` | built by Compose | Internal connection to the bundled PostgreSQL service. |
| `ATTACHMENTS_PATH` | `/var/lib/maildock/attachments` | Internal persistent attachment path. |
| `CREDENTIALS_ENCRYPTION_KEY_ID` | `v1` | Internal initial key identifier. Change only as part of a reviewed key-rotation procedure. |
| `CREDENTIALS_ENCRYPTION_PREVIOUS_KEYS` | `{}` | Used only during a reviewed key-rotation procedure. |

Microsoft and Google OAuth providers are configured in **Settings → Integrations → OAuth providers**. The base Compose deployment does not expose provider credentials as deployment variables.

Google OAuth has no Google-specific environment variables. Configure it in **Settings → Integrations → OAuth providers**.

## Synchronization and runtime tuning

| Variable | Default | Accepted range / meaning |
| --- | ---: | --- |
| `DATABASE_POOL_SIZE` | 10 | 1–50, per postgres-js process |
| `WORKER_CONCURRENCY` | 5 | 1–50, discovery/runtime worker tuning; not a universal queue concurrency limit |
| `MAILDOCK_INITIAL_SYNC_DAYS` | 30 | 1–365 days in the initial recent window |
| `MAILDOCK_MESSAGE_FETCH_BATCH_SIZE` | 150 | 10–500 |
| `MAILDOCK_BACKFILL_CHUNK_SIZE` | 500 | 1–5000 |
| `MAILDOCK_MESSAGE_SYNC_CONCURRENCY` | 2 | 1–10 |
| `MAILDOCK_MAIL_POLL_INTERVAL_SECONDS` | 300 | 30–3600 |
| `MAILDOCK_CONTENT_POLL_INTERVAL_MS` | 400 | 100–2500; message-reader readiness polling |
| `MAILDOCK_MAX_MESSAGE_TEXT_PART_BYTES` | 5242880 | 1 KiB–20 MiB |

These are advanced overrides, not normal deployment inputs. The base Compose file intentionally does not declare them, so application defaults apply. Supply an override only when an installation has a measured reason to tune a value. An explicitly empty numeric value is invalid.

## Attachment and MIME limits

All values are bytes.

| Variable | Default | Maximum |
| --- | ---: | ---: |
| `MAILDOCK_MAX_ATTACHMENT_BYTES` | 15728640 (15 MiB) | 100 MiB |
| `MAILDOCK_MAX_OUTGOING_ATTACHMENT_BYTES` | 18874368 (18 MiB) | 100 MiB |
| `MAILDOCK_MAX_OUTGOING_MIME_BYTES` | 26214400 (25 MiB) | 150 MiB |

The MIME limit includes transfer encoding and headers.

## Container role

The image defaults to `MAILDOCK_ROLE=all`: web and worker start together after migration.

Custom deployments may set:

- `all`
- `web`
- `worker`

The base two-service Compose stack intentionally runs `all`. Splitting roles is an advanced deployment override and must preserve migration ordering, health checks, writer shutdown and recovery procedures.

## Credential encryption keys

Mail account passwords, OAuth provider secrets and durable OAuth authorization state are encrypted with application-level AES-256-GCM. The envelope records the key ID, so old keys may be retained temporarily:

```dotenv
CREDENTIALS_ENCRYPTION_KEY_ID=v2
CREDENTIALS_ENCRYPTION_KEY=<new-key>
CREDENTIALS_ENCRYPTION_PREVIOUS_KEYS={"v1":"<old-key>"}
```

Do not remove an old key while stored envelopes still reference it. Maildock has the multi-key decryption seam but does not currently provide a one-click key-rotation job; rotation must be a reviewed operator procedure.

Losing a required credential key makes the corresponding stored secrets unrecoverable. Losing/changing `AUTH_SECRET` invalidates protected authentication/MFA state. Back up both as part of the matched recovery set.
