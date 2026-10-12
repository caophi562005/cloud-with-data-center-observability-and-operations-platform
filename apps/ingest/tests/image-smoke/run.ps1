# Runs the published gateway IMAGE (never rebuilds it) against isolated fixtures.
# No production .env, AGT, database, Redis or Grafana credentials are read here.
param(
  [string]$Image = 'public.ecr.aws/h5u5b6t3/opsgrid-ingest@sha256:88f8400e5224f029b61923513b2002f0ad10705bb954f827f8b12c736f81b487'
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$RunId = 'opsgrid-image-smoke-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
$Label = "opsgrid.image-smoke.run=$RunId"
$Network = "$RunId-net"
$DB = "$RunId-db"
$Redis = "$RunId-redis"
$Fixture = "$RunId-upstream"
$Gateway = "$RunId-gateway"
$Build = Join-Path ([System.IO.Path]::GetTempPath()) $RunId
$Created = @()
$NetworkCreated = $false
$BuildCreated = $false
$OldGoOS = $env:GOOS
$OldGoArch = $env:GOARCH
$OldCGO = $env:CGO_ENABLED
function Invoke-Docker {
  $Result = @(& docker @args)
  if ($LASTEXITCODE -ne 0) { throw "Docker test operation failed: $($args[0])" }
  return $Result
}
function Invoke-Client([string]$Mode) {
  & (Join-Path $Build 'client.exe') $Mode $script:GatewayURL $script:FixtureURL
  if ($LASTEXITCODE -ne 0) { throw "Image smoke mode failed: $Mode" }
}
function Wait-Http([string]$URL) {
  $Deadline = [datetime]::UtcNow.AddSeconds(45)
  do {
    try { $Response = Invoke-WebRequest -UseBasicParsing -Uri $URL -TimeoutSec 3; if ($Response.StatusCode -eq 200) { return } } catch {}
    Start-Sleep -Milliseconds 500
  } while ([datetime]::UtcNow -lt $Deadline)
  throw "Local test service did not become healthy: $URL"
}
try {
  New-Item -ItemType Directory -Path $Build | Out-Null
  $BuildCreated = $true
  Push-Location $Root
  try {
    $env:CGO_ENABLED = '0'; $env:GOOS = 'linux'; $env:GOARCH = 'amd64'
    & go build -trimpath -o (Join-Path $Build 'fixture-linux') ./tests/image-smoke
    if ($LASTEXITCODE -ne 0) { throw 'Linux fixture compilation failed.' }
    $env:GOOS = 'windows'
    & go build -trimpath -o (Join-Path $Build 'client.exe') ./tests/image-smoke
    if ($LASTEXITCODE -ne 0) { throw 'Local client compilation failed.' }
  } finally { Pop-Location }
  Invoke-Docker image inspect --format '{{.Os}}/{{.Architecture}} user={{.Config.User}}' $Image
  # A dedicated bridge is needed for Docker Desktop host port publishing.
  # All configured destinations are local fixtures; no production secrets exist.
  Invoke-Docker network create --driver bridge --label $Label $Network | Out-Null
  $NetworkCreated = $true
  Invoke-Docker run -d --name $DB --label $Label --network $Network --network-alias db --tmpfs '/var/lib/postgresql/data:rw,nosuid,nodev,size=256m' -e POSTGRES_PASSWORD=local-fixture-only -e POSTGRES_DB=ingest postgres:17-alpine | Out-Null
  $Created += $DB
  Invoke-Docker run -d --name $Redis --label $Label --network $Network --network-alias redis redis:7-alpine | Out-Null
  $Created += $Redis
  Invoke-Docker run -d --name $Fixture --label $Label --network $Network --read-only --user 65532:65532 --cap-drop=ALL --security-opt=no-new-privileges --mount "type=bind,source=$(Join-Path $Build 'fixture-linux'),target=/fixture,readonly" --entrypoint /fixture -p 127.0.0.1::8080 -p 127.0.0.1::19092 golang:1.27.1 serve | Out-Null
  $Created += $Fixture
  $Deadline = [datetime]::UtcNow.AddSeconds(45)
  do {
    & docker exec $DB pg_isready -U postgres -d ingest *> $null
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Milliseconds 500
  } while ([datetime]::UtcNow -lt $Deadline)
  if ($LASTEXITCODE -ne 0) { throw 'Fixture PostgreSQL did not start.' }
  $Token = 'AGT_local_image_smoke_only'
  $Revoked = 'AGT_revoked_local_fixture'
  $SHA = [System.Security.Cryptography.SHA256]::Create()
  $Hash = ([System.BitConverter]::ToString($SHA.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Token)))).Replace('-', '').ToLowerInvariant()
  $RevokedHash = ([System.BitConverter]::ToString($SHA.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Revoked)))).Replace('-', '').ToLowerInvariant()
  $SHA.Dispose()
  # Minimal local contract tables. The gateway receives a SELECT-only DB role.
  $SQL = @"
CREATE TABLE "Organization" ("id" uuid PRIMARY KEY);
CREATE TABLE "Vm" ("id" uuid PRIMARY KEY, "organizationId" uuid NOT NULL);
CREATE TABLE "Agent" ("id" uuid PRIMARY KEY, "vmId" uuid NOT NULL, "organizationId" uuid NOT NULL, "status" text NOT NULL, "credentialHash" text UNIQUE NOT NULL);
INSERT INTO "Organization" VALUES ('33333333-3333-4333-8333-333333333333');
INSERT INTO "Vm" VALUES ('22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333');
INSERT INTO "Agent" VALUES ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','ACTIVE','$Hash');
INSERT INTO "Agent" VALUES ('44444444-4444-4444-8444-444444444444','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','REVOKED','$RevokedHash');
CREATE ROLE gateway LOGIN PASSWORD 'local-fixture-only';
GRANT CONNECT ON DATABASE ingest TO gateway;
GRANT USAGE ON SCHEMA public TO gateway;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO gateway;
"@
  $SQL | & docker exec -i $DB psql -U postgres -d ingest -v ON_ERROR_STOP=1
  if ($LASTEXITCODE -ne 0) { throw 'Fixture schema setup failed.' }
  $script:FixtureURL = 'http://' + @(Invoke-Docker port $Fixture 19092/tcp)[0].Trim()
  $script:GatewayURL = 'http://' + @(Invoke-Docker port $Fixture 8080/tcp)[0].Trim()
  Wait-Http "$FixtureURL/health"
  # Shared network namespace makes the mock write endpoint truly loopback.
  Invoke-Docker run -d --name $Gateway --label $Label --network "container:$Fixture" --read-only --cap-drop=ALL --security-opt=no-new-privileges -e PORT=8080 -e DATABASE_URL=postgres://gateway:local-fixture-only@db:5432/ingest?sslmode=disable -e REDIS_URL=redis://redis:6379/0 -e METRICS_WRITE_URL=http://127.0.0.1:19091/api/v1/write -e METRICS_USERNAME=local-smoke-user -e METRICS_WRITE_TOKEN=local-smoke-password -e AGENT_AUTH_CACHE_TTL_SECONDS=3600 -e REMOTE_WRITE_MAX_BODY_BYTES=2048 -e RATE_LIMIT_REQUESTS_PER_SECOND=0.001 -e RATE_LIMIT_BURST=20 $Image | Out-Null
  $Created += $Gateway
  Wait-Http "$GatewayURL/ready"
  Invoke-Client functional
  Invoke-Docker pause $DB | Out-Null
  Invoke-Client cached
  Invoke-Docker unpause $DB | Out-Null
  Invoke-Docker stop --time 5 $Redis | Out-Null
  Invoke-Docker restart --time 20 $Gateway | Out-Null
  Wait-Http "$GatewayURL/ready"
  Invoke-Client fallback
  Invoke-Docker pause $DB | Out-Null
  Invoke-Client unavailable
  Invoke-Docker unpause $DB | Out-Null
  Invoke-Client rate
  Invoke-Docker stop --time 20 $Gateway | Out-Null
  $ExitCode = @(Invoke-Docker inspect --format '{{.State.ExitCode}}' $Gateway)[0].Trim()
  if ($ExitCode -ne '0') { throw "Graceful shutdown failed (exit $ExitCode)." }
  Write-Output 'PASS SIGTERM graceful shutdown: exit 0'
  # Check BOTH Docker log streams; go-redis may log pool failures to stderr.
  $PreviousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $LogLines = @(& docker logs $Gateway 2>&1 | ForEach-Object { $_.ToString() })
    $LogExit = $LASTEXITCODE
  } finally { $ErrorActionPreference = $PreviousPreference }
  if ($LogExit -ne 0) { throw 'Cannot inspect gateway logs.' }
  $Logs = $LogLines -join "`n"
  foreach ($Value in @($Token, $Revoked, 'local-smoke-password', 'local-fixture-only')) {
    if ($Logs.Contains($Value)) { throw 'Synthetic secret leaked into gateway logs.' }
  }
  Write-Output 'PASS no synthetic credential values in gateway logs'
} finally {
  $env:GOOS = $OldGoOS; $env:GOARCH = $OldGoArch; $env:CGO_ENABLED = $OldCGO
  $CleanupFailures = @()
  for ($Index = $Created.Count - 1; $Index -ge 0; $Index--) {
    $Container = $Created[$Index]
    try {
      # Fail closed: both the exact name and unique owner label must match.
      $Info = @(Invoke-Docker inspect $Container | ConvertFrom-Json)
      if ($Info.Count -ne 1 -or $Info[0].Name -ne "/$Container" -or $Info[0].Config.Labels.'opsgrid.image-smoke.run' -ne $RunId) {
        throw 'Container ownership check failed.'
      }
      if ($Info[0].State.Paused) {
        try { Invoke-Docker unpause $Container | Out-Null }
        catch { $CleanupFailures += "Test unpause failed for $Container" }
      }
      Invoke-Docker rm --force --volumes $Container | Out-Null
    } catch { $CleanupFailures += "Test cleanup failed for $Container" }
  }
  if ($NetworkCreated) {
    try {
      $Info = @(Invoke-Docker network inspect $Network | ConvertFrom-Json)
      if ($Info.Count -ne 1 -or $Info[0].Name -ne $Network -or $Info[0].Labels.'opsgrid.image-smoke.run' -ne $RunId) {
        throw 'Network ownership check failed.'
      }
      Invoke-Docker network rm $Network | Out-Null
    } catch { $CleanupFailures += "Test network cleanup failed for $Network" }
  }
  try {
    if (Test-Path -LiteralPath $Build) {
      # Require creation ownership and the resolved exact directory; never follow a reparse point.
      $Expected = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) $RunId))
      $Resolved = (Resolve-Path -LiteralPath $Build).ProviderPath
      $Item = Get-Item -LiteralPath $Build -Force
      if (-not $BuildCreated -or $Resolved -ne $Expected -or -not $Item.PSIsContainer -or ($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'Temp build ownership/path check failed.'
      }
      Remove-Item -LiteralPath $Resolved -Recurse -Force
    }
  } catch { $CleanupFailures += 'Test temp build cleanup failed.' }
  # Keep attempting all owned cleanup, but never turn any failure into success.
  if ($CleanupFailures.Count -gt 0) { throw ($CleanupFailures -join '; ') }
}
Write-Output "IMAGE TEST PASSED: $Image"
