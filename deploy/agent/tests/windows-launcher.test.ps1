# Load FunctionDefinitionAst declarations only into an isolated child scope.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ownsBundle = [string]::IsNullOrWhiteSpace($env:OPSGRID_TEST_RELEASE_DIR)
$bundleRoot = if($ownsBundle) { Join-Path ([IO.Path]::GetTempPath()) ('opsgrid-windows-bundle-' + [guid]::NewGuid().ToString('N')) } else { [IO.Path]::GetFullPath($env:OPSGRID_TEST_RELEASE_DIR) }
try {
    if($ownsBundle) { & node (Join-Path $PSScriptRoot '..\build-release.mjs') --output $bundleRoot | Out-Null }
    else { & node (Join-Path $PSScriptRoot '..\build-release.mjs') --verify --output $bundleRoot | Out-Null }
    if ($LASTEXITCODE -ne 0) { throw 'release build or verification failed' }
    $source = Join-Path $bundleRoot 'install-launcher.ps1'
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { Write-Output '[opsgrid-agent] FAIL launcher syntax'; exit 1 }
$definitions = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false))
$script:Failures = 0
function Assert-Fixture([bool]$Condition, [string]$Name) {
    if ($Condition) { Write-Output ('[opsgrid-agent] PASS ' + $Name) }
    else { $script:Failures++; Write-Output ('[opsgrid-agent] FAIL ' + $Name) }
}
function Test-Rejected([scriptblock]$Action) { try { $null = & $Action; return $false } catch { return $true } }
& {
    foreach ($definition in $definitions) { . ([scriptblock]::Create($definition.Extent.Text)) }
    $script:OutputPrefix = '[opsgrid-agent]'; $script:TempRoot = $null; $script:ExitCode = 0
    $script:ReleaseBaseUrl = 'https://fixture.invalid/download'
    $oldEnvironmentToken = [Environment]::GetEnvironmentVariable('OPSGRID_ENROLLMENT_TOKEN','Process')
    [Environment]::SetEnvironmentVariable('OPSGRID_ENROLLMENT_TOKEN',$null,'Process')
    $root = Join-Path ([IO.Path]::GetTempPath()) ('opsgrid-launcher-fixture-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $root | Out-Null
    try {
        $literal = 'fixture;$(literal)&|<>'
        $parsed = Get-LauncherArguments @('-Token', $literal)
        Assert-Fixture ($parsed.Token -ceq $literal) 'token_literal_preserved'
        Assert-Fixture ($parsed.PSObject.Properties.Name -contains 'ApiBaseUrl') 'endpoint_interface_exists'
        if ($parsed.PSObject.Properties.Name -contains 'ApiBaseUrl') { Assert-Fixture ($parsed.ApiBaseUrl -ceq 'https://api.opsgrid.hacmieu.com') 'endpoint_default' }
        $invalid = @(@('-Token','fixture','-Token=other'),@('-Help','-Help'),@('-Token'),@('-Token='),@('-Token',"fixture`n"),@('-ApiBaseUrl'),@('-Token','fixture','-ApiBaseUrl=https://host.test','-ApiBaseUrl','https://other.test'))
        $index = 0
        foreach ($case in $invalid) { $index++; Assert-Fixture (Test-Rejected { Get-LauncherArguments $case }) ('invalid_arguments_' + $index) }
        $validator = Get-Command Test-LauncherApiBaseUrl -ErrorAction SilentlyContinue
        Assert-Fixture ($null -ne $validator) 'endpoint_validator_exists'
        if ($null -ne $validator) {
            foreach ($url in @('https://u@host.test','https://@host.test','https://host.test/','https://host.test/path','https://host.test?','https://host.test#','https://host.test:',"https://host.test`n",'http://remote.test','ftp://host.test','https://host.test\evil','https://host.test/%2e%2e')) { Assert-Fixture (Test-Rejected { Test-LauncherApiBaseUrl $url }) 'unsafe_origin_rejected' }
            foreach ($url in @('https://host.test','http://localhost:3000','http://127.0.0.1:3000','http://[::1]:3000')) { Assert-Fixture ((Test-LauncherApiBaseUrl $url) -is [uri]) 'safe_origin_accepted' }
            foreach ($form in @(@('-Token',$literal,'-ApiBaseUrl','https://api.example.test'),@(('-Token='+$literal),'-ApiBaseUrl=https://api.example.test'))) {
                $parsed = Get-LauncherArguments $form
                Assert-Fixture ($parsed.Token -ceq $literal -and $parsed.ApiBaseUrl -ceq 'https://api.example.test') 'endpoint_literal_forms'
            }
        }
        [Environment]::SetEnvironmentVariable('OPSGRID_ENROLLMENT_TOKEN','fixture-env','Process')
        $parsed = Get-LauncherArguments @()
        Assert-Fixture ($parsed.Token -ceq 'fixture-env' -and [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable('OPSGRID_ENROLLMENT_TOKEN','Process'))) 'environment_consumed_and_cleared'
        [Environment]::SetEnvironmentVariable('OPSGRID_ENROLLMENT_TOKEN','fixture-unused','Process')
        $null = Get-LauncherArguments @('-Token','fixture-explicit')
        Assert-Fixture ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable('OPSGRID_ENROLLMENT_TOKEN','Process'))) 'environment_cleared_with_explicit_token'
        [Environment]::SetEnvironmentVariable('OPSGRID_ENROLLMENT_TOKEN',$null,'Process')
        $script:TempRoot = $root
        New-Item -ItemType Directory -Path (Join-Path $root 'alloy') | Out-Null
        $installerPath = Join-Path $root 'install.ps1'; $templatePath = Join-Path $root 'alloy\windows.config.alloy.template'
        $installerText = [IO.File]::ReadAllText((Join-Path $bundleRoot 'install.ps1'))
        $templateText = [IO.File]::ReadAllText((Join-Path $bundleRoot 'alloy\windows.config.alloy.template'))
        [IO.File]::WriteAllText($installerPath, '# EnrollmentToken')
        [IO.File]::WriteAllText($templatePath, $templateText)
        Assert-Fixture (Test-Rejected { Test-LauncherAssets }) 'marker_only_installer_rejected'
        [IO.File]::WriteAllText($installerPath, $installerText)
        [IO.File]::WriteAllText($templatePath, 'local.file "agent_credential" { filename="__CREDENTIAL_FILE__"')
        Assert-Fixture (Test-Rejected { Test-LauncherAssets }) 'truncated_template_rejected'
        [IO.File]::WriteAllText($templatePath, $templateText)
        Assert-Fixture (-not (Test-Rejected { Test-LauncherAssets })) 'complete_local_pair_structural_check'
        function Invoke-WebRequest { throw 'download fixture failure with secret' }
        Assert-Fixture (Test-Rejected { Download-LauncherAsset 'install.ps1' (Join-Path $root 'failed.ps1') }) 'download_failure_rejected'
        Assert-Fixture (-not (Test-Path (Join-Path $root 'failed.ps1'))) 'download_failure_no_destination'
        function Invoke-WebRequest { param($Uri,$OutFile,$UseBasicParsing,$ErrorAction) [IO.File]::WriteAllText($OutFile,'') }
        Assert-Fixture (Test-Rejected { Download-LauncherAsset 'install.ps1' (Join-Path $root 'empty.ps1') }) 'empty_download_rejected'
        $runner = Get-Command Invoke-Launcher -ErrorAction SilentlyContinue
        Assert-Fixture ($null -ne $runner) 'launcher_orchestration_seam_exists'
        if ($null -ne $runner) {
            function New-LauncherTempRoot { $script:Downloads = 0; return $root }
            function Download-LauncherAsset { $script:Downloads++; if ($script:DownloadFails) { throw 'secret fixture' } }
            function Test-LauncherAssets { }
            function powershell.exe { $script:ChildCalls++; $script:ChildArguments = @($args); $global:LASTEXITCODE = $script:ChildExit }
            function Remove-LauncherTempRoot { return $script:CleanupOk }
            $script:ChildExit = 0; $script:CleanupOk = $true; $script:DownloadFails = $false
            foreach ($url in @('https://api.opsgrid.hacmieu.com','https://api.example.test')) {
                $script:ChildCalls = 0
                $output = @(Invoke-Launcher @('-Token',$literal,'-ApiBaseUrl',$url))
                Assert-Fixture ($script:ExitCode -eq 0 -and $script:ChildCalls -eq 1 -and $script:ChildArguments[-1] -ceq $url -and $script:ChildArguments[-3] -ceq $literal -and $script:ChildArguments[-4] -ceq '-EnrollmentToken' -and $script:ChildArguments[-2] -ceq '-ApiBaseUrl') 'literal_native_argv'
                Assert-Fixture (($output -join "`n") -notmatch 'fixture|ENR_|AGT_') 'token_not_output'
            }
            $script:ChildCalls = 0; $output = @(Invoke-Launcher @('-Token','fixture','-ApiBaseUrl','http://remote.test'))
            Assert-Fixture ($script:ExitCode -eq 10 -and $script:ChildCalls -eq 0) 'unsafe_endpoint_before_download'
            $script:DownloadFails = $true; $script:ChildCalls = 0
            $output = @(Invoke-Launcher @('-Token',$literal))
            Assert-Fixture ($script:ExitCode -eq 20 -and $script:ChildCalls -eq 0 -and ($output -join '') -notmatch 'secret|fixture') 'failed_pair_no_child_or_secret'
            $script:DownloadFails = $false; $script:ChildExit = 37
            $output = @(Invoke-Launcher @('-Token',$literal))
            Assert-Fixture ($script:ExitCode -eq 37) 'child_exit_propagated'
            $script:CleanupOk = $false
            $output = @(Invoke-Launcher @('-Token',$literal))
            Assert-Fixture ($script:ExitCode -eq 37) 'cleanup_preserves_child_failure'
            $script:ChildExit = 0
            $output = @(Invoke-Launcher @('-Token',$literal))
            Assert-Fixture ($script:ExitCode -eq 50 -and ($output -join '') -match 'cleanup failed') 'cleanup_failure_nonzero'
            Assert-Fixture (@($output | Where-Object { $_ -notlike '[[]opsgrid-agent[]]*' }).Count -eq 0) 'all_output_prefixed'
        }
    }
    finally {
        [Environment]::SetEnvironmentVariable('OPSGRID_ENROLLMENT_TOKEN',$oldEnvironmentToken,'Process')
        if ([IO.Path]::GetFileName($root) -notlike 'opsgrid-launcher-fixture-*') { throw 'unsafe fixture cleanup' }
        Remove-Item -LiteralPath $root -Recurse -Force
    }
}
if ($script:Failures) { exit 1 }
exit 0
}
finally {
    if($ownsBundle) {
    $resolvedBundleRoot = [IO.Path]::GetFullPath($bundleRoot)
    if ([IO.Path]::GetDirectoryName($resolvedBundleRoot).TrimEnd('\') -cne [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') -or [IO.Path]::GetFileName($resolvedBundleRoot) -notmatch '^opsgrid-windows-bundle-[a-f0-9]{32}$') { throw 'unsafe bundle cleanup' }
    if ([IO.Directory]::Exists($resolvedBundleRoot)) { Remove-Item -LiteralPath $resolvedBundleRoot -Recurse -Force }
    }
}
