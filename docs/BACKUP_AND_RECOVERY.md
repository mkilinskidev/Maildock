# Backup & recovery

## Lost owner credentials versus backup restore

For a running instance with lost owner password/authenticator/recovery codes, use the [interactive administrator command](INSTALLATION.md#break-glass-owner-recovery). Host/container administration is recovery authority. It preserves mail/application data and keys and requires new MFA. It does not perform restore fencing or replace mandatory maintenance below.

A backup may capture pending `owner_recovery`. Restore with ingress and all writers stopped, then run the usual mandatory `maintain` and `verify`. Maintenance invalidates restored browser enrollment authority but preserves the pending authenticator. Exit 2 means pending MFA. Private-file `resume-mfa` requires the new owner password; `complete-mfa` requires that password and pending TOTP, clears the marker, rotates recovery codes and produces a new receipt. Verify the receipt before reopening traffic. If the new password/pending factor is unavailable, perform mandatory maintenance first; keep public ingress closed while using `--restart-pending` and controlled browser enrollment. Never skip restore fencing because owner recovery is available.

Maildock recovery is deliberately conservative because persistent state spans PostgreSQL, filesystem blobs and cryptographic keys.

A PostgreSQL dump by itself is **not** a complete Maildock backup.

## Matched recovery set

A recoverable set contains the complete PostgreSQL database, complete attachment/blob root, matching `AUTH_SECRET`, every referenced credential-encryption key/key ID, effective configuration, and matching Maildock release/image/Compose/recovery helpers. Treat the entire set as confidential.

## Backup

Stop all application writers while capturing the set. Keep PostgreSQL running for logical dump:

```sh
docker compose stop app
mkdir -p /absolute/private/set

docker compose exec -T postgres sh -c '
  umask 077
  export PGPASSWORD="$POSTGRES_PASSWORD"
  pg_dump -h postgres -U "$POSTGRES_USER" -d "$POSTGRES_DB"     -Fc --no-acl -f /tmp/maildock-recovery.dump
'

docker compose cp postgres:/tmp/maildock-recovery.dump /absolute/private/set/database.dump

docker compose run --rm --no-deps --user 0 --entrypoint tar   -v /absolute/private/set:/recovery app   -cpf /recovery/attachments.tar -C /var/lib/maildock/attachments .
```

Check every exit code. Copy keys/config privately and record hashes, sizes, release/image identity, migration version, key IDs and volume mappings in a protected manifest. Preserve numeric ownership/modes for the complete blob root. Periodically prove recovery in disposable storage.

## Restore

Restore into fresh storage with ingress and writers stopped. Preserve the failed installation separately.

For current custom-format archives use `pg_restore --no-owner --no-acl --exit-on-error --single-transaction` against the fresh hardened database. Restore the complete attachment archive with ownership suitable for application UID/GID `1001:1001`.

Historical pre-0032 archives can contain search-function definitions that normal restore cannot safely reproduce. Use the packaged `scripts/postgres/maildock-restore-compatibility.sh` only for the exact historical archive shape it accepts. It refuses unknown layouts rather than guessing. Do not edit dumps or weaken database authority.

The compatibility helper pins two complete 32-migration histories: the recorded deployed baseline (`legacy-migrations.txt`) and its reviewed LF checkout (`legacy-migrations-lf.txt`). They differ only in five newline-sensitive hashes. Post-restore schema verification accepts either complete baseline followed by the exact current migration suffix. Mixed histories, unknown hashes, changed timestamps and missing or extra migrations are refused. Stored migration hashes and historical SQL files are never rewritten.

## Mandatory post-restore maintenance

A restored database can revive old sessions, recovery codes and queued remote work. Do not reopen Maildock just because import/readiness succeeds.

Use a dedicated POSIX operator directory owned by UID/GID 1001:1001, mode 0700. Output files are created privately. Never use logs/stdout/shared folders for recovery material.

Set `OWNER_USER_ID` to the immutable owner ID recorded in the protected backup manifest, then run:

```sh
docker compose run --rm --no-deps --entrypoint node   -v /absolute/private/operator:/operator app   dist-worker/composition/recovery-process.js maintain   --writers-stopped-recovery-set-verified "$OWNER_USER_ID" /operator/recovery.json

docker compose run --rm --no-deps --entrypoint node   -v /absolute/private/operator:/operator app   dist-worker/composition/recovery-process.js verify   --writers-stopped-recovery-set-verified "$OWNER_USER_ID" /operator/recovery.json
```

Maintenance verifies authority/schema, owner/MFA consistency, protected-state decryption and referenced blobs before mutation. It invalidates restored sessions/transient authorization state, rotates recovery codes and fences uncertain provider-side operations while preserving owner/password/TOTP and durable mail/blob/job data.

Exit 0 permits verification/startup; exit 1 refuses recovery; exit 2 means a pending authenticator replacement still blocks readiness. If maintenance must be repeated, use a new output filename because new recovery codes invalidate the previous set.

### Pending authenticator replacement

If restore captured an in-progress authenticator replacement, continuation requires the immutable owner's password and a valid TOTP from the pending authenticator. Password-only completion is not supported.

```sh
docker compose run --rm --no-deps --entrypoint node   -v /absolute/private/operator:/operator app   dist-worker/composition/recovery-process.js resume-mfa   --writers-stopped-recovery-set-verified "$OWNER_USER_ID"   /operator/pending-enrollment.json /operator/password-proof.json

docker compose run --rm --no-deps --entrypoint node   -v /absolute/private/operator:/operator app   dist-worker/composition/recovery-process.js complete-mfa   --writers-stopped-recovery-set-verified "$OWNER_USER_ID"   /operator/completed-recovery.json /operator/proof.json
```

Proof files are private local files; do not put password/TOTP proofs on command lines or ordinary environment variables. Run `verify` against the completed receipt before startup.

## Acceptance

Before reopening traffic verify hardened database authority, matching migrations, immutable owner/MFA consistency, required keys, blob integrity, completed maintenance, rejection of restored sessions/codes, fresh password+TOTP login, fresh recovery-code login, worker/pg-boss startup and readiness.

## Failed update rollback

Do not run an arbitrary old image against a forward-migrated database. Restore the complete matched pre-upgrade set into fresh storage with the matching old release/helpers, perform post-restore maintenance/verification, then start and verify the old release.

Provider-side effects cannot be rolled back by restoring local state; mail sent after the backup may remain sent even when restored local state predates it.
