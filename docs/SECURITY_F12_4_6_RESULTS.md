# F12-04 and F12-06 production remediation results

## 1. Baseline and scope

Baseline: `43d791b05456b9e30a267886db1a2929663c091a`
(`security: establish verified backup and recovery`). Worktree was initially
clean. This session addresses only the two remaining original LOW findings,
F12-04 and F12-06. No commit, push or deployment was performed. Existing running
`maildock-app-1` and `maildock-postgres-1` were not modified. All runtime validation
used uniquely named disposable resources and synthetic credentials.

## 2. F12-04 reproduction on current HEAD

Built the actual baseline Dockerfile as `maildock-f12-46-before`. Inspected the
final image filesystem as UID/GID 1001:1001, including package manifests under
the physical pnpm virtual store, rather than relying on `pnpm list --prod`.
TypeScript 6.0.3, Vitest 5.0.1, tsx 4.23.15 and drizzle-kit 0.31.11 contained real
package files despite removal of their top-level development links.

The BEFORE inventory is saved in
`.security-results/f12-46/baseline-inventory.json`; the initial metadata/link
graph in `before.json`; an independent exported prune-stage inventory in
`pruned.json`. A fresh production install with the original pnpm 12.6.0 was also
tested (`fresh-pnpm126.json`, `prod-install.log`) and reproduced the same retained
development peers. Therefore replacing prune with a fresh install alone would
not close the finding.

## 3. Root cause and package classification

The frozen lockfile records optional peer providers as snapshot edges.
Better Auth's package metadata declares optional peers `vitest` and `drizzle-kit`;
Lexical packages declare the optional peer `typescript`. Those providers are
project devDependencies. pnpm 12.6.0 follows their snapshot edges during both
`prune --prod` and fresh `install --prod`, retaining the providers and their
transitive tools. drizzle-kit brings tsx and esbuild; Vitest brings Vite,
assertion/test utilities and native bundler packages. This is graph retention,
not just an empty directory whose name happens to contain a dev package version.

The upstream fix is documented in
[pnpm 12.7.0 release notes](https://github.com/pnpm/pnpm/releases/tag/v12.7.0)
and [the optional-peer fix](https://github.com/pnpm/pnpm/pull/15411). It omits
dev-provided optional peers while retaining required and auto-installed peers.

Classification boundaries:

- Production roots are exactly the 30 `dependencies` in `package.json`, listed
  below. Their required/transitive production packages remain installed.
- Confirmed development providers and their payload are removed: TypeScript,
  Vitest, drizzle-kit, tsx and the associated development graph. The physical
  BEFORE/AFTER difference is 50 package/version instances, listed below.
- Peer-version suffixes in remaining pnpm slot names and lockfile metadata are
  not package payload. Retained Lexical slot names can mention `typescript`, and
  Better Auth slot names can mention `vitest`/`drizzle-kit`; their package files
  and provider links are absent after remediation.
- Babel is retained conservatively. `styled-jsx` has optional-peer metadata and
  the lockfile supplies an auto-installed `@babel/core`; it is not a project
  devDependency. Hoisted pnpm links make its payload available. A traversal that
  checks only published `peerDependencies` misses this metadata/snapshot edge,
  so the preliminary `reachable: false` result is not proof of dev-only content.
  The same caution applies to `@lexical/devtools-core`, which is a real Lexical
  production transitive dependency, and native SWC/sharp production optionals.
- The `/pnpm/store` content-addressable cache belongs to build stages/cache
  mounts and is not copied to runtime. The copied `.pnpm` directory is the
  installed physical virtual store, not merely package-manager cache metadata.
- Compiled recovery commands, SQL/migration files and supported shell helpers
  are intentional runtime/operator tooling and remain available. Inherited OS
  shell/core utilities and Node image tools were not removed.

## 4. F12-04 implementation

`production-dependencies` starts from `base`, copies only manifests, the lockfile
and patches, then runs `pnpm install --prod --frozen-lockfile`. It no longer
inherits the development installation. Dockerfile and `packageManager` pin
pnpm 12.7.0, the first release containing the required optional-peer fix.

Only the package-manager document in the multi-document `pnpm-lock.yaml` changed.
The application dependency document is byte-for-byte identical after normalizing
line endings; all application/transitive versions, resolutions, patch hashes,
workspace settings and patch files are unchanged. Frozen installs remain enforced.

The runtime receives the fresh dependency artifact and Next standalone
`server.js`, `package.json` and `.next`, plus static/public files. Standalone's
root dependency copy no longer overlays that artifact. The inspected baseline
standalone trace did not itself contain the four confirmed dev providers; the
reproduced cause is pnpm's optional-peer filtering. Selective copying gives the
runtime one explicit dependency artifact rather than two overlapping trees.
Compiled worker/migrator/recovery output, `db` and all packaged recovery helpers
remain copied. No runtime install, TypeScript compilation or network fetch is
introduced.

## 5. BEFORE/AFTER final image inventory

The AFTER image was built from scratch with `docker build --no-cache`, using
the actual production Dockerfile. The BuildKit pnpm cache mount can reuse verified
package content, but no Docker instruction layer was reused. Next build and
worker compilation succeeded with Node 24.21.0 and pnpm 12.7.0.

| Measurement                                       |    BEFORE |     AFTER |     Reduction |
| ------------------------------------------------- | --------: | --------: | ------------: |
| Docker `image inspect .Size`, bytes               | 250115877 | 200966407 |      49149470 |
| Docker Desktop displayed total image storage      |   1.27 GB |   1.04 GB | about 0.23 GB |
| `du -sb /app/node_modules`, bytes                 | 585663621 | 473761227 |     111902394 |
| `du -sb /app/node_modules/.pnpm`, bytes           | 585589677 | 473700804 |     111888873 |
| Physical package manifests                        |       295 |       245 |            50 |
| Original four confirmed dev providers             |         4 |         0 |             4 |
| Representative dev/tool package instances checked |        12 |         0 |            12 |

Docker Desktop's containerd image-storage display and `.Size` use different
accounting; neither should be confused with logical filesystem `du -sb` bytes.
The directly comparable daemon size decreased by 19.65%; node_modules by 19.11%.

BEFORE image ID:
`sha256:88fbc26f852b427743c41f3d248000ee3d706bd869c83c81405c3cfe122c8f97`.
AFTER image ID:
`sha256:10e00929509902858c28f0aeabcfd17ad13141f988d8491719b06ec3f10d7bc0`.
Complete manifest/version/path inventories are saved as `baseline-inventory.json`
and `final-inventory.json` under `.security-results/f12-46`.

Expected production roots (resolved baseline versions, preserved AFTER):

- `@azure/msal-node@7.0.0`
- `@better-auth/utils@0.4.2`
- `@lexical/extension@0.52.0`
- `@lexical/history@0.52.0`
- `@lexical/link@0.52.0`
- `@lexical/list@0.52.0`
- `@lexical/react@0.52.0`
- `@lexical/rich-text@0.52.0`
- `@lexical/selection@0.52.0`
- `@lexical/table@0.52.0`
- `@lexical/utils@0.52.0`
- `@node-rs/argon2@2.2.1`
- `better-auth@1.7.5`
- `dompurify@3.4.16`
- `drizzle-orm@0.45.3`
- `imapflow@2.0.6`
- `jsdom@30.1.1`
- `lexical@0.52.0`
- `lucide-react@1.48.0`
- `mailparser@3.9.28`
- `next@16.3.6`
- `nodemailer@10.0.10`
- `pg-boss@12.33.7`
- `pino@10.3.1`
- `postcss@8.5.28`
- `postgres@3.4.9`
- `qrcode.react@4.2.0`
- `react@19.3.0`
- `react-dom@19.3.0`
- `zod@4.6.5`

All removed package/version instances:

- `@drizzle-team/brocli@0.10.2`
- `@esbuild-kit/core-utils@3.3.2`
- `@esbuild-kit/esm-loader@2.6.5`
- `@esbuild/linux-x64@0.18.20`
- `@esbuild/linux-x64@0.25.12`
- `@esbuild/linux-x64@0.28.2`
- `@oxc-project/types@0.150.0`
- `@rolldown/binding-linux-x64-gnu@1.2.9`
- `@rolldown/pluginutils@1.0.1`
- `@types/chai@5.2.3`
- `@types/deep-eql@4.0.2`
- `@types/estree@1.0.9`
- `@types/node@24.10.9`
- `@vitest/mocker@5.0.1`
- `@vitest/spy@5.0.1`
- `assertion-error@2.0.1`
- `buffer-from@1.1.2`
- `chai@6.2.2`
- `drizzle-kit@0.31.11`
- `es-module-lexer@2.3.2`
- `esbuild@0.18.20`
- `esbuild@0.25.12`
- `esbuild@0.28.2`
- `estree-walker@3.0.3`
- `expect-type@1.4.0`
- `fdir@6.5.0`
- `get-tsconfig@4.14.3`
- `jiti@2.7.0`
- `lightningcss-linux-x64-gnu@1.33.0`
- `lightningcss@1.33.0`
- `magic-string@1.4.1`
- `obug@2.2.1`
- `picomatch@4.0.7`
- `resolve-pkg-maps@1.0.0`
- `rolldown@1.2.9`
- `siginfo@2.0.0`
- `source-map-support@0.5.21`
- `source-map@0.6.1`
- `stackback@0.0.2`
- `std-env@4.2.0`
- `tinybench@6.1.4`
- `tinyexec@1.3.0`
- `tinyglobby@0.2.17`
- `tsx@4.23.15`
- `typescript@6.0.3`
- `undici-types@7.16.0`
- `vite@8.3.0`
- `vitest@5.0.1`
- `why-is-node-running@2.3.0`
- `yaml@2.9.1`

## 6. Required runtime dependency verification

`tests/security/f12-runtime-dependencies.mjs` executes in the final image with
`--network none`. Every production root has package metadata and a resolvable
entrypoint (Lexical React uses its documented subpath). Actual imports succeeded
for Better Auth/plugins, Better Auth OTP utilities, Azure MSAL, pg-boss,
postgres-js, Drizzle, ImapFlow, Nodemailer, Mailparser, DOMPurify, jsdom, Argon2 and
Next. A native Argon2 hash/verify succeeded. No missing provider was hidden by a
network install or development tool.

All four patched packages were verified in the actual artifact:

| Patched package                      | Final-image evidence                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `@better-auth/drizzle-adapter@1.7.5` | Current-row PostgreSQL guard predicate in installed adapter; real authentication/MFA/recovery passed             |
| `imapflow@2.0.6`                     | Patched STORE code; executable UNCHANGEDSINCE=0/MODIFIED conflict probe passed                                   |
| `pg-boss@12.33.7`                    | Live active-job singleton predicate in installed plans; actual worker queue startup and graceful shutdown passed |
| `next@16.3.6`                        | Installed `NEXT_PROXY_BODY_TOO_LARGE` overflow marker; real HTTP body-limit and log-canary regression passed     |

The focused inventory asserts physical absence of TypeScript, Vitest, tsx,
drizzle-kit, esbuild, Vite, associated loader/test packages, and representative
ESLint/Playwright/Testcontainers/Prettier/Tailwind payload under both runtime
node_modules locations. Required production dependencies and all patches remain.

## 7. Complete configuration matrix

This matrix compares `.env.example`, `parseConfig`, every direct `process.env`
consumer, Dockerfile, base Compose, README and deployment documentation.
No new configuration parser or secret-file mechanism was added.

| Variable                                 | Baseline classification / source                                             | Final behavior                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `APP_ORIGIN`                             | Required and passed                                                          | Required canonical origin; unchanged                                                             |
| `DATABASE_URL`                           | Required; supported alternate mechanism                                      | Compose constructs private URL from POSTGRES_PASSWORD; direct local commands use DATABASE_URL    |
| `POSTGRES_PASSWORD`                      | Required Compose/database secret, not an app-parser field                    | Supplies postgres and application URL; unchanged                                                 |
| `AUTH_SECRET`                            | Required and passed                                                          | Unchanged                                                                                        |
| `CREDENTIALS_ENCRYPTION_KEY`             | Required and passed                                                          | Unchanged                                                                                        |
| `ATTACHMENTS_PATH`                       | Required; supported volume/path mechanism                                    | Compose fixes persistent volume path; local configuration remains supported                      |
| `MAILDOCK_BOOTSTRAP_SECRET`              | Optional secret and passed                                                   | Empty/absent remains supported; remove after setup                                               |
| `CREDENTIALS_ENCRYPTION_KEY_ID`          | Optional and passed                                                          | Existing Compose/parser default v1                                                               |
| `CREDENTIALS_ENCRYPTION_PREVIOUS_KEYS`   | Optional and passed                                                          | Existing default JSON object                                                                     |
| `MICROSOFT_CLIENT_ID`                    | Optional and passed; provider bootstrap                                      | Existing empty default; persisted provider mechanism unchanged                                   |
| `MICROSOFT_CLIENT_SECRET`                | Optional secret and passed; provider bootstrap                               | Existing empty default; persisted provider mechanism unchanged                                   |
| `LOG_LEVEL`                              | Optional and passed                                                          | Existing info default                                                                            |
| `MAILDOCK_MAX_ATTACHMENT_BYTES`          | Optional and passed                                                          | Existing Compose/parser default                                                                  |
| `MAILDOCK_MAX_OUTGOING_ATTACHMENT_BYTES` | Optional and passed                                                          | Existing Compose/parser default                                                                  |
| `MAILDOCK_MAX_OUTGOING_MIME_BYTES`       | Optional and passed                                                          | Existing Compose/parser default                                                                  |
| `MAILDOCK_BACKFILL_CHUNK_SIZE`           | Optional and passed                                                          | Existing 500 default                                                                             |
| `MAILDOCK_CONTENT_POLL_INTERVAL_MS`      | Optional and passed                                                          | Existing 400 default                                                                             |
| `DATABASE_POOL_SIZE`                     | Operator-tunable, missing from Compose                                       | Forwarded if supplied; parser default 10                                                         |
| `WORKER_CONCURRENCY`                     | Operator-tunable, missing from Compose                                       | Forwarded if supplied; parser default 5                                                          |
| `MAILDOCK_INITIAL_SYNC_DAYS`             | Operator-tunable, missing from Compose                                       | Forwarded if supplied; parser default 30                                                         |
| `MAILDOCK_MESSAGE_FETCH_BATCH_SIZE`      | Operator-tunable, missing from Compose                                       | Forwarded if supplied; parser default 150                                                        |
| `MAILDOCK_MESSAGE_SYNC_CONCURRENCY`      | Operator-tunable, missing from Compose                                       | Forwarded if supplied; parser default 2                                                          |
| `MAILDOCK_MAIL_POLL_INTERVAL_SECONDS`    | Operator-tunable, missing from Compose                                       | Forwarded if supplied; parser default 300                                                        |
| `MAILDOCK_MAX_MESSAGE_TEXT_PART_BYTES`   | Operator-tunable, missing from Compose                                       | Forwarded if supplied; parser default 5242880                                                    |
| `MAILDOCK_ENV`                           | App default development; deliberately fixed production by image/base Compose | Base security mode stays production; development override selects development                    |
| `NODE_ENV`                               | Framework environment, fixed production by image/base Compose                | Unchanged; explicit development/framework override only                                          |
| `MAILDOCK_ROLE`                          | Entrypoint default/image all; intentionally not a base-stack .env switch     | Role separation requires deployment override and compatible health check; documented             |
| `PORT`, `HOSTNAME`                       | Next listener controls fixed by image, outside app schema                    | Base listener/health contract stays internal port 3000 and 0.0.0.0; deployment override required |
| `NEXT_RUNTIME`                           | Framework-controlled instrumentation selector                                | Internal; not an operator setting                                                                |
| `PNPM_HOME`, build-stage `PATH`          | Build-only package-manager controls                                          | Not copied as application runtime configuration                                                  |
| `NEXT_TELEMETRY_DISABLED`                | Optional Next tooling switch, outside supported app configuration            | Not newly exposed by Compose                                                                     |
| `MAILDOCK_RECOVERY_TEST_IMAGE`           | Test-only image selection for opt-in recovery drill                          | Does not affect app configuration                                                                |

Every schema variable is active; no obsolete/dead setting or supported native
`*_FILE` setting was found. The seven missing tunings are integers (including
seconds/milliseconds/bytes as named), not booleans or duration/size strings.
There is no new boolean/string-duration passthrough to test.

## 8. Reproduced F12-06 behavior

The baseline contract test used a temporary operator `.env` selected with
`docker compose --env-file`, not repository/user secrets. Shell variables with
the same configuration names were removed from the test subprocess environment
to avoid accidentally overriding the fixture. For every missing setting, the
rendered Compose model omitted the supplied canary, a real disposable Compose
app container had no corresponding environment value, and its compiled
`parseConfig(process.env)` returned the application default. This reproduces
the complete .env -> Compose -> container -> parser failure chain.

## 9. F12-06 implementation

Seven explicit null-valued mapping entries were added to `app.environment`.
Compose resolves a supplied shell/.env value; an unresolved key is omitted from
the container. Thus undefined stays undefined rather than becoming `""`.
No application default is duplicated, optional settings do not become required,
and explicitly empty numeric settings keep the parser's existing rejection.
Existing passed settings and secret handling were not redesigned.

`docs/DEPLOYMENT.md` documents omission/empty semantics and the base layout;
README's pnpm setup pin matches the Docker toolchain. Historical security reports
were not edited.

## 10. Compose/config canary evidence

`tests/security/f12-compose-config.mjs` runs nine real Compose/container cases:
all seven distinct values together, omission of all seven, and each of seven
settings independently set to an empty string. Baseline cases passed as expected
reproductions; AFTER cases passed as fixed-contract assertions.

| Variable                               | Synthetic .env canary | BEFORE parsed | AFTER parsed | Omitted AFTER |
| -------------------------------------- | --------------------: | ------------: | -----------: | ------------: |
| `DATABASE_POOL_SIZE`                   |                    17 |            10 |           17 |            10 |
| `WORKER_CONCURRENCY`                   |                     7 |             5 |            7 |             5 |
| `MAILDOCK_INITIAL_SYNC_DAYS`           |                    43 |            30 |           43 |            30 |
| `MAILDOCK_MESSAGE_FETCH_BATCH_SIZE`    |                   173 |           150 |          173 |           150 |
| `MAILDOCK_MESSAGE_SYNC_CONCURRENCY`    |                     3 |             2 |            3 |             2 |
| `MAILDOCK_MAIL_POLL_INTERVAL_SECONDS`  |                   347 |           300 |          347 |           300 |
| `MAILDOCK_MAX_MESSAGE_TEXT_PART_BYTES` |               2345678 |       5242880 |      2345678 |       5242880 |

For AFTER canaries, rendered environment and actual container environment both
contained the exact decimal strings above, and parsed values were exact numbers.
For omission both environment layers lacked the keys and parser defaults held.
For explicit empty values both layers contained `""`; configuration validation
failed for the exact affected field. BEFORE dropped even explicit empty values
and therefore silently used defaults. Evidence: `compose-before.json`,
`compose-after.json`, `compose-test.log` under `.security-results/f12-46`.

Each case also asserts exactly `app` + `postgres` and no PostgreSQL host ports.
Disposable test projects/containers/volumes are removed; no real secret is
included in saved canary outputs.

## 11. Runtime identity and container regression

Final-image identity is UID/GID 1001:1001. Base Compose still has two services,
private PostgreSQL, the same attachment/database volumes and 60-second stop grace.
`tests/security/f12-image.mjs` passed against the final image: migrations, web
startup, readiness, real setup/Argon2/password/TOTP/MFA/business session, default
and raised attachment limits, streamed uploads, byte/hash integrity, body
overflow rejection and independent stdout/stderr canary checks.

Its old disposable DB fixture omitted the authority initdb script and initially
failed closed at migrations with category `database_authority`. The test now
mounts the existing F12-03 initdb SQL read-only. This updates the fixture to the
current supported database contract without weakening the guard or assertions.

Normal entrypoint still invokes only Node for compiled migration, standalone web
and compiled worker. No shell, test framework, pnpm command, source build or
TypeScript runtime compilation is required by normal startup. Existing shell
helpers remain for supported operator/recovery procedures.

## 12. F12-03 and F12-05 recovery regression

The opt-in recovery drill accepts `MAILDOCK_RECOVERY_TEST_IMAGE` so assertions
run against the image under review rather than a historical hard-coded tag.
All prior assertions remain. Both ordinary restore and historical compatibility
bridge drills passed using the actual base Compose file and fresh storage.

- Ordinary drill `8ec716ec`: source destroyed, ordinary-role archive restore,
  maintenance/verification, matched password/TOTP login, new recovery code,
  verified attachment blob, readiness and pg-boss worker startup passed.
- Historical drill `81ddf5ee`: packaged compatibility bridge passed; restored
  data also started/authenticated with the matching older release image.
- Both rejected old sessions/codes, fenced remote activity, refused wrong auth
  secret and missing credential key before mutation, and verified the private
  operator channel.
- Both observed `jobs.stopped` and `worker.shutdown`, 60-second stop grace,
  graceful stop in 1710/1735 ms, exit 143 and no OOM kill.
- F12-03 ordinary database authority gated migrations/web/worker and successful
  restore. Authority and recovery integration suites also passed in the security
  and full repository tests.

Evidence: `recovery-regression.log`, `recovery-legacy-regression.log`, and protected
synthetic drill evidence `.security-results/f125-8ec716ec/result.json` and
`.security-results/f125-81ddf5ee/result.json`. Disposable runtime/storage resources
were cleaned up; protected synthetic evidence remains local and gitignored.

## 13. Security test results

`vitest run tests/security`: **28 files, 389 tests passed**, 158.09 s, no skipped
tests, using bundled host Node 24.19.0 with the Docker daemon available. Includes
real disposable PostgreSQL authority/recovery, Better Auth/MFA, logging, body
boundary and Compose checks. Final-image probes use Node 24.21.0.

An initial attempt in the bare Linux build-stage image lacked the Docker CLI and
Playwright browser binaries; it was an unsuitable harness, not a product failure.
The complete host run above passed without changing or weakening those tests.
Evidence: `security-host.log`; initial harness diagnostics in `security.log`.

## 14. Full-suite results

`vitest run`: **101 files, 1215 tests passed**, 185.29 s, no skipped tests, using
bundled host Node 24.19.0. Includes IMAP conditional STORE and pg-boss integration
regressions in addition to all security tests. Evidence: `full-suite.log`.

## 15. Typecheck, lint, build and formatting

- Web `tsc --noEmit`: PASS.
- Worker `tsc -p tsconfig.worker.json --noEmit`: PASS.
- Source lint `eslint . --ignore-pattern '.security-results/**'`: PASS; focused
  lint of every changed/new executable test also PASS. Plain `eslint .` started
  traversing pre-existing gitignored extracted Next artifacts under
  `.security-results/f12/next-patch`; that attempt was stopped. Only generated
  local evidence is excluded by the successful invocation; repository source
  rules were not modified.
- Actual `pnpm build` inside the uncached Node 24.21.0/pnpm 12.7.0 Docker build:
  PASS (Next production compilation and worker TypeScript compilation/import fix).
- Changed-file Prettier check: PASS. Dockerfile is outside Prettier's parser set;
  pnpm-lock.yaml remains an existing `.prettierignore` entry.
- Repository-source Prettier check with `.prettierignore` and `.gitignore`:
  FAIL only for the following 23 untouched files. They were not reformatted.
- `git diff --check`: PASS.

- `db/migrations/meta/0010_snapshot.json`
- `db/migrations/meta/0011_snapshot.json`
- `db/migrations/meta/0012_snapshot.json`
- `db/migrations/meta/0013_snapshot.json`
- `db/migrations/meta/0014_snapshot.json`
- `db/migrations/meta/0015_snapshot.json`
- `db/migrations/meta/0016_snapshot.json`
- `db/migrations/meta/0017_snapshot.json`
- `db/migrations/meta/0018_snapshot.json`
- `db/migrations/meta/0019_snapshot.json`
- `db/migrations/meta/0020_snapshot.json`
- `db/migrations/meta/0021_snapshot.json`
- `db/migrations/meta/0022_snapshot.json`
- `db/migrations/meta/0023_snapshot.json`
- `db/migrations/meta/0024_snapshot.json`
- `db/migrations/meta/0025_snapshot.json`
- `db/migrations/meta/0026_snapshot.json`
- `docs/IMAP_CONDITIONAL_STORE.md`
- `docs/PHASE_2K.md`
- `docs/SECURITY_F12_5_RECOVERY_DISCOVERY.md`
- `docs/SECURITY_F12_DISCOVERY.md`
- `docs/SECURITY_F4_ROUTE_AUDIT.md`
- `src/components/account-connection-fields.tsx`

## 16. Docker/Compose and focused commands

All commands below ran locally; no image was pushed and no existing deployment
was started/recreated. The opt-in probes use synthetic fixtures and clean up
their own disposable resources.

```sh
docker build --progress=plain -t maildock-f12-46-before .
node tests/security/f12-runtime-dependencies.mjs maildock-f12-46-before --baseline
node tests/security/f12-compose-config.mjs maildock-f12-46-before --baseline
docker build --no-cache --progress=plain -t maildock-f12-46-after .
node tests/security/f12-runtime-dependencies.mjs maildock-f12-46-after
node tests/security/f12-compose-config.mjs maildock-f12-46-after
node tests/security/f12-image.mjs maildock-f12-46-after
MAILDOCK_RECOVERY_TEST_IMAGE=maildock-f12-46-after node tests/security/f12-recovery-production.mjs
MAILDOCK_RECOVERY_TEST_IMAGE=maildock-f12-46-after node tests/security/f12-recovery-production.mjs --legacy
```

The env assignment shown is POSIX syntax; this Windows session used PowerShell
`$env:MAILDOCK_RECOVERY_TEST_IMAGE`. Compose v2.40.3 rendered every synthetic
production fixture and actual recovery project successfully. Production image,
physical inventory, runtime patches, config canaries and recovery drills: PASS.

## 17. Exact git scope/status

HEAD remains the baseline commit. No files beyond the following scoped set were
modified/created. New focused scripts are opt-in image/Compose checks, expressly
requested for these findings; no application unit tests or unrelated refactors
were added. Full tracked diff is saved locally in
`.security-results/f12-46/final-tracked.patch`; new files remain untracked so the
user can review them before deciding whether to commit.

```text
M Dockerfile
 M README.md
 M docker-compose.yml
 M docs/DEPLOYMENT.md
 M package.json
 M pnpm-lock.yaml
 M tests/security/f12-image.mjs
 M tests/security/f12-recovery-production.mjs
?? docs/SECURITY_F12_4_6_RESULTS.md
?? tests/security/f12-compose-config.mjs
?? tests/security/f12-runtime-dependencies.mjs
```

Tracked diff summary (new report and two new scripts are listed separately by status):

```text
Dockerfile                                 |  16 +++-
 README.md                                  |   4 +-
 docker-compose.yml                         |   9 +++
 docs/DEPLOYMENT.md                         |  23 ++++++
 package.json                               |   2 +-
 pnpm-lock.yaml                             | 122 ++++++++++++++---------------
 tests/security/f12-image.mjs               |   2 +
 tests/security/f12-recovery-production.mjs |  15 ++--
 8 files changed, 116 insertions(+), 77 deletions(-)
```

## 18. Final assessment and remaining findings

1. F12-04 reproduced on baseline: **yes**, real package files survived prune.
2. Exact cause: pnpm 12.6.0 follows dev-provided optional-peer snapshot edges;
   copying its physical artifact ships those providers/transitives.
3. Confirmed development-only payload still physically present: **no**.
4. Required runtime and patched dependencies preserved: **yes**, physical/module,
   HTTP/worker/authority/recovery checks passed.
5. Measurable change: image `.Size` reduced 49149470 bytes; node_modules reduced
   111902394 bytes; 50 package/version payloads removed.
6. F12-06 reproduced: **yes**, complete .env -> Compose -> container -> parser chain.
7. Exact affected settings: the seven numeric tunings in sections 7 and 10.
8. Supplied .env values now reach parsed configuration: **yes**, all seven canaries.
9. Omission preserves existing defaults: **yes**; explicit empty remains invalid.
10. Base Compose remains only app + postgres: **yes**, no host PostgreSQL exposure.
11. Runtime UID/GID remains 1001:1001: **yes**.
12. F12-03 authority and F12-05 ordinary/historical recovery work: **yes**.
13. New security finding: **none observed in this scoped validation**; this is not
    a new general audit or dependency vulnerability scan. Existing unrelated
    formatting debt and initial harness limitations are recorded above.
14. Original F12 production-hardening finding ready to close: **yes**, with the
    already accepted closed findings unchanged and these remaining two remediated.

F12-04 + F12-06: PASS
