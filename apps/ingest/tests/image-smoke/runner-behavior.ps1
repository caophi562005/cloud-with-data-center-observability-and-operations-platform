# Executes runner AST seams with synthetic Docker responses; never invokes Docker.
param([Parameter(Mandatory)][string]$Case, [Parameter(Mandatory)][string]$Runner)
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue' # Assertions concern exit status, not warning text.
$Tokens = $null; $ParseErrors = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile($Runner, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count) { throw 'Runner parse failed.' }
$Main = @($Ast.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.TryStatementAst] })[-1]
# Initialize the real run identity, environment backups and helpers, without fixtures.
foreach ($Statement in $Ast.EndBlock.Statements) {
  if ($Statement -eq $Main) { break }
  # Dynamic scriptblocks have no PSScriptRoot; builds are outside these seams.
  if ($Statement.Extent.Text.StartsWith('$Root =')) { continue }
  . ([scriptblock]::Create($Statement.Extent.Text))
}
$script:Removed = @(); $script:Unpaused = @(); $script:NetworkRemoved = $false
function docker {
  $global:LASTEXITCODE = 0
  if ($Case -eq 'environment') {
    $script:GatewayEnv = @{}
    for ($i = 0; $i -lt $args.Count; $i++) {
      if ($args[$i] -eq '-e') {
        $Pair = $args[++$i].Split('=', 2)
        $script:GatewayEnv[$Pair[0]] = $Pair[1]
      }
    }
    return 'synthetic-container-id'
  }
  if ($args[0] -eq 'inspect') {
    $Name = $args[1]
    if ($Case -eq 'container-inspect' -and $Name -eq $Gateway) { $global:LASTEXITCODE = 1; return }
    $Owner = $RunId
    if ($Case -eq 'container-owner' -and $Name -eq $Gateway) { $Owner = 'another-run' }
    return (ConvertTo-Json -Depth 5 -Compress -InputObject @(@{ Name = "/$Name"; Config = @{ Labels = @{ 'opsgrid.image-smoke.run' = $Owner } }; State = @{ Paused = ($Name -eq $DB) } }))
  }
  if ($args[0] -eq 'unpause') {
    $script:Unpaused += $args[1]
    if ($Case -eq 'unpause') { $global:LASTEXITCODE = 1 }
    return
  }
  if ($args[0] -eq 'rm') {
    $script:Removed += $args[-1]
    if ($Case -eq 'container-remove' -and $args[-1] -eq $Gateway) { $global:LASTEXITCODE = 1 }
    return
  }
  if ($args[0] -eq 'network' -and $args[1] -eq 'inspect') {
    if ($Case -eq 'network-inspect') { $global:LASTEXITCODE = 1; return }
    $Owner = $RunId
    if ($Case -eq 'network-owner') { $Owner = 'another-run' }
    return (ConvertTo-Json -Depth 4 -Compress -InputObject @(@{ Name = $Network; Labels = @{ 'opsgrid.image-smoke.run' = $Owner } }))
  }
  if ($args[0] -eq 'network' -and $args[1] -eq 'rm') {
    $script:NetworkRemoved = $true
    if ($Case -eq 'network-remove') { $global:LASTEXITCODE = 1 }
    return
  }
  throw 'Unexpected Docker seam operation.'
}
if ($Case -eq 'environment') {
  $Launch = @($Main.Body.Statements | Where-Object { $_.Extent.Text.StartsWith('Invoke-Docker run ') -and $_.Extent.Text.Contains('--name $Gateway ') })
  if ($Launch.Count -ne 1) { throw 'Gateway launch seam not found.' }
  . ([scriptblock]::Create($Launch[0].Extent.Text))
  $script:GatewayEnv | ConvertTo-Json -Compress
  exit 0
}
$Created = @($DB, $Redis, $Fixture, $Gateway); $NetworkCreated = $true
$TestBuild = $Build
New-Item -ItemType Directory -Path $TestBuild | Out-Null
$BuildCreated = $Case -ne 'temp-unowned'
if ($Case -eq 'temp-path') {
  $Build = Join-Path $TestBuild 'unexpected-child'
  New-Item -ItemType Directory -Path $Build | Out-Null
}
$Failure = $null
try { . ([scriptblock]::Create(($Main.Finally.Statements | ForEach-Object { $_.Extent.Text }) -join "`n")) }
catch { $Failure = $_.Exception.Message }
try {
  [ordered]@{
    Removed = @($script:Removed); Unpaused = @($script:Unpaused)
    NetworkRemoved = $script:NetworkRemoved
    TempRemoved = -not (Test-Path -LiteralPath $Build)
    Failure = $Failure
  } | ConvertTo-Json -Compress
} finally {
  # Test cleanup owns exactly the generated root, even when runner cleanup failed.
  $Expected = Join-Path ([System.IO.Path]::GetTempPath()) $RunId
  if ([System.IO.Path]::GetFullPath($TestBuild) -ne [System.IO.Path]::GetFullPath($Expected)) { throw 'Test cleanup path mismatch.' }
  if (Test-Path -LiteralPath $TestBuild) { Remove-Item -LiteralPath $TestBuild -Recurse -Force }
}
if ($Failure) { exit 1 }
