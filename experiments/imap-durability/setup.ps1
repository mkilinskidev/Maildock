param([ValidateSet('up','down','status')][string]$Action = 'up')
$ErrorActionPreference = 'Stop'
$composeFile = Join-Path $PSScriptRoot 'compose.yaml'
function Invoke-FixtureCompose {
    & docker compose -f $composeFile @args
    if ($LASTEXITCODE -ne 0) { throw 'Phase 3 Compose command failed' }
}
if ($Action -eq 'down') { Invoke-FixtureCompose down; exit }
if ($Action -eq 'status') { Invoke-FixtureCompose ps; exit }
$tlsDir = Join-Path $PSScriptRoot '.runtime/tls'
New-Item -ItemType Directory -Force -Path $tlsDir | Out-Null
if (!(Test-Path -LiteralPath (Join-Path $tlsDir 'tls.crt'))) {
    & docker run --rm --mount "type=bind,source=$tlsDir,target=/tls" --entrypoint openssl 'dovecot/dovecot:2.4.3-dev@sha256:d0db02b4aa9c16bc50c96faad68fcf5724c1453a98a39ada685409227e967898' req -x509 -newkey rsa:2048 -nodes -keyout /tls/tls.key -out /tls/tls.crt -days 30 -subj /CN=localhost -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
    if ($LASTEXITCODE -ne 0) { throw 'TLS generation failed' }
}
Invoke-FixtureCompose up -d --wait postgres
Invoke-FixtureCompose up -d dovecot
& node --import tsx (Join-Path $PSScriptRoot 'cli.ts') ready
if ($LASTEXITCODE -ne 0) { throw 'Authenticated database/IMAP readiness failed' }
