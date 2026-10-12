param([switch]$Smoke)
$ErrorActionPreference = 'Stop'
function Invoke-Phase3 {
    & node --import tsx @args
    if ($LASTEXITCODE -ne 0) { throw 'Phase 3 scenario failed; preserve partial results' }
}
Invoke-Phase3 experiments/imap-durability/durability.ts
Invoke-Phase3 experiments/imap-durability/commit-uncertainty.ts
Invoke-Phase3 experiments/imap-durability/statement-failures.ts
Invoke-Phase3 experiments/imap-durability/turn-budget.ts
Invoke-Phase3 experiments/imap-durability/db-startup-deadline.ts
Invoke-Phase3 experiments/imap-durability/search-evidence.ts
Invoke-Phase3 experiments/imap-durability/network.ts
Invoke-Phase3 experiments/imap-durability/packet-loss.ts
$seconds = 60
if ($Smoke) { $seconds = 10 }
Invoke-Phase3 experiments/imap-durability/workload.ts $seconds 1 1
Invoke-Phase3 experiments/imap-durability/workload.ts $seconds 2 2
Invoke-Phase3 experiments/imap-durability/workload.ts $seconds 4 1
Invoke-Phase3 experiments/imap-durability/workload.ts $seconds 4 6 finite
if (!$Smoke) { Invoke-Phase3 experiments/imap-durability/workload.ts 600 4 2 }
Invoke-Phase3 experiments/imap-durability/reconciliation.ts
Invoke-Phase3 experiments/imap-durability/regressions.ts
Invoke-Phase3 experiments/imap-durability/summarize.ts
Invoke-Phase3 experiments/imap-durability/environment.ts
