# Phase 1B executed commands and reproduction

Run from `D:\Projects\JS\Maildock`, PowerShell, on 2026-10-12. File reads and installed-source inspection used `Get-Content`, `rg --files`, and `rg -n` against the four required reports/design documents, all Phase 1 harness TypeScript modules, package/configuration files and installed `node_modules/imapflow/dist/esm` source. No network research, package installation, provider connection or production program was invoked.

## Repository setup

```powershell
git status --short
git branch --show-current
git remote -v
git fetch --all --prune
git show --stat --oneline 3b0745726fa107e7d26567267937440a5de31b25
git branch --list experiment/imap-transport-hardening
git rev-parse HEAD
git switch -c experiment/imap-transport-hardening
node --version
pnpm --version
```

The current branch/base was the exact requested Phase 1 commit and the worktree was clean. The target branch did not exist. No refs for main/design/archive branches were changed.

## New suite and diagnostic iterations

```powershell
node --import tsx --test --test-concurrency=1 experiments/imap-transport/hardening.test.ts
Copy-Item -LiteralPath experiments/imap-transport/phase-1b-measurements.json -Destination experiments/imap-transport/phase-1b-initial.json
node --import tsx --test --test-concurrency=1 experiments/imap-transport/hardening.test.ts
Copy-Item -LiteralPath experiments/imap-transport/phase-1b-measurements.json -Destination experiments/imap-transport/phase-1b-diagnostic-failure.json
$env:IMAP_HARDENING_REPEATS = '3'
node --import tsx --test --test-concurrency=1 experiments/imap-transport/hardening.test.ts
Remove-Item Env:IMAP_HARDENING_REPEATS
Copy-Item -LiteralPath experiments/imap-transport/phase-1b-measurements.json -Destination experiments/imap-transport/phase-1b-fixture-correction.json
```

The above archives retain the initial 10/40, subsequent 39/40 and syntax-fixture 126/129 runs respectively. Final runs used output redirection and propagated the Node exit code explicitly:

```powershell
$env:IMAP_HARDENING_REPEATS = '3'
node --import tsx --test --test-concurrency=1 experiments/imap-transport/hardening.test.ts *> experiments/imap-transport/phase-1b-suite.log
$hardeningExit = $LASTEXITCODE
Remove-Item Env:IMAP_HARDENING_REPEATS
Get-Content experiments/imap-transport/phase-1b-suite.log | Select-Object -Last 15
exit $hardeningExit
```

This command was used for the 135/135 profile and again for the final expanded profile. Local `.log` files are gitignored; the committed JSON contains per-trial assertions/evidence instead. Direct diagnostic invocations executed, some repeatedly during fixes:

```powershell
node --import tsx experiments/imap-transport/hardening-scenario.ts metadata-complete
node --import tsx experiments/imap-transport/hardening-scenario.ts slice-correct
node --import tsx experiments/imap-transport/hardening-scenario.ts metadata-missing
node --import tsx experiments/imap-transport/hardening-scenario.ts socket-timeout
node --import tsx experiments/imap-transport/hardening-scenario.ts metadata-malformed
node --import tsx experiments/imap-transport/hardening-scenario.ts search-parsed-overshoot
node --import tsx experiments/imap-transport/hardening-summary.ts
```

## Original Phase 1 regression, preserving historical results

The original suite writes `measurements.json`. Its bytes were saved before execution, the new regression output copied to a distinct artifact, and original bytes restored in finally even on failure. Exact invocation:

```powershell
$phase1Path = Join-Path (Get-Location) 'experiments/imap-transport/measurements.json'
$phase1Original = [System.IO.File]::ReadAllBytes($phase1Path)
try {
  node --import tsx --test --test-concurrency=1 experiments/imap-transport/transport.test.ts *> experiments/imap-transport/phase-1b-regression.log
  $phase1Exit = $LASTEXITCODE
  Copy-Item -LiteralPath $phase1Path -Destination experiments/imap-transport/phase-1b-regression-measurements.json
} finally {
  [System.IO.File]::WriteAllBytes($phase1Path, $phase1Original)
}
Get-Content experiments/imap-transport/phase-1b-regression.log | Select-Object -Last 12
exit $phase1Exit
```

43/43 assertions passed with default one repetition. The existing committed three-repetition baseline remains unchanged. Phase 1's `summarize.ts` was deliberately not executed because it would rewrite the historical results report.

## Checks

```powershell
pnpm typecheck
pnpm lint
pnpm format:check
pnpm exec tsc --ignoreConfig --noEmit --strict --skipLibCheck --target es2022 --module nodenext --moduleResolution nodenext --types node experiments/imap-transport/fixture.ts experiments/imap-transport/scenarios.ts experiments/imap-transport/scenario.ts experiments/imap-transport/transport.test.ts experiments/imap-transport/summarize.ts experiments/imap-transport/hardening.ts experiments/imap-transport/hardening-cases.ts experiments/imap-transport/hardening-scenario.ts experiments/imap-transport/hardening.test.ts experiments/imap-transport/hardening-summary.ts
pnpm exec eslint experiments/imap-transport
pnpm exec vitest run tests/imap-client-lifecycle.test.ts tests/imap-conditional-store.test.ts tests/imapflow-download-charset.test.ts
pnpm exec prettier --write experiments/imap-transport/hardening*.ts
pnpm exec prettier --write experiments/imap-transport/fixture.ts
pnpm exec prettier --write docs/experiments/imap-transport/PHASE_1B_*.md
pnpm exec prettier --check experiments/imap-transport/hardening*.ts experiments/imap-transport/fixture.ts experiments/imap-transport/phase-1b-*.json docs/experiments/imap-transport/PHASE_1B_*.md
```

During development, the standalone tsc command was also executed with only the newly added files present at that point (first `hardening.ts hardening-scenario.ts`, then those plus `hardening.test.ts`). All final checks include the summary module. Source formatting was repeated only after edits. No unrelated protected document was formatted.

`pnpm format:check` fails only on the unchanged architecture/validation Markdown and Phase 1 plaintext diagnostic JSON after formatting the changed fixture. To confirm these are baseline failures, the following commands were also executed; each returned exit code 1:

```powershell
git show 3b0745726fa107e7d26567267937440a5de31b25:docs/design/imap-sync-engine/SYNC_ENGINE_ARCHITECTURE.md | pnpm exec prettier --check --stdin-filepath docs/design/imap-sync-engine/SYNC_ENGINE_ARCHITECTURE.md
git show 3b0745726fa107e7d26567267937440a5de31b25:docs/design/imap-sync-engine/SYNC_ENGINE_VALIDATION.md | pnpm exec prettier --check --stdin-filepath docs/design/imap-sync-engine/SYNC_ENGINE_VALIDATION.md
git show 3b0745726fa107e7d26567267937440a5de31b25:experiments/imap-transport/plaintext-interference.json | pnpm exec prettier --check --stdin-filepath experiments/imap-transport/plaintext-interference.json
```

Inspection/commit completion uses `git diff --check`, `git diff --stat`, `git status --short`, explicit-path staging, `git commit -m "experiment: harden IMAP transport evidence in phase 1B"`, `git rev-parse HEAD`, and `git show --stat --oneline HEAD`. No push, PR or merge command is authorized or executed.
