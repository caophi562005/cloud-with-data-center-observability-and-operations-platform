# Repeatable IMAGE test only: never builds, migrates, reads .env or uses host credentials.
# Health SELECT 1 is NOT evidence of production schema compatibility.
param([Parameter(Mandatory)][string]$Image)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$RunId = 'opsgrid-api-image-smoke-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
$LabelKey = 'opsgrid.api-image-smoke.run'
$Label = "$LabelKey=$RunId"
$Network = "$RunId-net"
$DB = "$RunId-db"
$Redis = "$RunId-redis"
$API = "$RunId-api"
$Probe = "$RunId-probe"
$Containers = @()
$NetworkAttempted = $false
$APIAttempted = $false
$Failure = $null
$CleanupErrors = @()
# Deliberately synthetic values only. Never copy any host environment into Docker.
$DBPassword = 'fixture-db-password'
$RedisPassword = 'fixture-redis-password'
$CognitoSecret = 'fixture-cognito-secret'
$CacheKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

function Invoke-Docker {
  # Capture BOTH native streams privately, including PS5.1 NativeCommandError records.
  # Pipe scripts to stdin rather than relying on Windows native -e quoting.
  $PreviousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $Result = @($input | & docker @args 2>&1 | ForEach-Object { $_.ToString() })
    $Code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $PreviousPreference }
  if ($Code -ne 0) { throw "Docker test operation failed: $($args[0])" }
  return $Result
}
function Get-OwnedContainer([string]$Name) {
  $Items = @(Invoke-Docker inspect $Name | ConvertFrom-Json)
  if ($Items.Count -ne 1 -or $Items[0].Name -ne "/$Name" -or $Items[0].Config.Labels.$LabelKey -ne $RunId) {
    throw 'Container ownership verification failed; refusing access or deletion.'
  }
  return $Items[0]
}
function Assert-Fixture([string]$Name) {
  $Info = Get-OwnedContainer $Name
  $Attached = @($Info.NetworkSettings.Networks.PSObject.Properties.Name)
  if ($Attached.Count -ne 1 -or $Attached[0] -ne $Network) { throw 'Fixture network isolation verification failed.' }
}
function Assert-NoSecretLogs {
  $Logs = @(Invoke-Docker logs $API) -join "`n"
  foreach ($Value in @($DBPassword, $RedisPassword, $CognitoSecret, $CacheKey)) {
    if ($Logs.Contains($Value)) { throw 'Synthetic secret leaked into API logs (value withheld).' }
  }
}
function Wait-Fixture([string]$Name, [string[]]$Command) {
  $Deadline = [datetime]::UtcNow.AddSeconds(45)
  do {
    try {
      $Result = @(Invoke-Docker exec $Name @Command)
      if ($Name -ne $Redis -or ($Result -join '').Trim() -eq 'PONG') { return }
    } catch { }
    Start-Sleep -Milliseconds 500
  } while ([datetime]::UtcNow -lt $Deadline)
  throw 'Isolated backend fixture did not start.'
}
try {
  if ([string]::IsNullOrWhiteSpace($Image) -or $Image.StartsWith('-')) { throw 'A local image reference is required.' }
  # Resolve the tag once; all image operations use the immutable local ID, without pulling.
  $Info = @(Invoke-Docker image inspect $Image | ConvertFrom-Json)
  if ($Info.Count -ne 1 -or $Info[0].Os -ne 'linux' -or $Info[0].Architecture -ne 'amd64') { throw 'Image must be local linux/amd64.' }
  $ImageId = $Info[0].Id
  $User = ($Info[0].Config.User -split ':')[0]
  if ([string]::IsNullOrWhiteSpace($User) -or $User -eq 'root' -or $User -match '^0+$') { throw 'Image nonroot USER assertion failed.' }
  $NetworkAttempted = $true
  # Match the Go runner: Docker Desktop does not publish ports on --internal bridges.
  # Every configured destination is synthetic and belongs to this dedicated network.
  Invoke-Docker network create --driver bridge --label $Label $Network | Out-Null

  $Containers += $Probe
  Invoke-Docker create --interactive --name $Probe --label $Label --network none --cap-drop=ALL --security-opt=no-new-privileges --entrypoint node $ImageId --input-type=module | Out-Null
  $ProbeScript = @'
if (typeof process.getuid !== 'function' || process.getuid() === 0) throw new Error('nonroot assertion failed');
const { PrismaClient } = await import('@prisma/client');
const { PrismaPg } = await import('@prisma/adapter-pg');
const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: 'postgresql://fixture:fixture@127.0.0.1:5432/fixture' }) });
await client.$disconnect();
console.log('PASS nonroot uid and generated Prisma imports');
'@
  try { $ProbeResult = @($ProbeScript | Invoke-Docker start -ai $Probe) -join "`n" } catch { throw 'Image nonroot/Prisma runtime probe failed.' }
  if (-not $ProbeResult.Contains('PASS nonroot uid and generated Prisma imports')) { throw 'Image nonroot/Prisma runtime probe failed.' }
  $ProbeInfo = Get-OwnedContainer $Probe
  if ($ProbeInfo.State.ExitCode -ne 0) { throw 'Image nonroot/Prisma runtime probe failed.' }
  Write-Output 'PASS nonroot USER/actual uid and generated Prisma imports/constructor'

  $Containers += $DB
  Invoke-Docker run -d --name $DB --label $Label --network $Network --network-alias db --tmpfs '/var/lib/postgresql/data:rw,nosuid,nodev,size=256m' -e "POSTGRES_PASSWORD=$DBPassword" -e POSTGRES_DB=api_smoke postgres:17-alpine | Out-Null
  $Containers += $Redis
  Invoke-Docker run -d --name $Redis --label $Label --network $Network --network-alias redis --tmpfs '/data:rw,nosuid,nodev,size=64m' redis:7-alpine redis-server --appendonly no --requirepass $RedisPassword | Out-Null
  Assert-Fixture $DB
  Assert-Fixture $Redis
  Wait-Fixture $DB @('pg_isready', '-U', 'postgres', '-d', 'api_smoke')
  Wait-Fixture $Redis @('redis-cli', '--no-auth-warning', '-a', $RedisPassword, 'ping')
  # Minimal disposable schema, not the app's migrations or a shared database.
  # Recheck ownership/network immediately before the only SQL write.
  Assert-Fixture $DB
  $SQL = @"
CREATE SCHEMA image_smoke;
CREATE ROLE api_smoke LOGIN PASSWORD '$DBPassword';
GRANT CONNECT ON DATABASE api_smoke TO api_smoke;
GRANT USAGE ON SCHEMA image_smoke TO api_smoke;
"@
  $SQL | Invoke-Docker exec -i $DB psql -U postgres -d api_smoke -v ON_ERROR_STOP=1 | Out-Null

  $Containers += $API
  $APIAttempted = $true
  Invoke-Docker run -d --name $API --label $Label --network $Network --cap-drop=ALL --security-opt=no-new-privileges -p 127.0.0.1::3000 -e NODE_ENV=production -e PORT=3000 -e WEB_URL=http://127.0.0.1:5173 -e "DATABASE_URL=postgresql://api_smoke:${DBPassword}@db:5432/api_smoke?schema=image_smoke" -e "REDIS_URL=redis://:${RedisPassword}@redis:6379/0" -e "ENROLLMENT_TOKEN_CACHE_KEY=$CacheKey" -e COGNITO_REGION=ap-southeast-1 -e COGNITO_USER_POOL_ID=ap-southeast-1_fixturepool -e COGNITO_CLIENT_ID=fixture-client-id -e "COGNITO_CLIENT_SECRET=$CognitoSecret" -e AWS_EC2_METADATA_DISABLED=true $ImageId | Out-Null
  Assert-Fixture $API
  $Ports = @(Invoke-Docker port $API 3000/tcp)
  if ($Ports.Count -ne 1 -or $Ports[0].Trim() -notmatch '^127\.0\.0\.1:[1-9][0-9]{0,4}$') { throw 'API port must be loopback only.' }
  $URL = 'http://' + $Ports[0].Trim() + '/api/v1/health'
  $Deadline = [datetime]::UtcNow.AddSeconds(45)
  $Healthy = $false
  do {
    $State = Get-OwnedContainer $API
    if (-not $State.State.Running) { throw 'API startup failed: container exited.' }
    try {
      $Response = Invoke-WebRequest -UseBasicParsing -Uri $URL -TimeoutSec 3
      if ($Response.StatusCode -eq 200) { $Healthy = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 500
  } while ([datetime]::UtcNow -lt $Deadline)
  if (-not $Healthy) { throw 'API startup/health200 timed out.' }
  if (-not (Get-OwnedContainer $API).State.Running) { throw 'API startup failed after health response.' }
  Write-Output 'PASS default image startup and HTTP health200 against isolated DB/Redis'
  Assert-NoSecretLogs
  Invoke-Docker stop --time 15 $API | Out-Null
  Assert-NoSecretLogs
  Write-Output 'PASS no synthetic secret values in either API log stream'
} catch {
  # Never echo native output, response bodies, DSNs or arbitrary exception text.
  $Failure = "API image smoke failed at runner line $($_.InvocationInfo.ScriptLineNumber) [$($_.Exception.GetType().Name)] (details withheld)."
  if ($_.Exception.Message -match '^(Docker test operation failed: (image|network|create|run|start|inspect|exec|port|logs|stop)|Image |API |Fixture |Isolated |Container ownership|Synthetic secret|A local image)') {
    $Failure = $_.Exception.Message
  }
} finally {
  # Inspect attempted creations too: Docker may create an object then return nonzero.
  # Capture failure-path logs without printing their contents.
  if ($APIAttempted) {
    try {
      $Existing = @(Invoke-Docker container ls -aq --filter "name=^/$API`$")
      if ($Existing.Count -gt 0) { Get-OwnedContainer $API | Out-Null; Assert-NoSecretLogs }
    } catch { if ($null -eq $Failure) { $Failure = 'API failure-path log/ownership verification failed.' } }
  }
  for ($Index = $Containers.Count - 1; $Index -ge 0; $Index--) {
    $Name = $Containers[$Index]
    try {
      $Existing = @(Invoke-Docker container ls -aq --filter "name=^/$Name`$")
      if ($Existing.Count -eq 0) { continue }
      $Owned = Get-OwnedContainer $Name
      if ($Owned.State.Paused) { Invoke-Docker unpause $Name | Out-Null }
      # Remove by verified immutable ID, not a potentially replaced name.
      Invoke-Docker rm --force --volumes $Owned.Id | Out-Null
      if (@(Invoke-Docker container ls -aq --filter "name=^/$Name`$").Count -ne 0) { throw 'Container still exists.' }
    } catch { $CleanupErrors += 'container cleanup failed (ownership or Docker removal verification)' }
  }
  if ($NetworkAttempted) {
    try {
      $Existing = @(Invoke-Docker network ls -q --filter "name=^$Network`$")
      if ($Existing.Count -gt 0) {
        $Owned = @(Invoke-Docker network inspect $Network | ConvertFrom-Json)
        if ($Owned.Count -ne 1 -or $Owned[0].Name -ne $Network -or $Owned[0].Labels.$LabelKey -ne $RunId) { throw 'Network ownership verification failed.' }
        Invoke-Docker network rm $Owned[0].Id | Out-Null
        if (@(Invoke-Docker network ls -q --filter "name=^$Network`$").Count -ne 0) { throw 'Network still exists.' }
      }
    } catch { $CleanupErrors += 'network cleanup failed (ownership or Docker removal verification)' }
  }
}
if ($null -ne $Failure) { Write-Output $Failure }
foreach ($CleanupError in $CleanupErrors) { Write-Output $CleanupError }
if ($null -ne $Failure -or $CleanupErrors.Count -gt 0) { exit 1 }
Write-Output "IMAGE TEST PASSED (all owned fixtures removed): $Image"
exit 0
