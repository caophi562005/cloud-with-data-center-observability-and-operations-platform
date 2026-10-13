# Boundary fixtures execute the real runner; only Docker/HTTP external effects are replaced.
# Each case catches a specific unsafe success or unsafe cleanup regression.
param([string]$Case = 'all', [ValidateSet('none', 'container', 'network')][string]$Mutation = 'none')
$ErrorActionPreference = 'Stop'
$PowerShellExe = (Get-Process -Id $PID).Path
$Runner = Join-Path (Split-Path -Parent $PSScriptRoot) 'image-smoke.ps1'
$Cases = @{
  good = @(0, 'IMAGE TEST PASSED')
  root = @(1, 'nonroot')
  prisma = @(1, 'Prisma')
  startup = @(1, 'startup')
  secret = @(1, 'Synthetic secret')
  cleanup = @(1, 'cleanup failed')
  networkCleanup = @(1, 'cleanup failed')
  wrongOwner = @(1, 'ownership')
  wrongNetworkOwner = @(1, 'ownership')
  partialCreate = @(1, 'Docker test operation failed: run')
  badPort = @(1, 'loopback')
}
if ($Case -eq 'all') {
  if (-not (Test-Path -LiteralPath $Runner)) { throw 'RED: image smoke runner is not implemented.' }
  if ($Mutation -ne 'none') { throw 'Mutation must target one foreign-owner case.' }
  # A missing ownership guard must be rejected by assertions outside runner cleanup.
  foreach ($Fault in @('container', 'network')) {
    $ForeignCase = if ($Fault -eq 'container') { 'wrongOwner' } else { 'wrongNetworkOwner' }
    $PreviousPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      $Output = @(& $PowerShellExe -NoProfile -File $PSCommandPath -Case $ForeignCase -Mutation $Fault 2>&1 | ForEach-Object { $_.ToString() })
      $Code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $PreviousPreference }
    $ForbiddenVerdict = if ($Fault -eq 'container') { 'FORBIDDEN removal attempted: containers=1 networks=0' } else { 'FORBIDDEN removal attempted: containers=0 networks=1' }
    if ($Code -ne 1 -or -not ($Output -join "`n").Contains($ForbiddenVerdict)) { throw "Mutation $Fault escaped independent forbidden-removal assertion: exit=$Code; $($Output -join ' ')" }
    Write-Output "PASS ownership mutation rejected: $Fault"
  }
  $Passed = 0
  foreach ($Name in ($Cases.Keys | Sort-Object)) {
    $PreviousPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      $Output = @(& $PowerShellExe -NoProfile -File $PSCommandPath -Case $Name 2>&1 | ForEach-Object { $_.ToString() })
      $Code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $PreviousPreference }
    $Text = $Output -join "`n"
    $Expected = $Cases[$Name]
    if (($Expected[0] -eq 0 -and $Code -ne 0) -or ($Expected[0] -ne 0 -and $Code -eq 0) -or -not $Text.Contains($Expected[1])) {
      throw "Fixture $Name failed: exit=$Code; $Text"
    }
    if ($Text.Contains('FORBIDDEN removal attempted:')) { throw "Fixture $Name attempted foreign-owned removal." }
    if ($Name -in @('wrongOwner', 'wrongNetworkOwner') -and -not $Text.Contains('PASS forbidden removals: containers=0 networks=0')) { throw "Fixture $Name did not independently verify forbidden-removal counters." }
    if ($Text.Contains('fixture-db-password') -or $Text.Contains('fixture-cognito-secret')) { throw "Fixture $Name exposed a synthetic credential." }
    Write-Output "PASS runner fixture: $Name"
    $Passed++
  }
  Write-Output "Runner fixtures: $Passed/$($Cases.Count) PASS"
  exit 0
}
if (-not $Cases.ContainsKey($Case)) { throw 'Unknown fixture case.' }
$global:ApiImageFixtureContainers = @{}
$global:ApiImageFixtureNetwork = $null
$global:ApiImageFixtureStarted = $false
$global:ApiImageFixtureForbiddenContainers = 0
$global:ApiImageFixtureForbiddenNetworks = 0
function docker {
  $A = @($args | ForEach-Object { [string]$_ })
  $global:LASTEXITCODE = 0
  if ($A[0] -eq 'image') {
    return '[{"Id":"sha256:fixture","Os":"linux","Architecture":"amd64","Config":{"User":"node","Env":[]}}]'
  }
  if ($A[0] -eq 'network') {
    if ($A[1] -eq 'create') {
      $LabelText = $A[[array]::IndexOf($A, '--label') + 1]
      $LabelParts = $LabelText.Split('=', 2)
      $global:ApiImageFixtureNetwork = @{ Id = 'net-fixture'; Name = $A[-1]; Labels = @{ $LabelParts[0] = $LabelParts[1] } }
      return 'net-fixture'
    }
    if ($A[1] -eq 'ls') { if ($null -ne $global:ApiImageFixtureNetwork) { return 'net-fixture' }; return }
    if ($A[1] -eq 'inspect') {
      if ($Case -eq 'wrongNetworkOwner' -and $global:ApiImageFixtureStarted) { $global:ApiImageFixtureNetwork.Labels['opsgrid.api-image-smoke.run'] = 'foreign' }
      return ConvertTo-Json -InputObject @($global:ApiImageFixtureNetwork) -Depth 10 -Compress
    }
    if ($A[1] -eq 'rm') {
      if ($global:ApiImageFixtureNetwork.Labels['opsgrid.api-image-smoke.run'] -eq 'foreign') {
        $global:ApiImageFixtureForbiddenNetworks++
        throw 'UNSAFE: deleted foreign network'
      }
      if ($Case -eq 'networkCleanup') { $global:LASTEXITCODE = 1; return }
      $global:ApiImageFixtureNetwork = $null; return
    }
  }
  if ($A[0] -eq 'run' -or $A[0] -eq 'create') {
    $Name = $A[[array]::IndexOf($A, '--name') + 1]
    $LabelParts = $A[[array]::IndexOf($A, '--label') + 1].Split('=', 2)
    $global:ApiImageFixtureContainers[$Name] = @{ Id = $Name; Name = '/' + $Name; Config = @{ Labels = @{ $LabelParts[0] = $LabelParts[1] } }; State = @{ Running = $true; Paused = $false; ExitCode = 0 }; NetworkSettings = @{ Networks = @{ $global:ApiImageFixtureNetwork.Name = @{} } } }
    if ($Case -eq 'partialCreate' -and $Name.EndsWith('-db')) { $global:LASTEXITCODE = 1 }
    return $Name
  }
  if ($A[0] -eq 'start') {
    $global:ApiImageFixtureStarted = $true
    if ($Case -eq 'prisma') { $global:LASTEXITCODE = 1; return 'missing generated client' }
    if ($Case -eq 'root') { $global:LASTEXITCODE = 1; return 'root' }
    return 'PASS nonroot uid and generated Prisma imports'
  }
  if ($A[0] -eq 'container' -and $A[1] -eq 'ls') {
    $Filter = $A[[array]::IndexOf($A, '--filter') + 1]
    $Name = $Filter.Substring(7).TrimEnd('$')
    if ($global:ApiImageFixtureContainers.ContainsKey($Name)) { return $Name }; return
  }
  if ($A[0] -eq 'inspect') {
    $Item = $global:ApiImageFixtureContainers[$A[-1]]
    if ($Case -eq 'startup' -and $A[-1].EndsWith('-api')) { $Item.State.Running = $false; $Item.State.ExitCode = 1 }
    if ($Case -eq 'wrongOwner' -and $global:ApiImageFixtureStarted -and $A[-1].EndsWith('-db')) { $Item.Config.Labels['opsgrid.api-image-smoke.run'] = 'foreign' }
    return ConvertTo-Json -InputObject @($Item) -Depth 10 -Compress
  }
  if ($A[0] -eq 'exec') { if ($A -contains 'redis-cli') { return 'PONG' }; return }
  if ($A[0] -eq 'port') { if ($Case -eq 'badPort') { return '0.0.0.0:12345' }; return '127.0.0.1:12345' }
  if ($A[0] -eq 'logs') { if ($Case -eq 'secret') { return 'fixture-cognito-secret' }; return 'normal startup' }
  if ($A[0] -eq 'stop') { $global:ApiImageFixtureContainers[$A[-1]].State.Running = $false; return }
  if ($A[0] -eq 'rm') {
    $Name = $A[-1]
    if ($global:ApiImageFixtureContainers[$Name].Config.Labels['opsgrid.api-image-smoke.run'] -eq 'foreign') {
      $global:ApiImageFixtureForbiddenContainers++
      throw 'UNSAFE: deleted foreign container'
    }
    if ($Case -eq 'cleanup') { $global:LASTEXITCODE = 1; return }
    $global:ApiImageFixtureContainers.Remove($Name); return
  }
  throw "Unexpected Docker fixture operation: $($A -join ' ')"
}
function Invoke-WebRequest { param($Uri, $TimeoutSec, [switch]$UseBasicParsing); return [pscustomobject]@{ StatusCode = 200 } }
if ($Mutation -eq 'none') {
  & $Runner -Image 'fixture-api:local'
  $RunnerCode = $LASTEXITCODE
} else {
  if (($Mutation -eq 'container' -and $Case -ne 'wrongOwner') -or ($Mutation -eq 'network' -and $Case -ne 'wrongNetworkOwner')) { throw 'Mutation/case mismatch.' }
  # In-memory mutation only: never write or execute a changed production file.
  # These children still replace every Docker/HTTP effect at the existing boundary.
  $Source = Get-Content -LiteralPath $Runner -Raw -Encoding UTF8
  $Guard = if ($Mutation -eq 'container') { '-or $Items[0].Config.Labels.$LabelKey -ne $RunId' } else { '-or $Owned[0].Labels.$LabelKey -ne $RunId' }
  if ([regex]::Matches($Source, [regex]::Escape($Guard)).Count -ne 1) { throw 'Mutation guard target drifted.' }
  $Source = $Source.Replace($Guard, '')
  # Scriptblock exit would exit this fixture too; return preserves runner status
  # while permitting independent post-run assertions. Ordinary cases use its file.
  if ([regex]::Matches($Source, '(?m)\bexit [01]\b').Count -ne 2) { throw 'Mutation exit targets drifted.' }
  $Source = $Source.Replace('exit 1', '$global:ApiImageFixtureRunnerCode = 1; return').Replace('exit 0', '$global:ApiImageFixtureRunnerCode = 0; return')
  $global:ApiImageFixtureRunnerCode = $null
  & ([scriptblock]::Create($Source)) -Image 'fixture-api:local'
  if ($null -eq $global:ApiImageFixtureRunnerCode) { throw 'Mutated runner did not return a status.' }
  $RunnerCode = $global:ApiImageFixtureRunnerCode
}
# This verdict is OUTSIDE the runner and its catch/finally/native wrapper.
# A swallowed sentinel must never turn a forbidden removal into a passing case.
if ($global:ApiImageFixtureForbiddenContainers -ne 0 -or $global:ApiImageFixtureForbiddenNetworks -ne 0) {
  Write-Output "FORBIDDEN removal attempted: containers=$global:ApiImageFixtureForbiddenContainers networks=$global:ApiImageFixtureForbiddenNetworks"
  exit 1
}
Write-Output 'PASS forbidden removals: containers=0 networks=0'
exit $RunnerCode
