$ErrorActionPreference = 'Stop'
function Invoke-Phase3Post {
    & node --import tsx @args
    if ($LASTEXITCODE -ne 0) { throw 'Phase 3 post-validation failed; retain output' }
}
Invoke-Phase3Post experiments/imap-durability/packet-loss.ts
Invoke-Phase3Post experiments/imap-durability/turn-budget.ts
Invoke-Phase3Post experiments/imap-durability/reconciliation.ts
Invoke-Phase3Post experiments/imap-durability/durability.ts
Invoke-Phase3Post experiments/imap-durability/db-startup-deadline.ts
Invoke-Phase3Post experiments/imap-durability/search-evidence.ts
Invoke-Phase3Post experiments/imap-durability/summarize.ts
