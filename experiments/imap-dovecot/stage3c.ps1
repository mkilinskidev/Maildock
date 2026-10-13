param([switch]$FailureOnly)
$ErrorActionPreference = 'Stop'
# Pre-pull images before invoking this script. No download time is hidden here.
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$logPath = Join-Path $repoRoot $(if ($FailureOnly) { 'stage3c-failure-run.log' } else { 'stage3c-run.log' })
$errorPath = Join-Path $repoRoot $(if ($FailureOnly) { 'stage3c-failure-error.log' } else { 'stage3c-error.log' })
$process = $null
try {
    $smokeArguments = @('--import', 'tsx', 'experiments/imap-dovecot/stage3c.ts')
    if ($FailureOnly) { $smokeArguments += '--failure-only' }
    $process = Start-Process -FilePath 'node' -ArgumentList $smokeArguments -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $logPath -RedirectStandardError $errorPath -PassThru
    # Keep the process handle open so ExitCode remains available after exit.
    $processHandle = $process.Handle
    $processBudgetMs = $(if ($FailureOnly) { 120000 } else { 300000 })
    if (!$process.WaitForExit($processBudgetMs)) {
        $process.Kill($true)
        throw "PARTIAL: strict $processBudgetMs ms process budget exhausted"
    }
    $process.Refresh()
    if ($process.ExitCode -ne 0) { throw "Smoke failed, exit $($process.ExitCode); inspect $errorPath and the selected mode's evidence JSON" }
} finally {
    # Also cleans interrupted fixture preparation or the hard watchdog path.
    $fixtureContainers = @(& docker ps -aq --filter 'label=maildock.stage3c=disposable')
    foreach ($containerId in $fixtureContainers) {
        if ($containerId -match '^[0-9a-f]{12,64}$') { & docker rm -fv $containerId | Out-Null }
    }
    Get-Content -LiteralPath $logPath -ErrorAction SilentlyContinue
    Get-Content -LiteralPath $errorPath -ErrorAction SilentlyContinue
}
