$ErrorActionPreference = 'Stop'
function Invoke-CriticalRecheck {
    & node --import tsx @args
    if ($LASTEXITCODE -ne 0) { throw 'Critical recheck failed; stop dependent claims' }
}
Invoke-CriticalRecheck experiments/imap-durability/late-db-callback.ts
Invoke-CriticalRecheck experiments/imap-durability/statement-failures.ts
Invoke-CriticalRecheck experiments/imap-durability/turn-budget.ts
Invoke-CriticalRecheck experiments/imap-durability/db-startup-deadline.ts
Invoke-CriticalRecheck experiments/imap-durability/durability.ts
Invoke-CriticalRecheck experiments/imap-durability/commit-uncertainty.ts
Invoke-CriticalRecheck experiments/imap-durability/restore-reference.ts
Invoke-CriticalRecheck experiments/imap-durability/reconciliation.ts
# Reconciliation's destructive fixture leaves >=35k; restore the two >=50k
# histories before the post-fix constrained-pool and sustained references.
Invoke-CriticalRecheck experiments/imap-durability/restore-reference.ts
Invoke-CriticalRecheck experiments/imap-durability/workload.ts 60 4 1
Invoke-CriticalRecheck experiments/imap-durability/workload.ts 600 4 2
Invoke-CriticalRecheck experiments/imap-durability/summarize.ts
