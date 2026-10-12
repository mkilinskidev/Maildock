$ErrorActionPreference = 'Stop'
function Invoke-Phase3Final {
    & node --import tsx @args
    if ($LASTEXITCODE -ne 0) { throw 'Final Phase 3 validation failed; retain outputs' }
}
Invoke-Phase3Final experiments/imap-durability/restore-reference.ts
Invoke-Phase3Final experiments/imap-durability/durability.ts
Invoke-Phase3Final experiments/imap-durability/commit-uncertainty.ts
Invoke-Phase3Final experiments/imap-durability/workload.ts 60 1 1
Invoke-Phase3Final experiments/imap-durability/workload.ts 60 2 2
Invoke-Phase3Final experiments/imap-durability/workload.ts 60 4 1
Invoke-Phase3Final experiments/imap-durability/workload.ts 60 4 6 finite
Invoke-Phase3Final experiments/imap-durability/workload.ts 600 4 2
Invoke-Phase3Final experiments/imap-durability/regressions.ts
