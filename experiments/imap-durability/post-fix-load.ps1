$ErrorActionPreference = 'Stop'
function Invoke-PostFixLoad {
    & node --import tsx @args
    if ($LASTEXITCODE -ne 0) { throw 'Post-fix validation failed; preserve outputs' }
}
Invoke-PostFixLoad experiments/imap-durability/restore-reference.ts
Invoke-PostFixLoad experiments/imap-durability/workload.ts 60 4 1
Invoke-PostFixLoad experiments/imap-durability/workload.ts 600 4 2
Invoke-PostFixLoad experiments/imap-durability/summarize.ts
