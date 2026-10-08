# Configuration

Maildock validates application configuration at process startup. Invalid required values fail closed instead of silently falling back.

Maildock intentionally separates **deployment inputs** from **advanced environment overrides**. A normal Docker Compose or Coolify installation needs only the deployment values below. The application still supports the documented advanced variables, but the base Compose file does not declare them; add them explicitly through a reviewed Compose override or platform-specific container configuration only when you need to change a default.

Keep environment configuration private. Rendered Compose configuration and platform environment screens can contain secrets.

## Normal production deployment

These are the only operator-supplied variables expected for a standard production installation.

| Variable                     | Required | Default | Purpose                                                                                                                                                                                                                   |
| ---------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ORIGIN`                 | yes      | —       | Exact canonical browser origin. Production requires HTTPS and no path, query, fragment, or embedded credentials.                                                                                                          |
| `POSTGRES_PASSWORD`          | yes      | —       | Password for Maildock's bundled PostgreSQL service. The application connects to the fixed internal `postgres:5432/maildock` endpoint as `maildock`; arbitrary passwords, including URL-special characters, are supported. |
| `AUTH_SECRET`                | yes      | —       | Better Auth / MFA secret material. Base64 value decoding to at least 32 bytes. Preserve it for backup/recovery.                                                                                                           |
| `CREDENTIALS_ENCRYPTION_KEY` | yes      | —       | Active AES-256-GCM master key. Canonical base64 of exactly 32 bytes. Preserve it for backup/recovery.                                                                                                                     |

Generate `AUTH_SECRET` and `CREDENTIALS_ENCRYPTION_KEY` independently:

```sh
openssl rand -base64 32
```

Never reuse one secret for another purpose.

Maildock automatically generates a temporary setup secret for a fresh instance and prints it in the active web container logs. It is not a deployment variable. See [First-run owner setup](INSTALLATION.md#first-run-owner-setup) for log retrieval and restart behavior.

For Coolify and similar platforms, this four-variable set is the normal deployment interface. Variables generated internally by the platform, such as service URL/FQDN metadata, are not Maildock configuration.

## Base Compose internal settings

The production Compose file supplies these values itself. Operators normally should not add or change them.

| Variable                               | Base value                      | Purpose                                                                                         |
| -------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `NODE_ENV`                             | `production`                    | Node/Next.js production mode.                                                                   |
| `MAILDOCK_ENV`                         | `production`                    | Maildock security mode. The development Compose override changes this to `development`.         |
| `ATTACHMENTS_PATH`                     | `/var/lib/maildock/attachments` | Internal persistent attachment path.                                                            |
| `CREDENTIALS_ENCRYPTION_KEY_ID`        | `v1`                            | Initial active encryption-key identifier. Change only during a reviewed key-rotation procedure. |
| `CREDENTIALS_ENCRYPTION_PREVIOUS_KEYS` | `{}`                            | Previous key map used only during controlled key rotation.                                      |

`POSTGRES_DB=maildock` and `POSTGRES_USER=maildock` are also fixed by the bundled PostgreSQL service and are not deployment inputs.

> **Deployment boundary:** Maildock supports only the PostgreSQL 18 service bundled with the official Docker Compose stack. External, managed, shared, or independently provisioned PostgreSQL instances are unsupported. Maildock owns database roles, ownership, authority hardening, migrations, pg-boss state, and recovery invariants; these are part of the application's security model, not replaceable infrastructure.

Microsoft and Google OAuth providers should be configured in **Settings → Integrations → OAuth providers**. Provider client IDs and secrets are intentionally absent from the normal Compose deployment interface.

## Advanced environment overrides

The variables in the following sections are supported by the application, but are **not declared by the base production Compose file**. If omitted, Maildock uses the defaults shown below. Add one only when you deliberately need to override its default.

An explicitly empty numeric variable is invalid; either omit it or provide a valid value.

### Runtime and synchronization tuning

| Variable                               | Default | Accepted range / meaning                                                       |
| -------------------------------------- | ------: | ------------------------------------------------------------------------------ |
| `LOG_LEVEL`                            |  `info` | `fatal`, `error`, `warn`, `info`, `debug`, or `trace`                          |
| `DATABASE_POOL_SIZE`                   |      10 | 1–50, per postgres-js process                                                  |
| `WORKER_CONCURRENCY`                   |       5 | 1–50, discovery/runtime worker tuning; not a universal queue concurrency limit |
| `MAILDOCK_INITIAL_SYNC_DAYS`           |      30 | 1–365 days in the initial recent window                                        |
| `MAILDOCK_MESSAGE_FETCH_BATCH_SIZE`    |     150 | 10–500                                                                         |
| `MAILDOCK_BACKFILL_CHUNK_SIZE`         |     500 | 1–5000                                                                         |
| `MAILDOCK_MESSAGE_SYNC_CONCURRENCY`    |       2 | 1–10                                                                           |
| `MAILDOCK_MAIL_POLL_INTERVAL_SECONDS`  |     300 | 30–3600 seconds                                                                |
| `MAILDOCK_CONTENT_POLL_INTERVAL_MS`    |     400 | 100–2500 ms; message-reader readiness polling                                  |
| `MAILDOCK_MAX_MESSAGE_TEXT_PART_BYTES` | 5242880 | 1 KiB–20 MiB                                                                   |

### Attachment and MIME limits

All values are bytes.

| Variable                                 |           Default | Accepted range |
| ---------------------------------------- | ----------------: | -------------- |
| `MAILDOCK_MAX_ATTACHMENT_BYTES`          | 15728640 (15 MiB) | 1 KiB–100 MiB  |
| `MAILDOCK_MAX_OUTGOING_ATTACHMENT_BYTES` | 18874368 (18 MiB) | 1 KiB–100 MiB  |
| `MAILDOCK_MAX_OUTGOING_MIME_BYTES`       | 26214400 (25 MiB) | 1 KiB–150 MiB  |

The outgoing MIME limit includes transfer encoding and headers.

### Example advanced override

For a Compose deployment, advanced settings belong in an explicit override rather than in the base Maildock Compose file:

```yaml
services:
  app:
    environment:
      LOG_LEVEL: debug
      MAILDOCK_INITIAL_SYNC_DAYS: "90"
      WORKER_CONCURRENCY: "8"
```

On a platform that supports additional container environment variables, the equivalent values may be supplied there. Do not copy every supported variable into the deployment: unspecified values intentionally use Maildock defaults.

## Container role

The image defaults to `MAILDOCK_ROLE=all`: web and worker start together after migration.

Custom deployments may set:

- `all`
- `web`
- `worker`

The base two-service Compose stack intentionally runs `all`. Splitting roles is an advanced deployment override and must preserve migration ordering, health checks, writer shutdown and recovery procedures.

## Credential encryption key rotation

Mail account passwords, OAuth provider secrets and durable OAuth authorization state are encrypted with application-level AES-256-GCM. The envelope records the key ID, so old keys may be retained temporarily:

```dotenv
CREDENTIALS_ENCRYPTION_KEY_ID=v2
CREDENTIALS_ENCRYPTION_KEY=<new-key>
CREDENTIALS_ENCRYPTION_PREVIOUS_KEYS={"v1":"<old-key>"}
```

Do not remove an old key while stored envelopes still reference it. Maildock has the multi-key decryption seam but does not currently provide a one-click key-rotation job; rotation must be a reviewed operator procedure.

Losing a required credential key makes the corresponding stored secrets unrecoverable. Losing or changing `AUTH_SECRET` can invalidate protected authentication/MFA state. Back up both as part of the matched recovery set.

## Authentication secret (`AUTH_SECRET`)

`AUTH_SECRET` is Maildock's long-lived **Better Auth cryptographic secret**, not the temporary first-run setup secret and not the key that encrypts saved mail-account credentials. Maildock passes it to Better Auth as the `secret` option. Better Auth uses its secret for authentication-related signing, encryption and hashing; in Maildock this includes protection of MFA material managed by the Better Auth two-factor plugin.

Maildock stores sessions in PostgreSQL and explicitly disables Better Auth's cookie session cache. Therefore **do not assume that replacing `AUTH_SECRET` automatically revokes every existing database-backed session**. Use the application's session-revocation and offline recovery procedures when revocation is required; see [Security](SECURITY.md) and [Backup & recovery](BACKUP_AND_RECOVERY.md).

Generate `AUTH_SECRET` independently from `CREDENTIALS_ENCRYPTION_KEY`, keep it stable across restarts and deployments, and preserve it securely alongside the matching database backup. An unplanned replacement or loss can prevent access to encrypted MFA material and disrupt authentication; simply substituting a new value is **not** a supported owner/MFA recovery procedure. Maildock does not document or provide a tested, non-disruptive `AUTH_SECRET` rotation workflow. Do not assume upstream Better Auth versioned-secret rotation features are configured in this application.

The generated **setup secret** has a separate, short-lived role: it proves access to a fresh deployment during owner creation and initial MFA enrollment, and is retired after MFA setup. It is never a replacement for `AUTH_SECRET`.

## Legacy Microsoft OAuth environment variables

The application still accepts `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` as legacy/bootstrap compatibility inputs. They are not part of the supported normal deployment workflow for new installations. Configure Microsoft OAuth through **Settings → Integrations → OAuth providers** instead.
