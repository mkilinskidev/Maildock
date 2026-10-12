$ErrorActionPreference = 'Stop'
function Invoke-Load {
    & node --import tsx experiments/imap-durability/workload.ts @args
    if ($LASTEXITCODE -ne 0) { throw 'Load profile failed; preserve results before proceeding' }
}
Invoke-Load 60 1 1
Invoke-Load 60 2 2
Invoke-Load 60 4 1
Invoke-Load 60 4 6 finite
Invoke-Load 600 4 2
& node --import tsx experiments/imap-durability/reconciliation.ts
if ($LASTEXITCODE -ne 0) { throw 'Reconciliation failed' }
