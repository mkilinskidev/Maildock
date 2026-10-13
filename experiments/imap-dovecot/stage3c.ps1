$ErrorActionPreference = 'Stop'
# Pre-pull images before invoking this script. No download time is hidden here.
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$logPath = Join-Path $repoRoot 'stage3c-run.log'
$errorPath = Join-Path $repoRoot 'stage3c-error.log'
$process = $null
try {
    $process = Start-Process -FilePath 'node' -ArgumentList '--import', 'tsx', 'experiments/imap-dovecot/stage3c.ts' -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $logPath -RedirectStandardError $errorPath -PassThru
    # Keep the process handle open so ExitCode remains available after exit.
    $processHandle = $process.Handle
    if (!$process.WaitForExit(300000)) {
        $process.Kill($true)
        throw 'PARTIAL: strict five-minute smoke execution budget exhausted'
    }
    $process.Refresh()
    if ($process.ExitCode -ne 0) { throw "Smoke failed, exit $($process.ExitCode); inspect stage3c-error.log and stage3c-evidence.json" }
} finally {
    # Also cleans interrupted fixture preparation or the hard watchdog path.
    $fixtureContainers = @(& docker ps -aq --filter 'label=maildock.stage3c=disposable')
    foreach ($containerId in $fixtureContainers) {
        if ($containerId -match '^[0-9a-f]{12,64}$') { & docker rm -fv $containerId | Out-Null }
    }
    Get-Content -LiteralPath $logPath -ErrorAction SilentlyContinue
    Get-Content -LiteralPath $errorPath -ErrorAction SilentlyContinue
}
