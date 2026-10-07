# F7: owner username compatibility

Date: 2026-10-05. Baseline: `685130968c463fd92f115695c31291c49e2d09aa`, including F1/F3 commits `e2363cd334a0337e08271f09bd7e414a0f7182ca` and `d84603e0c0868b92b93c266b23d0630620a65662`.

## Installed Better Auth 1.7.5 behavior

The authoritative files inspected were `node_modules/better-auth/dist/plugins/username/index.mjs`, `index.d.mts`, and `schema.mjs`. No online documentation or dependency modifications were used.

- The actual default validator is `/^[a-zA-Z0-9_.]+$/`: ASCII letters, digits, dot and underscore; no hyphen. The type documentation describes alphanumeric characters and underscores, omitting the dot supported by the implementation.
- Default length is 3–30. Maildock already overrides it to 3–64, so length was not the F7 mismatch.
- Default username normalization is `toLowerCase()`, without trimming. Both database hooks/schema input transforms and sign-in lookups use the normalizer. ASCII case variants resolve to the same stored lowercase identity.
- Supported options include `usernameValidator` (synchronous or asynchronous), `usernameNormalization`, and minimum/maximum length. A custom validator is used for sign-in, availability checks, signup/update HTTP hooks, and user create/update database hooks. Maildock's direct transactional setup writes do not execute these Better Auth hooks.
- With Maildock's unspecified `validationOrder`, validation is on the input spelling, followed by normalization for lookup/storage. A source nuance: create/update validation normalizes first only for explicit `post-normalization`, whereas sign-in normalizes first only for explicit `pre-normalization`; availability validates raw input. This fix leaves `validationOrder` unspecified. ASCII case does not change grammar membership or length.
- `displayUsername` is a separate optional field, enabled by default. Its normalization preserves spelling by default and no validator is applied unless configured. It is not a login lookup key. Signup/create can derive it from the original username. Maildock supplies it directly during setup.
- `immutableUsername: true` rejects a change to an existing normalized username through `/update-user`, while the same canonical spelling is allowed. It does not affect sign-in validation, make display spelling immutable, or prevent direct database writes. Maildock's HTTP allowlist also blocks `/update-user` entirely.

## Root cause and contract

Setup accepted `/^[a-zA-Z0-9_.-]+$/` after trimming and wrote the owner, credential and initialized state directly in a transaction. Sign-in then ran Better Auth's default validator before password verification. A persisted owner such as `my-owner` was therefore rejected with HTTP 422 even with the correct password, while setup was already closed.

The shared contract in `src/modules/auth/domain/owner-username.ts` retains 3–64 characters from ASCII letters, digits, dot, underscore and hyphen. Canonical normalization is lowercase; display spelling remains intact. Setup retains its existing surrounding-whitespace trimming before validation. Login retains its existing lack of trimming; whitespace is not an additional identity alias. No Unicode or additional punctuation is accepted.

## Username-flow inventory

| Location                                                     | Role                                                                                                                                                                                                                                            |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/components/setup-form.tsx`                              | Sends original form input to setup; HTML length limits now use shared constants; help text states allowed characters.                                                                                                                           |
| `src/app/api/setup/route.ts`                                 | Bounded JSON/native-form input, Origin check, delegates to provisioning; schema errors become HTTP 400.                                                                                                                                         |
| `src/modules/auth/application/instance-auth.ts`              | Authorizes bootstrap, trims and validates before Argon2; lowercases for duplicate lookup and persistence; inserts original spelling as `name` and `displayUsername`; creates the `credential` account and initialized state atomically.         |
| `src/modules/auth/domain/owner-username.ts`                  | Single schema, length constants, validator and lowercase normalizer.                                                                                                                                                                            |
| `src/shared/infrastructure/database/schema.ts`               | Text `username` and `display_username`, unique index on canonical username, credential account storage. Initial migration `0000_dazzling_johnny_storm.sql` has the same text fields/index; no narrower grammar constraint.                      |
| `src/modules/auth/infrastructure/auth-factory.ts`            | Shared validator, normalizer and limits configure the real username plugin; signup disabled and username immutable.                                                                                                                             |
| `src/modules/auth/infrastructure/auth.ts`                    | Instantiates that factory against the configured database.                                                                                                                                                                                      |
| `src/components/login-form.tsx`                              | Sends raw username/password to `/api/auth/sign-in/username`; no independent username grammar or case transform.                                                                                                                                 |
| `src/app/api/auth/[...all]/route.ts`                         | Allows username sign-in, passes authentication to Better Auth; uses submitted username for backoff; does not duplicate validation.                                                                                                              |
| `src/modules/auth/infrastructure/login-throttle.ts`          | Hashes trimmed lowercase input for the backoff key; this is a throttle bucket, not identity lookup or persistence. Unchanged.                                                                                                                   |
| Better Auth installed username plugin                        | Validates, looks up canonical username, finds credential account, verifies password, and returns username/display fields in authentication/session data.                                                                                        |
| `src/modules/auth/application/session*.ts`, `api-access*.ts` | Consume the authenticated session; no additional username grammar or username-based owner lookup.                                                                                                                                               |
| Existing tests/fixtures                                      | Owner setup/login in `phase0.integration.test.ts`, security bootstrap/authorization/mutation-policy integration tests, `bootstrap-process.ts`, and `pipeline.ts`; predominantly simple ASCII usernames. None enforce a narrower owner contract. |

No application UI currently renders a persisted owner `username`/`displayUsername` beyond the auth forms. Original spelling remains available as `name` and `displayUsername` in stored/auth-returned data. IMAP/SMTP usernames in account schemas, provider code, forms and fixtures are separate mail-server credentials and were excluded from this change. Microsoft OAuth account usernames and URL userinfo validation are also unrelated to the instance owner.

## Implementation and existing installations

Setup imports the shared schema and normalizer. Better Auth imports the shared validator, normalizer and limits through its supported plugin API. The setup form imports the same length constants. Authentication remains entirely inside Better Auth, including credential lookup and Argon2 verification.

Previously valid setup always persisted `username` as trimmed lowercase ASCII and `name`/`displayUsername` as the trimmed original spelling. All such values remain inside the new contract. In particular, `my-owner`, `owner.name`, `owner_name`, and `Owner-01` work without recreating the owner or database. The unique index continues to apply to the same lowercase identity. No usernames, account IDs, hashes, database schema, or initialization records need migration.

Bootstrap authorization, rate limiting, advisory locks, initialized-state checks, secret handling, signup restrictions, password verification, sessions, login throttling, and Origin/CSRF settings were reviewed and preserved. No MFA, recovery, owner binding, OAuth or deployment behavior was changed.

## Regression evidence

`tests/security/owner-username.integration.test.ts` adds 28 tests using real Better Auth 1.7.5, real Argon2, and a disposable migrated PostgreSQL 18.6 container. Only application composition singletons are substituted; a call-through hash spy measures rejected setup work.

- Setup and real HTTP login succeed for `owner`, `my-owner`, `owner.name`, `owner_name`, `Owner-01`, a three-character username, and a 64-character username.
- Original/lowercase/uppercase spellings return the same owner ID and canonical username; original display spelling and credential account linkage are asserted.
- Old owner rows are constructed independently using the previous persistence convention, marked initialized, and authenticated without changing the user row. Setup remains closed.
- Ten invalid inputs test short/long lengths, whitespace within the name, unsupported punctuation and Unicode. They cause no Argon2 hash, owner/account insert, or instance initialization during setup and are rejected on login.
- Setup trimming is preserved; surrounding whitespace does not become a login alias.
- Wrong passwords fail; per-username backoff shares the same bucket across case variants; Better Auth's ten-attempt login limit still applies.
- Signup remains disabled inside Better Auth and blocked by the route. Username changes are rejected by the plugin and the route allowlist.

## Validation

All validation used the available Node 24.19.0 runtime, which satisfies the project's Node 24 requirement (the terminal default is Node 22.22.3).

| Check                                                        | Result                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused F7 integration file                                  | 28/28 tests passed.                                                                                                                                                                                                                                                           |
| `vitest run tests/security tests/phase0.integration.test.ts` | 127/127 tests in 7 files passed, including F1/F3 bootstrap and F4 Origin/authentication regressions.                                                                                                                                                                          |
| `pnpm test`                                                  | 934/934 tests in 78 files passed.                                                                                                                                                                                                                                             |
| `pnpm typecheck`                                             | Passed for application and worker.                                                                                                                                                                                                                                            |
| `pnpm lint`                                                  | Passed with no errors; one existing unused `writeFile` warning in unchanged `.security-results/signature-settings-preview.mjs:3`.                                                                                                                                             |
| `pnpm build`                                                 | Passed, including Next.js production build and worker compilation/import fixup, with process-only `APP_ORIGIN=https://maildock.example.com`. Initial attempt failed because the local `.env` HTTP origin violates production configuration validation. `.env` was not edited. |
| Changed-file Prettier and `git diff --check`                 | Passed.                                                                                                                                                                                                                                                                       |

F7 can be considered **CLOSED** for the inspected baseline and owners provisioned under the established Maildock setup contract.

## Scope and remaining assumptions

No additional vulnerability was confirmed during this F7 investigation. Existing installations are assumed to have owner records produced by the previously valid Maildock setup behavior, not manually edited/noncanonical database identities. No claim is made about repairing manual corruption. This fix is tied to the inspected Better Auth 1.7.5 behavior; future dependency upgrades should retain these integration regressions.

Changes remain uncommitted; no amend or push was performed.
