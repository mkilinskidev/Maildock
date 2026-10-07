# ADR 0009: Application-level mail credential encryption

- Status: accepted
- Date: 2026-09-24
- Supersedes: none
- Superseded by: none

## Context

Maildock must persist IMAP and SMTP passwords while keeping a PostgreSQL backup, database operator, or accidental query result from exposing plaintext provider credentials. The application also needs an explicit compatibility and key-rotation seam without deriving provider encryption from the owner's login password.

## Decision

Encrypt mail provider passwords in the application with Node.js `node:crypto` AES-256-GCM. Keys are 256 random bits supplied by deployment secret material and never stored in PostgreSQL. Configuration names one active key and may retain previous identified keys for decryption during a controlled rotation period. Startup fails when the active identifier is unsupported, a configured key is missing or malformed, or any key does not decode from canonical base64 to exactly 32 bytes. Maildock never generates a replacement during normal startup.

Each encryption uses a fresh, random 96-bit IV and an explicit 128-bit authentication tag. The persisted JSON envelope is runtime-validated and contains:

```json
{
  "version": 1,
  "algorithm": "AES-256-GCM",
  "keyId": "v1",
  "iv": "base64",
  "ciphertext": "base64",
  "authTag": "base64"
}
```

IMAP and SMTP passwords are encrypted independently. Additional Authenticated Data is UTF-8 encoded using these exact persisted compatibility contracts:

```text
maildock:account-credential:v1:<account-id>:imap
maildock:account-credential:v1:<account-id>:smtp
```

When SMTP logically uses the IMAP credentials, only the IMAP secret is stored and decrypted. Authentication or envelope validation failures fail closed as a sanitized internal credential error; cryptographic details never cross the HTTP boundary.

Rotation is deliberately operational in Phase 1A: add the old and new keys to available configuration, make the new identifier active, restart, then re-encrypt stored credentials with fresh IVs before removing the old key. The envelope key identifier selects the decryption key. A rotation UI or background rotation job is deferred.

## Alternatives considered

- Database-only encryption: rejected because storing the key beside ciphertext does not protect database backups or database-level access.
- Deriving a key from the owner password: rejected because password changes and recovery would endanger provider credentials and password-derived entropy is inappropriate for this root key.
- Deterministic or convergent encryption: rejected because it leaks equality and is unnecessary.
- One combined password blob: rejected because separate purpose-bound envelopes prevent valid ciphertext from being transplanted between IMAP and SMTP contexts.
- A custom cipher or protocol: rejected in favor of the standard authenticated-encryption primitive in Node.js.

## Consequences

- Database rows and backups contain authenticated ciphertext, not plaintext passwords.
- The deployment encryption keys are indispensable backup material. A PostgreSQL backup cannot recover provider credentials without the matching key; losing it requires reconfiguring affected accounts.
- Account identifiers and the AAD format become persisted compatibility contracts.
- Key rotation can retain old-key decryptability, but Phase 1A requires an operator-controlled re-encryption step.
