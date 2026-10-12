param([ValidateSet('up','down','reset','status')][string]$Action = 'up')
$ErrorActionPreference = 'Stop'
$experimentRoot = $PSScriptRoot
$composeFile = Join-Path $experimentRoot 'compose.yaml'
function Invoke-Compose {
    & docker compose -f $composeFile @args
    if ($LASTEXITCODE -ne 0) { throw 'Experiment Compose command failed' }
}
if ($Action -eq 'down') { Invoke-Compose down; exit }
if ($Action -eq 'reset') { Invoke-Compose down --volumes; exit }
if ($Action -eq 'status') { Invoke-Compose ps; exit }
$tlsDir = Join-Path $experimentRoot '.runtime/tls'
New-Item -ItemType Directory -Force -Path $tlsDir | Out-Null
if (!(Test-Path -LiteralPath (Join-Path $tlsDir 'tls.crt'))) {
    & docker run --rm --mount "type=bind,source=$tlsDir,target=/tls" --entrypoint openssl 'dovecot/dovecot:2.4.3-dev@sha256:d0db02b4aa9c16bc50c96faad68fcf5724c1453a98a39ada685409227e967898' req -x509 -newkey rsa:2048 -nodes -keyout /tls/tls.key -out /tls/tls.crt -days 30 -subj /CN=localhost -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
    if ($LASTEXITCODE -ne 0) { throw 'TLS fixture generation failed' }
}
Invoke-Compose up -d
# A listening TCP port does not prove readiness. Retry authenticated SELECT.
for ($attempt = 1; $attempt -le 20; $attempt++) {
    & node --import tsx (Join-Path $experimentRoot 'cli.ts') ready
    if ($LASTEXITCODE -eq 0) { exit }
    Start-Sleep -Seconds 1
}
throw 'Dovecot authenticated IMAP readiness failed'
