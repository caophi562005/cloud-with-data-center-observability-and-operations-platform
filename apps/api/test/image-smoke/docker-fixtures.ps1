# Real disposable Docker fixtures using a LOCAL image; no application image builds.
# Faults are injected only at the Docker boundary, never into runtime source.
param([Parameter(Mandatory)][string]$Image, [string]$Case = 'all')
$ErrorActionPreference = 'Stop'
$PowerShellExe = (Get-Process -Id $PID).Path
$Runner = Join-Path (Split-Path -Parent $PSScriptRoot) 'image-smoke.ps1'
if ($Case -eq 'all') {
  $Expected = @{ good = 'IMAGE TEST PASSED'; missingPrisma = 'nonroot/Prisma runtime probe failed'; badStartup = 'startup'; cleanupFailure = 'cleanup failed' }
  foreach ($Name in @('missingPrisma', 'badStartup', 'cleanupFailure', 'good')) {
    $PreviousPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      $Output = @(& $PowerShellExe -NoProfile -File $PSCommandPath -Image $Image -Case $Name 2>&1 | ForEach-Object { $_.ToString() })
      $Code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $PreviousPreference }
    $Text = $Output -join "`n"
    if (($Name -eq 'good' -and $Code -ne 0) -or ($Name -ne 'good' -and $Code -eq 0) -or -not $Text.Contains($Expected[$Name])) { throw "Real Docker fixture $Name failed: exit=$Code; $Text" }
    if (-not $Text.Contains('PASS real fixture recovery: no owned resources remain')) { throw "Real fixture $Name recovery not verified." }
    Write-Output "PASS real Docker runner fixture: $Name"
  }
  Write-Output 'Real Docker runner fixtures: 4/4 PASS (local supplied image only)'
  exit 0
}
if ($Case -notin @('good', 'missingPrisma', 'badStartup', 'cleanupFailure')) { throw 'Unknown Docker fixture case.' }
$global:ApiSmokeDockerExe = (Get-Command docker.exe).Source
$global:ApiSmokeDockerRecords = @{}
$global:ApiSmokeDockerNetworks = @{}
$global:ApiSmokeFaultInjected = $false
function docker {
  $A = @($args | ForEach-Object { [string]$_ })
  if ($A[0] -eq 'run' -or $A[0] -eq 'create') {
    $Name = $A[[array]::IndexOf($A, '--name') + 1]
    $Label = $A[[array]::IndexOf($A, '--label') + 1].Split('=', 2)
    $global:ApiSmokeDockerRecords[$Name] = $Label[1]
    if ($Case -eq 'missingPrisma' -and $Name.EndsWith('-probe')) {
      $A = @($A[0], '--tmpfs', '/app/node_modules:rw,nosuid,nodev,size=1m') + $A[1..($A.Count - 1)]
      $global:ApiSmokeFaultInjected = $true
    }
    if ($Case -eq 'badStartup' -and $Name.EndsWith('-api')) {
      $A = $A[0..($A.Count - 2)] + @('-e', 'PORT=invalid', $A[-1])
      $global:ApiSmokeFaultInjected = $true
    }
  }
  if ($A[0] -eq 'network' -and $A[1] -eq 'create') {
    $Label = $A[[array]::IndexOf($A, '--label') + 1].Split('=', 2)
    $global:ApiSmokeDockerNetworks[$A[-1]] = $Label[1]
  }
  if ($Case -eq 'cleanupFailure' -and $A[0] -eq 'rm' -and -not $global:ApiSmokeFaultInjected) {
    $global:ApiSmokeFaultInjected = $true
    $global:LASTEXITCODE = 1
    return
  }
  $Result = @($input | & $global:ApiSmokeDockerExe @A 2>&1 | ForEach-Object { $_.ToString() })
  $Code = $LASTEXITCODE
  if ($A[0] -eq 'port' -and $Code -ne 0) {
    # Only native port errors and state/port metadata are diagnostic, never env/logs.
    Write-Host ('Local fixture port diagnostic: ' + ($Result -join ' '))
    $State = @(& $global:ApiSmokeDockerExe inspect $A[1] | ConvertFrom-Json)[0]
    Write-Host "Local fixture running=$($State.State.Running) exit=$($State.State.ExitCode) portMappingCount=$(@($State.NetworkSettings.Ports.PSObject.Properties).Count)"
  }
  $global:LASTEXITCODE = $Code
  return $Result
}
& $Runner -Image $Image
$RunnerCode = $LASTEXITCODE
$RecoveryFailed = $false
# The cleanup-failure case deliberately leaves one owned object. Recover ONLY exact
# recorded names with the verified run label and immutable ID; never prune Docker.
foreach ($Name in $global:ApiSmokeDockerRecords.Keys) {
  $IDs = @(& $global:ApiSmokeDockerExe container ls -aq --filter "name=^/$Name`$")
  if ($LASTEXITCODE -ne 0) { $RecoveryFailed = $true; continue }
  if ($IDs.Count -eq 0) { continue }
  $Info = @(& $global:ApiSmokeDockerExe inspect $Name | ConvertFrom-Json)[0]
  if ($LASTEXITCODE -ne 0 -or $Info.Name -ne "/$Name" -or $Info.Config.Labels.'opsgrid.api-image-smoke.run' -ne $global:ApiSmokeDockerRecords[$Name]) { $RecoveryFailed = $true; continue }
  & $global:ApiSmokeDockerExe rm --force --volumes $Info.Id *> $null
  if ($LASTEXITCODE -ne 0 -or @(& $global:ApiSmokeDockerExe container ls -aq --filter "name=^/$Name`$").Count -ne 0) { $RecoveryFailed = $true }
}
foreach ($Name in $global:ApiSmokeDockerNetworks.Keys) {
  $IDs = @(& $global:ApiSmokeDockerExe network ls -q --filter "name=^$Name`$")
  if ($LASTEXITCODE -ne 0) { $RecoveryFailed = $true; continue }
  if ($IDs.Count -eq 0) { continue }
  $Info = @(& $global:ApiSmokeDockerExe network inspect $Name | ConvertFrom-Json)[0]
  if ($LASTEXITCODE -ne 0 -or $Info.Name -ne $Name -or $Info.Labels.'opsgrid.api-image-smoke.run' -ne $global:ApiSmokeDockerNetworks[$Name]) { $RecoveryFailed = $true; continue }
  & $global:ApiSmokeDockerExe network rm $Info.Id *> $null
  if ($LASTEXITCODE -ne 0 -or @(& $global:ApiSmokeDockerExe network ls -q --filter "name=^$Name`$").Count -ne 0) { $RecoveryFailed = $true }
}
if ($RecoveryFailed) { throw 'Real fixture recovery failed; operator must inspect labeled fixture resources.' }
if ($Case -ne 'good' -and -not $global:ApiSmokeFaultInjected) { throw 'Requested real fixture fault was not exercised.' }
Write-Output 'PASS real fixture recovery: no owned resources remain'
exit $RunnerCode
