param([ValidateRange(1,50000)][int]$Count = 100)
$ErrorActionPreference = 'Stop'
$experimentRoot = $PSScriptRoot
$composeFile = Join-Path $experimentRoot 'compose.yaml'
function Invoke-Compose {
    & docker compose -f $composeFile @args
    if ($LASTEXITCODE -ne 0) { throw 'Experiment Compose command failed' }
}
$started = Get-Date
$generationJson = & node --import tsx (Join-Path $experimentRoot 'cli.ts') generate $Count
if ($LASTEXITCODE -ne 0) { throw 'Generation failed' }
Write-Output $generationJson
& node --import tsx (Join-Path $experimentRoot 'cli.ts') empty
if ($LASTEXITCODE -ne 0) { throw 'Fixture INBOX must be empty before import' }
Invoke-Compose cp (Join-Path $experimentRoot "fixtures/$Count/mailbox.tar") dovecot:/tmp/maildock-fixture.tar
Invoke-Compose exec -T dovecot sh /tmp/maildock-import.sh
Invoke-Compose exec -T dovecot doveadm index -u fixture INBOX
$verificationJson = & node --import tsx (Join-Path $experimentRoot 'cli.ts') verify $Count
if ($LASTEXITCODE -ne 0) { throw 'Fixture verification failed' }
Write-Output $verificationJson
$elapsedSeconds = ((Get-Date) - $started).TotalSeconds
$outputDir = Join-Path $experimentRoot 'outputs'
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$record = [ordered]@{ started = $started.ToUniversalTime().ToString('o'); count = $Count; generation = ($generationJson | ConvertFrom-Json); verification = ($verificationJson | ConvertFrom-Json); preparationSeconds = $elapsedSeconds } | ConvertTo-Json -Depth 10
$outputPath = Join-Path $outputDir "$([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH-mm-ss-fffZ'))-preparation-$Count.json"
[System.IO.File]::WriteAllText($outputPath, $record, (New-Object System.Text.UTF8Encoding $false))
Write-Output "Fixture preparation including verification: $elapsedSeconds seconds"
