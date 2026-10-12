$ErrorActionPreference = 'Stop'
$composeFile = Join-Path $PSScriptRoot 'compose.yaml'
function Invoke-FixtureCompose {
    & docker compose -f $composeFile @args
    if ($LASTEXITCODE -ne 0) { throw 'Phase 3 seed failed' }
}
& node --import tsx (Join-Path $PSScriptRoot 'cli.ts') generate 50000
if ($LASTEXITCODE -ne 0) { throw 'Phase 3 generation failed' }
Invoke-FixtureCompose cp (Join-Path $PSScriptRoot 'fixtures/50000/mailbox.tar') dovecot:/tmp/phase3-fixture.tar
Invoke-FixtureCompose cp (Join-Path $PSScriptRoot 'import.sh') dovecot:/tmp/phase3-import.sh
Invoke-FixtureCompose exec -T dovecot sh -c 'mkdir -p /tmp/phase3-import; tar -xf /tmp/phase3-fixture.tar -C /tmp/phase3-import'
foreach ($accountName in @('p3-load-0','p3-load-1')) {
    & node --import tsx (Join-Path $PSScriptRoot 'bulk-seed.ts') $accountName
    if ($LASTEXITCODE -ne 0) { throw 'Bulk fixture seed failed' }
}
& node --import tsx (Join-Path $PSScriptRoot 'seed-small.ts')
if ($LASTEXITCODE -ne 0) { throw 'Phase 3 small-account seed failed' }
