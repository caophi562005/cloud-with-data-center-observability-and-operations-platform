# Fixture-only runner: load declarations, never dot-source/evaluate installer top level.
param([switch]$ProfileOnly,[switch]$ResolverOnly,[switch]$AssetDriftOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ownsBundle = [string]::IsNullOrWhiteSpace($env:OPSGRID_TEST_RELEASE_DIR)
$bundleRoot = if($ownsBundle) { Join-Path ([IO.Path]::GetTempPath()) ('opsgrid-windows-bundle-' + [guid]::NewGuid().ToString('N')) } else { [IO.Path]::GetFullPath($env:OPSGRID_TEST_RELEASE_DIR) }
try {
    if($ownsBundle) { & node (Join-Path $PSScriptRoot '..\build-release.mjs') --output $bundleRoot | Out-Null }
    else { & node (Join-Path $PSScriptRoot '..\build-release.mjs') --verify --output $bundleRoot | Out-Null }
    if ($LASTEXITCODE -ne 0) { throw 'release build or verification failed' }
    $source = Join-Path $bundleRoot 'install.ps1'
    # AST-extracted functions do not execute wrapper setup; explicitly bind their
    # asset root to the generated entrypoint, never a module-relative directory.
    $script:OpsGridInstallerRoot = $bundleRoot
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { Write-Output '[opsgrid-agent] FAIL installer syntax'; exit 1 }
$definitions = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false))
$script:Failures = 0
function Assert-Fixture([bool]$Condition, [string]$Name) {
    if ($Condition) { Write-Output ('[opsgrid-agent] PASS ' + $Name) }
    else { $script:Failures++; Write-Output ('[opsgrid-agent] FAIL ' + $Name) }
}
function Test-Rejected([scriptblock]$Action) { try { $null = & $Action; return $false } catch { return $true } }
if ($ProfileOnly) {
    & {
        foreach ($definition in $definitions) { . ([scriptblock]::Create($definition.Extent.Text)) }
        $script:OutputPrefix = '[opsgrid-agent]'; $script:OpsGridFailureMarker = '__OPSGRID_FAILURE__'
        $script:OpsGridFailureCode = 0; $script:OpsGridFailureMessage = ''; $script:OpsGridExitCode = 0
        $script:OpsGridLockStream = $null
        $script:OpsGridTempPaths = New-Object 'System.Collections.Generic.List[string]'
        function Test-Rejected([scriptblock]$Action) {
            try { $null=& $Action; return $false }
            catch { return $_.Exception -isnot [Management.Automation.CommandNotFoundException] }
        }
        $root = Join-Path ([IO.Path]::GetTempPath()) ('opsgrid-profile-fixture-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $root | Out-Null
        # Defects caught: joining split tokens, stripping string data, trusting a marker,
        # accepting unreviewed topology, writes on no-op/refusal, partial recovery.
        function Run-ProfileCase([string]$Name, [scriptblock]$Test) {
            if ($ResolverOnly -and $Name -notlike 'validator_*') { return }
            if ($AssetDriftOnly -and $Name -notlike 'profile_asset_*' -and $Name -cne 'whole_config_spoof_refusal_2') { return }
            try { $ok = & $Test; Assert-Fixture ([bool]$ok) $Name }
            catch { Assert-Fixture $false $Name }
        }
        try {
            $original = @'
local.file "agent_credential" { filename = "__CREDENTIAL_FILE__" is_secret = true }
prometheus.exporter.windows "host" { enabled_collectors = ["cpu", "logical_disk", "memory", "net", "os", "system"] }
prometheus.scrape "host" { targets = prometheus.exporter.windows.host.targets forward_to = [prometheus.remote_write.ingestion.receiver] scrape_interval = "15s" }
prometheus.remote_write "ingestion" { endpoint { url = "https://Gateway.Example.test:443/api/v1/write" authorization { type = "Bearer" credentials = local.file.agent_credential.content } } }
'@
            # Synthetic transaction identity only; deliberately NOT a production allowlist.
            $target = $original + "`nfixture.component `"synthetic_transaction_only`" { value = `"a // b /* c */`" }`n"
            $script:InstallRoot = Join-Path $root 'managed'; $script:AlloyConfigDirectory = Join-Path $script:InstallRoot 'Alloy'
            New-Item -ItemType Directory -Path $script:AlloyConfigDirectory -Force | Out-Null
            $script:AgentCredentialFile = Join-Path $script:InstallRoot 'agent.credential'
            $script:AlloyCredentialConfigPath = $script:AgentCredentialFile.Replace('\','/')
            $script:InstallLockFile = Join-Path $script:InstallRoot 'install.lock'
            $config = Join-Path $script:AlloyConfigDirectory 'config.alloy'
            $originalPath = Join-Path $root 'original.template'; $profilePath = Join-Path $root 'target.template'
            [IO.File]::WriteAllText($originalPath,$original); [IO.File]::WriteAllText($profilePath,$target)
            [IO.File]::WriteAllText($script:AgentCredentialFile,'synthetic-private-identity')
            [IO.File]::WriteAllText($script:InstallLockFile,'synthetic-lock-metadata')
            $oldText = $original.Replace('__CREDENTIAL_FILE__',$script:AlloyCredentialConfigPath)
            $newText = $target.Replace('__CREDENTIAL_FILE__',$script:AlloyCredentialConfigPath)
            [IO.File]::WriteAllText($config,$oldText)
            $wal = Join-Path $script:AlloyConfigDirectory 'wal.fixture'; [IO.File]::WriteAllText($wal,'preserve-wal')
            Run-ProfileCase 'canonical_ignores_comments_and_format_not_string_data' {
                (ConvertTo-OpsGridCanonicalConfig 'a = "a // b" /* outside */') -ceq (ConvertTo-OpsGridCanonicalConfig "a=`"a // b`"`n") -and
                (ConvertTo-OpsGridCanonicalConfig 'a="a b"') -cne (ConvertTo-OpsGridCanonicalConfig 'a="ab"')
            }
            Run-ProfileCase 'canonical_split_tokens_remain_distinct' { (ConvertTo-OpsGridCanonicalConfig 'foo bar') -cne (ConvertTo-OpsGridCanonicalConfig 'foobar') }
            Run-ProfileCase 'canonical_rejects_unterminated_and_invalid_input' {
                (Test-Rejected { ConvertTo-OpsGridCanonicalConfig 'a="unfinished' }) -and (Test-Rejected { ConvertTo-OpsGridCanonicalConfig 'a /* unfinished' }) -and (Test-Rejected { ConvertTo-OpsGridCanonicalConfig 'a # invalid' })
            }
            Run-ProfileCase 'whole_original_recognized_gateway_spelling_preserved' {
                $managed = Get-OpsGridManagedWindowsConfig $config $script:AgentCredentialFile $originalPath $profilePath
                $managed.Kind -ceq 'Original' -and $managed.GatewayUrl -ceq 'https://Gateway.Example.test:443/api/v1/write' -and $managed.CredentialPath -ceq $script:AlloyCredentialConfigPath
            }
            $unsafeUrls = @('https://u@host.test/write','https://@host.test/write','http://host.test/write','https://host.test:/write','https://host.test/write?','https://host.test/write#','https://host.test\write','https://host.test/%2e%2e/write',"https://host.test/`nwrite")
            foreach ($url in $unsafeUrls) { Run-ProfileCase ('unsafe_gateway_' + [array]::IndexOf($unsafeUrls,$url)) { Test-Rejected { Test-OpsGridGatewayEndpoint $url } } }
            $spoofIndex = 0
            foreach ($spoof in @('// OpsGrid managed marker only', ($oldText + "`n" + 'custom.component "extra" {}'), $oldText.Replace('"15s"','"30s"'), $oldText.Replace('"cpu",','"cs",'), $oldText.Replace('credentials = local.file.agent_credential.content','credentials = "inline_fixture"'), $oldText.Replace('endpoint {','endpoint { url = "https://other.test/write"'), $oldText.Replace('prometheus.scrape','promet heus.scrape'), $oldText.Replace('agent_credential','agent_ credential'))) {
                [IO.File]::WriteAllText($config,$spoof)
                Run-ProfileCase ('whole_config_spoof_refusal_' + (++$spoofIndex)) { Test-Rejected { Get-OpsGridManagedWindowsConfig $config $script:AgentCredentialFile $originalPath $profilePath } }
            }
            [IO.File]::WriteAllText($config,$oldText)
            Run-ProfileCase 'missing_target_template_fails_closed' { Test-Rejected { Get-OpsGridManagedWindowsConfig $config $script:AgentCredentialFile $originalPath (Join-Path $root 'absent') } }
            Run-ProfileCase 'unsafe_credential_path_refused' { Test-Rejected { Get-OpsGridManagedWindowsConfig $config (Join-Path $root 'other') $originalPath $profilePath } }
            $junction = Join-Path $root 'redirect'; New-Item -ItemType Junction -Path $junction -Target $script:AlloyConfigDirectory | Out-Null
            try { Run-ProfileCase 'real_junction_ancestry_refusal' { Test-Rejected { Get-OpsGridManagedWindowsConfig (Join-Path $junction 'config.alloy') $script:AgentCredentialFile $originalPath $profilePath } } }
            finally { [IO.Directory]::Delete($junction) }

            # Real Windows ACLs, private bytes and File.Replace retained. Only SCM,
            # discovery/signature and validator execution are replaced (no live service).
            $service = [pscustomobject]@{ Name='alloy-fixture'; ExecutablePath='C:\synthetic\alloy.exe'; StartName='NT AUTHORITY\LocalService'; PathName='synthetic-service-command'; CimService=[pscustomobject]@{StartMode='Auto'} }
            $script:ServiceState = 'Running'; $script:ServiceCalls = New-Object 'System.Collections.Generic.List[string]'
            $script:ValidateCalls = New-Object 'System.Collections.Generic.List[string]'
            $script:FailureAt = ''; $script:FailureConsumed = $false; $script:RollbackBreak = $false; $script:AtomicCalls = 0; $script:Forbidden = 0
            $startup = [pscustomobject]@{ Start=2; DelayedExists=$true; DelayedAutoStart=1; StartMode='Auto'; StartName=$service.StartName; PathName=$service.PathName }
            function Get-OpsGridProfileStartupMetadata { $startup }
            function Test-OpsGridPreflight { }
            function Get-WindowsPlatform { [pscustomobject]@{Architecture=9} }
            function Get-OpsGridProfileTemplatePaths { [pscustomobject]@{Original=$originalPath; Target=$profilePath} }
            function Get-AlloyService { $service }
            function Get-AlloyConfigPath { $config }
            function Test-AlloyConfigPath { param($ConfigPath) (Test-OpsGridSafeRegularFile $ConfigPath) }
            function Test-AlloyOfficialPath { $true }
            function Get-Service { param($Name,$ErrorAction) [pscustomobject]@{Name=$Name;Status=$script:ServiceState} }
            function Wait-OpsGridServiceState { param($Name,$ExpectedStatus) $script:ServiceState -ceq $ExpectedStatus }
            function Invoke-FixtureService([string]$Operation,[string]$State) {
                $script:ServiceCalls.Add($Operation)
                if ($script:FailureAt -ceq $Operation -and -not $script:FailureConsumed) { $script:FailureConsumed=$true; throw 'synthetic secret error' }
                $script:ServiceState = $State
            }
            function Restart-Service {
                param($Name,[switch]$Force,$ErrorAction)
                Invoke-FixtureService 'restart' 'Running'
                if ($script:FailureAt -ceq 'activation-config-drift') { [IO.File]::WriteAllText($config,$newText + "`n" + 'custom.component "external_activation_edit" {}') }
            }
            function Stop-Service { param($Name,[switch]$Force,$ErrorAction) Invoke-FixtureService 'stop' 'Stopped' }
            function Start-Service { param($Name,$ErrorAction) Invoke-FixtureService 'start' 'Running' }
            function Resume-Service { param($Name,$ErrorAction) Invoke-FixtureService 'resume' 'Running' }
            function Suspend-Service { param($Name,$ErrorAction) Invoke-FixtureService 'pause' 'Paused' }
            function Set-Service { $script:Forbidden++; throw 'startup write forbidden' }
            function Set-OpsGridCredential { $script:Forbidden++; throw 'credential write forbidden' }
            function Invoke-Enrollment { $script:Forbidden++; throw 'enrollment forbidden' }
            function Read-EnrollmentToken { $script:Forbidden++; throw 'token read forbidden' }
            function Install-AlloyOfficial { $script:Forbidden++; throw 'install forbidden' }
            function Invoke-WebRequest { $script:Forbidden++; throw 'download forbidden' }
            function Remove-OpsGridFreshService { $script:Forbidden++; throw 'uninstall forbidden' }
            function Restore-OpsGridTransaction { $script:Forbidden++; throw 'generic recovery forbidden' }
            function Invoke-AlloyValidate {
                param($AlloyPath,$ConfigPath)
                if ($AlloyPath -cne $service.ExecutablePath) { throw 'wrong validator' }
                $script:ValidateCalls.Add($ConfigPath)
                if ($script:FailureAt -ceq 'target-asset-drift' -and $ConfigPath -ceq $config) {
                    # Syntactically valid alternate target, not malformed lexer input.
                    [IO.File]::WriteAllText($profilePath,$script:ReplacementTarget)
                    [IO.File]::WriteAllText($originalPath,$original + "`n" + 'custom.component "external_original_edit" {}')
                }
                if (($script:FailureAt -eq 'old-validate' -and $ConfigPath -eq $config) -or ($script:FailureAt -eq 'staged-validate' -and $ConfigPath -ne $config)) { throw 'synthetic secret validator error' }
                if ($script:FailureAt -eq 'drift' -and $ConfigPath -ne $config) { [IO.File]::WriteAllText($config,'external drift') }
                if ($script:FailureAt -eq 'credential-drift' -and $ConfigPath -ne $config) { [IO.File]::WriteAllText($script:AgentCredentialFile,'external identity drift') }
                if ($script:FailureAt -eq 'acl-drift' -and $ConfigPath -ne $config) { $acl=Get-Acl $config; $acl.SetAccessRuleProtection($false,$true); Set-Acl $config $acl }
                $true
            }
            function Invoke-OpsGridAtomicReplace {
                param($Source,$Destination)
                $script:AtomicCalls++
                $metadataPath=Join-Path ([IO.Path]::GetDirectoryName($Source)) 'original.config.acl.json'
                $metadata=Get-Content -Raw -LiteralPath $metadataPath | ConvertFrom-Json
                if($metadata.ConfigPath -cne $Destination -or [string]::IsNullOrEmpty($metadata.ConfigAcl) -or $metadata.PSObject.Properties.Name -contains 'CredentialBytes') { throw 'missing or unsafe private original ACL receipt' }
                $script:AtomicMetadataOriginalAcl=$metadata.ConfigAcl
                if($script:AtomicCalls -eq 1 -and $script:FailureAt -eq 'replace-missing-destination') {
                    [IO.File]::Move($Destination,($Destination + '.external-moved'))
                    throw 'synthetic missing destination exception with secret marker AGT_fixture'
                }
                if (($script:FailureAt -eq 'replace' -and -not $script:FailureConsumed) -or ($script:RollbackBreak -and $script:AtomicCalls -gt 1)) {
                    if($script:RollbackBreak) { [IO.File]::WriteAllText((Join-Path ([IO.Path]::GetDirectoryName($Source)) 'disposable.stdout'),'AGT_fixture_new_transcript') }
                    $script:FailureConsumed=$true; throw 'synthetic secret replacement error'
                }
                [IO.File]::Replace($Source,$Destination,[System.Management.Automation.Language.NullString]::Value,$true)
                if($script:AtomicCalls -eq 1 -and $script:FailureAt -eq 'postreplace-external-bytes-return') {
                    [IO.File]::WriteAllText($Destination,($newText + "`n// external valid config edited after native replace"))
                    return
                }
                if($script:AtomicCalls -eq 1 -and $script:FailureAt -eq 'postreplace') { throw 'synthetic postreplace failure' }
                if($script:AtomicCalls -eq 1 -and $script:FailureAt -in @('postreplace-external-root','postreplace-external-credential-acl','postreplace-external-credential-bytes')) {
                    if($script:FailureAt -eq 'postreplace-external-credential-bytes') { [IO.File]::WriteAllText($script:AgentCredentialFile,'synthetic-external-credential-edit') }
                    else {
                        $driftPath=if($script:FailureAt -eq 'postreplace-external-root') {$script:InstallRoot} else {$script:AgentCredentialFile}
                        $acl=Get-Acl $driftPath; $sid=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')
                        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Read','Allow'))
                        Set-OpsGridProfileAcl $driftPath $acl.GetSecurityDescriptorSddlForm('Access,Owner,Group') -Directory:($driftPath -ceq $script:InstallRoot)
                    }
                    throw 'synthetic external ownership drift after replace'
                }
                if($script:AtomicCalls -eq 1 -and $script:FailureAt -eq 'postreplace-external-acl') {
                    $acl=Get-Acl $Destination; $sid=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')
                    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Read','Allow'))
                    Set-OpsGridProfileAcl $Destination $acl.GetSecurityDescriptorSddlForm('Access,Owner,Group')
                    throw 'synthetic external ACL drift after replace'
                }
            }
            function Set-ProfileFixtureAcl([string]$Path,[bool]$Directory,[bool]$ServiceRead) {
                $acl = if($Directory) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }
                $caller=[Security.Principal.WindowsIdentity]::GetCurrent().User
                $acl.SetOwner($caller); $acl.SetAccessRuleProtection($true,$false)
                foreach($sid in @($caller,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')),(New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))) {
                    if($Directory) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')) }
                    else { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow')) }
                }
                if($ServiceRead) {
                    $sid=New-Object Security.Principal.SecurityIdentifier('S-1-5-19')
                    if($Directory) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')) }
                    else { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Read','Allow')) }
                }
                if($PSVersionTable.PSVersion.Major -ge 7) {
                    if($Directory) { [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($Path),$acl) }
                    else { [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($Path),$acl) }
                }
                elseif($Directory) { [IO.Directory]::SetAccessControl($Path,$acl) }
                else { [IO.File]::SetAccessControl($Path,$acl) }
            }
            Set-ProfileFixtureAcl $script:InstallRoot $true $true
            Set-ProfileFixtureAcl $script:AlloyConfigDirectory $true $true
            Set-ProfileFixtureAcl $script:InstallLockFile $false $false
            Set-ProfileFixtureAcl $script:AgentCredentialFile $false $true
            Set-ProfileFixtureAcl $config $false $true
            $rootSddl = (Get-Acl $script:InstallRoot).Sddl; $parentSddl = (Get-Acl $script:AlloyConfigDirectory).Sddl
            $configSddl = (Get-Acl $config).Sddl; $credentialSddl = (Get-Acl $script:AgentCredentialFile).Sddl
            $credentialBytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($script:AgentCredentialFile))
            $lockBytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($script:InstallLockFile)); $lockSddl=(Get-Acl $script:InstallLockFile).Sddl
            function Reset-ProfileFixture([string]$State,[string]$Text) {
                Release-OpsGridLock
                $script:ServiceState=$State; $script:ServiceCalls.Clear(); $script:ValidateCalls.Clear(); $script:FailureAt=''; $script:FailureConsumed=$false; $script:RollbackBreak=$false; $script:AtomicCalls=0; $script:Forbidden=0
                $script:OpsGridExitCode=0; $script:OpsGridFailureCode=0; $script:OpsGridFailureMessage=''
                [IO.File]::WriteAllText($config,$Text); Set-ProfileFixtureAcl $config $false $true
                [IO.File]::WriteAllBytes($script:AgentCredentialFile,[Convert]::FromBase64String($credentialBytes))
            }
            function Test-ProfileInvariants {
                (Get-Acl $script:InstallRoot).Sddl -ceq $rootSddl -and (Get-Acl $script:AlloyConfigDirectory).Sddl -ceq $parentSddl -and
                (Get-Acl $config).Sddl -ceq $configSddl -and (Get-Acl $script:AgentCredentialFile).Sddl -ceq $credentialSddl -and
                [Convert]::ToBase64String([IO.File]::ReadAllBytes($script:AgentCredentialFile)) -ceq $credentialBytes -and
                [IO.File]::ReadAllText($wal) -ceq 'preserve-wal' -and $startup.Start -eq 2 -and $startup.DelayedAutoStart -eq 1 -and $script:Forbidden -eq 0 -and
                [Convert]::ToBase64String([IO.File]::ReadAllBytes($script:InstallLockFile)) -ceq $lockBytes -and (Get-Acl $script:InstallLockFile).Sddl -ceq $lockSddl
            }
            # Parent-approved emergency scope: upstream names the signed payload
            # alloy-windows-amd64.exe. Only exact layouts/names, no binary probing.
            & {
                . ([scriptblock]::Create(($definitions | Where-Object Name -eq 'Test-AlloyOfficialPath').Extent.Text))
                $wrapper='C:\Program Files\GrafanaLabs\Alloy\alloy-service-windows-amd64.exe'
                $payload='C:\Program Files\GrafanaLabs\Alloy\alloy-windows-amd64.exe'
                $signedPaths=@($wrapper,$payload); $signatureStatus='Valid'
                function Test-OpsGridSafeRegularFile { param([string]$Path) $Path -cin $signedPaths }
                function Get-AuthenticodeSignature { param($FilePath,$ErrorAction) [pscustomobject]@{Status=$signatureStatus;SignerCertificate=[pscustomobject]@{Subject='CN=Grafana Labs'}} }
                $bundle=[pscustomobject]@{Name='alloy-fixture';ExecutablePath=$wrapper}
                Run-ProfileCase 'validator_official_upstream_payload_name_allowed' { Test-AlloyOfficialPath $payload }
                Run-ProfileCase 'validator_wrapper_exact_signed_sibling_resolved' { (Get-OpsGridAlloyValidationExecutable $bundle) -ceq $payload }
                Run-ProfileCase 'validator_direct_payload_resolved' { (Get-OpsGridAlloyValidationExecutable ([pscustomobject]@{ExecutablePath=$payload})) -ceq $payload }
                Run-ProfileCase 'validator_outside_layout_refused' { -not (Test-AlloyOfficialPath 'C:\untrusted\alloy-windows-amd64.exe') }
                $signatureStatus='NotSigned'
                Run-ProfileCase 'validator_unsigned_payload_refused' { Test-Rejected { Get-OpsGridAlloyValidationExecutable $bundle } }
                $signatureStatus='Valid'; $signedPaths=@($wrapper)
                Run-ProfileCase 'validator_missing_or_reparse_sibling_refused' { Test-Rejected { Get-OpsGridAlloyValidationExecutable $bundle } }
                # Load the real fresh orchestration only, not installer top level;
                # no install/download/enrollment/SCM operation may escape this scope.
                function Acquire-OpsGridLock { }
                function Get-AlloyService { $bundle }
                function Test-AlloyConfigPath { $true }
                function New-OpsGridTransactionSnapshot { [pscustomobject]@{InstallRootExistedBeforeRun=$true} }
                function Get-AlloyServiceIdentity { $null }
                function Restore-OpsGridTransaction { }
                function Remove-OpsGridTempPaths { $true }
                function Remove-OpsGridFreshInstallRoot { $true }
                function Invoke-Enrollment { $script:FixtureDispatches++; throw 'synthetic dispatch sentinel' }
                $script:AlloyInstallDirectory=$root
                $ApplyProfile=$null; $Help=$false; $ApiBaseUrl='https://api.example.test'; $EnrollmentToken='synthetic-no-dispatch'
                $script:FixtureDispatches=0
                Run-ProfileCase 'validator_missing_before_enrollment_zero_dispatch' {
                    $null=Invoke-OpsGrid
                    $script:OpsGridExitCode -eq 20 -and $script:FixtureDispatches -eq 0 -and -not $script:OpsGridEnrollmentDispatched
                }
            }
            foreach ($assetChange in @('custom','cadence','gateway')) {
                Reset-ProfileFixture 'Running' $oldText
                $script:FailureAt='target-asset-drift'
                $script:ReplacementTarget=switch($assetChange) {
                    'custom' { $target + "`n" + 'custom.component "unreviewed_but_valid" {}' }
                    'cadence' { $target.Replace('"15s"','"30s"') }
                    'gateway' { $target.Replace('https://Gateway.Example.test:443/api/v1/write','https://unreviewed.example.test/write') }
                }
                try {
                    Run-ProfileCase ('profile_asset_pins_reviewed_target_' + $assetChange) {
                        $null=Invoke-OpsGridApplyProfile 'windows-baseline-v1'
                        $script:OpsGridExitCode -eq 0 -and $script:AtomicCalls -eq 1 -and $script:ValidateCalls.Count -eq 2 -and
                        [IO.File]::ReadAllText($config) -ceq $newText -and [IO.File]::ReadAllText($profilePath) -ceq $script:ReplacementTarget -and
                        ($script:ServiceCalls -join ',') -ceq 'restart' -and (Test-ProfileInvariants)
                    }
                }
                finally { [IO.File]::WriteAllText($originalPath,$original); [IO.File]::WriteAllText($profilePath,$target) }
            }
            Reset-ProfileFixture 'Running' $oldText; $script:FailureAt='activation-config-drift'
            Run-ProfileCase 'profile_asset_postactivation_drift_nonzero_without_overwrite' {
                $out=@(Invoke-OpsGridApplyProfile 'windows-baseline-v1')
                $script:OpsGridExitCode -eq 50 -and $script:AtomicCalls -eq 1 -and ($script:ServiceCalls -join ',') -ceq 'restart' -and
                [IO.File]::ReadAllText($config) -ceq ($newText + "`n" + 'custom.component "external_activation_edit" {}') -and
                ($out -join '') -match 'operator recovery required' -and ($out -join '') -notmatch 'synthetic secret|AGT_|ENR_' -and
                @(Get-ChildItem -LiteralPath $script:AlloyConfigDirectory -Directory -Filter '.opsgrid-profile-*' | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'original.config') }).Count -eq 1 -and (Test-ProfileInvariants)
            }
            foreach ($state in @('Running','Stopped','Paused')) {
                Reset-ProfileFixture $state ("// formatting preserved`r`n" + $newText)
                $before=[Convert]::ToBase64String([IO.File]::ReadAllBytes($config))
                Run-ProfileCase ('profile_noop_is_zero_mutation_' + $state) {
                    $null = Invoke-OpsGridApplyProfile 'windows-baseline-v1'
                    $script:OpsGridExitCode -eq 0 -and $script:ServiceState -ceq $state -and $script:ServiceCalls.Count -eq 0 -and $script:AtomicCalls -eq 0 -and
                    $script:ValidateCalls.Count -eq 1 -and $script:ValidateCalls[0] -ceq $config -and [Convert]::ToBase64String([IO.File]::ReadAllBytes($config)) -ceq $before -and (Test-ProfileInvariants)
                }
                Reset-ProfileFixture $state $oldText
                Run-ProfileCase ('profile_change_preserves_exact_state_security_identity_' + $state) {
                    $null = Invoke-OpsGridApplyProfile 'windows-baseline-v1'
                    $wantCalls = switch($state) { 'Running' {'restart'} 'Stopped' {''} 'Paused' {'resume,restart,pause'} }
                    $script:OpsGridExitCode -eq 0 -and $script:ServiceState -ceq $state -and ($script:ServiceCalls -join ',') -ceq $wantCalls -and $script:AtomicCalls -eq 1 -and
                    $script:ValidateCalls.Count -eq 2 -and $script:ValidateCalls[0] -ceq $config -and [IO.Path]::GetPathRoot($script:ValidateCalls[1]) -ceq [IO.Path]::GetPathRoot($config) -and
                    [IO.File]::ReadAllText($config) -ceq $newText -and (Test-ProfileInvariants)
                }
                foreach ($failure in @('old-validate','staged-validate','replace')) {
                    Reset-ProfileFixture $state $oldText; $script:FailureAt=$failure
                    Run-ProfileCase ('profile_premutation_failure_untouched_' + $state + '_' + $failure) {
                        $out=@(Invoke-OpsGridApplyProfile 'windows-baseline-v1')
                        $script:OpsGridExitCode -ne 0 -and $script:ServiceState -ceq $state -and $script:ServiceCalls.Count -eq 0 -and [IO.File]::ReadAllText($config) -ceq $oldText -and (Test-ProfileInvariants) -and ($out -join '') -notmatch 'synthetic secret|identity|AGT_|ENR_'
                    }
                }
                if ($state -ne 'Stopped') {
                    foreach ($failure in $(if($state -eq 'Running') {@('restart')} else {@('resume','restart','pause')})) {
                        Reset-ProfileFixture $state $oldText; $script:FailureAt=$failure
                        Run-ProfileCase ('profile_activation_failure_exact_rollback_' + $state + '_' + $failure) {
                            $out=@(Invoke-OpsGridApplyProfile 'windows-baseline-v1')
                            $script:OpsGridExitCode -eq 50 -and $script:ServiceState -ceq $state -and [IO.File]::ReadAllText($config) -ceq $oldText -and (Test-ProfileInvariants) -and ($out -join '') -notmatch 'synthetic secret|AGT_|ENR_'
                        }
                    }
                }
            }
            foreach ($failure in @('drift','credential-drift','acl-drift')) {
                Reset-ProfileFixture 'Running' $oldText; $script:FailureAt=$failure
                Run-ProfileCase ('lock_held_toctou_refusal_' + $failure) {
                    $null=Invoke-OpsGridApplyProfile 'windows-baseline-v1'
                    $script:OpsGridExitCode -ne 0 -and $script:ServiceCalls.Count -eq 0 -and $script:AtomicCalls -eq 0 -and $script:Forbidden -eq 0
                }
            }
            Reset-ProfileFixture 'Running' '// marker only'
            Run-ProfileCase 'refusal_does_not_repair_root_or_lock_acl' {
                $null=Invoke-OpsGridApplyProfile 'windows-baseline-v1'
                $script:OpsGridExitCode -ne 0 -and $script:ServiceCalls.Count -eq 0 -and $script:AtomicCalls -eq 0 -and (Test-ProfileInvariants)
            }
            Reset-ProfileFixture 'Running' $oldText; $script:FailureAt='restart'; $script:RollbackBreak=$true
            Run-ProfileCase 'rollback_failure_nonzero_redacted_operator_recovery' {
                $out=@(Invoke-OpsGridApplyProfile 'windows-baseline-v1'); $text=$out -join "`n"
                $script:OpsGridExitCode -eq 50 -and $text -match 'operator recovery required' -and $text -notmatch 'synthetic secret|AGT_|ENR_' -and $script:Forbidden -eq 0
            }
            Run-ProfileCase 'retained_profile_metadata_complete_private_originals_only' {
                $directory=@(Get-ChildItem -LiteralPath $script:AlloyConfigDirectory -Directory -Filter '.opsgrid-profile-*' | Where-Object { [IO.File]::Exists((Join-Path $_.FullName 'original.config.acl.json')) })[-1]
                $raw=[IO.File]::ReadAllText((Join-Path $directory.FullName 'original.config.acl.json'))
                $metadata=$raw | ConvertFrom-Json
                $names=@(Get-ChildItem -LiteralPath $directory.FullName -Force | ForEach-Object {$_.Name})
                $metadata.SchemaVersion -eq 1 -and $metadata.ServiceName -ceq $service.Name -and $metadata.OriginalStatus -ceq 'Running' -and
                $metadata.ConfigPath -ceq $config -and $metadata.ParentPath -ceq $script:AlloyConfigDirectory -and
                $metadata.InstallRoot -ceq $script:InstallRoot -and $metadata.CredentialPath -ceq $script:AgentCredentialFile -and
                $metadata.RootAcl -ceq (Get-Acl $script:InstallRoot).Sddl -and $metadata.CredentialAcl -ceq (Get-Acl $script:AgentCredentialFile).Sddl -and
                $metadata.Startup.Start -eq 2 -and $metadata.Startup.DelayedExists -and $metadata.Startup.DelayedAutoStart -eq 1 -and $metadata.Startup.StartName -ceq $service.StartName -and
                $raw -notmatch 'CredentialBytes|CimService|synthetic-private-identity|AGT_|ENR_' -and
                $names.Count -eq 2 -and $names -contains 'original.config' -and $names -contains 'original.config.acl.json'
            }
            Reset-ProfileFixture 'Running' $oldText
            $held=[IO.File]::Open($script:InstallLockFile,'Open','Read','None')
            try { Run-ProfileCase 'profile_existing_lock_contention_refuses_without_mutation' {
                $null=Invoke-OpsGridApplyProfile 'windows-baseline-v1'
                $script:OpsGridExitCode -eq 20 -and $script:ServiceCalls.Count -eq 0 -and $script:AtomicCalls -eq 0 -and [IO.File]::ReadAllText($config) -ceq $oldText
            } } finally { $held.Dispose() }
            Reset-ProfileFixture 'Running' $oldText
            $absentLock = Join-Path $script:InstallRoot 'absent.lock'; $savedLock=$script:InstallLockFile; $script:InstallLockFile=$absentLock
            try { Run-ProfileCase 'profile_missing_lock_no_create_or_repair' { $null=Invoke-OpsGridApplyProfile 'windows-baseline-v1'; $script:OpsGridExitCode -eq 20 -and -not [IO.File]::Exists($absentLock) -and $script:AtomicCalls -eq 0 } }
            finally { $script:InstallLockFile=$savedLock }
            Run-ProfileCase 'profile_unknown_name_refuses_before_preflight' { $null=Invoke-OpsGridApplyProfile 'unreviewed-profile'; $script:OpsGridExitCode -eq 10 -and $script:AtomicCalls -eq 0 }

            # Real inherited/unprotected destination, with different caller rights
            # under the config parent versus private staging parent. Never real SCM.
            $acl=Get-Acl $script:AlloyConfigDirectory
            $caller=[Security.Principal.WindowsIdentity]::GetCurrent().User
            $acl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($caller,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
            Set-OpsGridProfileAcl $script:AlloyConfigDirectory $acl.GetSecurityDescriptorSddlForm('Access,Owner,Group') -Directory
            $parentSddl=(Get-Acl $script:AlloyConfigDirectory).Sddl
            $nativeAclDefinition=($definitions | Where-Object Name -eq 'Set-OpsGridProfileAcl').Extent.Text
            . ([scriptblock]::Create($nativeAclDefinition.Replace('function Set-OpsGridProfileAcl(','function Set-FixtureNativeProfileAcl(')))
            function Set-OpsGridProfileAcl {
                param([string]$Path,[string]$Sddl,[switch]$Directory)
                if($Path -ceq $config -and $script:AtomicCalls -eq 1 -and $script:FailureAt -eq 'destination-acl' -and -not $script:FailureConsumed) {
                    $script:FailureConsumed=$true; throw 'synthetic destination ACL finalization failure'
                }
                Set-FixtureNativeProfileAcl $Path $Sddl -Directory:$Directory
            }
            function Reset-InheritedProfileFixture([string]$Text) {
                Reset-ProfileFixture 'Running' $Text
                $acl=New-Object Security.AccessControl.FileSecurity
                $acl.SetOwner($caller); $acl.SetAccessRuleProtection($false,$false)
                Set-FixtureNativeProfileAcl $config $acl.GetSecurityDescriptorSddlForm('Access,Owner,Group')
                $script:InheritedConfigSddl=(Get-Acl $config).Sddl
            }
            foreach($failure in @('','replace','restart','postreplace','destination-acl')) {
                Reset-InheritedProfileFixture $oldText
                $script:FailureAt=$failure
                Run-ProfileCase ('profile_inherited_acl_apply_or_rollback_' + $(if($failure) {$failure} else {'success'})) {
                    $beforeAcl=Get-Acl $config
                    $out=@(Invoke-OpsGridApplyProfile 'windows-baseline-v1')
                    $afterAcl=Get-Acl $config
                    $wantText=if($failure) {$oldText} else {$newText}
                    $wantExit=if($failure) {50} else {0}
                    -not $beforeAcl.AreAccessRulesProtected -and -not $afterAcl.AreAccessRulesProtected -and
                    $afterAcl.Sddl -ceq $script:InheritedConfigSddl -and $script:AtomicMetadataOriginalAcl -ceq $script:InheritedConfigSddl -and
                    ($failure -ne 'replace' -or $script:ServiceCalls.Count -eq 0) -and [IO.File]::ReadAllText($config) -ceq $wantText -and
                    $script:OpsGridExitCode -eq $wantExit -and $script:ServiceState -ceq 'Running' -and
                    ($out -join '') -notmatch 'operator recovery required|synthetic secret|AGT_|ENR_' -and
                    (Get-Acl $script:AlloyConfigDirectory).Sddl -ceq $parentSddl -and (Get-Acl $script:AgentCredentialFile).Sddl -ceq $credentialSddl -and
                    [Convert]::ToBase64String([IO.File]::ReadAllBytes($script:AgentCredentialFile)) -ceq $credentialBytes -and $script:Forbidden -eq 0
                }
            }
            Reset-InheritedProfileFixture $newText
            Run-ProfileCase 'profile_inherited_acl_noop_exact_bytes_acl_zero_service_calls' {
                $before=[Convert]::ToBase64String([IO.File]::ReadAllBytes($config))
                $null=Invoke-OpsGridApplyProfile 'windows-baseline-v1'
                $script:OpsGridExitCode -eq 0 -and $script:AtomicCalls -eq 0 -and $script:ServiceCalls.Count -eq 0 -and
                (Get-Acl $config).Sddl -ceq $script:InheritedConfigSddl -and [Convert]::ToBase64String([IO.File]::ReadAllBytes($config)) -ceq $before
            }
            Reset-InheritedProfileFixture $oldText; $script:FailureAt='replace-missing-destination'
            try {
                Run-ProfileCase 'profile_missing_commit_destination_retains_snapshot_redacted_no_repair' {
                    $out=@(Invoke-OpsGridApplyProfile 'windows-baseline-v1')
                    $script:OpsGridExitCode -eq 50 -and $script:AtomicCalls -eq 1 -and $script:ServiceCalls.Count -eq 0 -and
                    -not [IO.File]::Exists($config) -and [IO.File]::Exists($config + '.external-moved') -and
                    ($out -join '') -match 'operator recovery required' -and ($out -join '') -notmatch 'AGT_|synthetic missing' -and
                    @(Get-ChildItem -LiteralPath $script:AlloyConfigDirectory -Directory -Filter '.opsgrid-profile-*' | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'original.config.acl.json') }).Count -ge 1
                }
            }
            finally { [IO.File]::Move(($config + '.external-moved'),$config) }
            Reset-InheritedProfileFixture $oldText; $script:FailureAt='postreplace-external-bytes-return'
            $beforeSnapshots=@(Get-ChildItem -LiteralPath $script:AlloyConfigDirectory -Directory -Filter '.opsgrid-profile-*').Count
            Run-ProfileCase 'profile_native_replace_returns_unknown_bytes_no_stop_no_overwrite_retains_metadata' {
                $out=@(Invoke-OpsGridApplyProfile 'windows-baseline-v1')
                $script:OpsGridExitCode -eq 50 -and $script:AtomicCalls -eq 1 -and $script:ServiceCalls.Count -eq 0 -and
                [IO.File]::ReadAllText($config) -ceq ($newText + "`n// external valid config edited after native replace") -and
                @(Get-ChildItem -LiteralPath $script:AlloyConfigDirectory -Directory -Filter '.opsgrid-profile-*' | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'original.config.acl.json') }).Count -eq ($beforeSnapshots + 1) -and
                ($out -join '') -match 'operator recovery required' -and ($out -join '') -notmatch 'AGT_|synthetic secret' -and
                $script:ServiceState -ceq 'Running' -and $script:Forbidden -eq 0
            }
            foreach($external in @('root','credential-acl','credential-bytes')) {
                Reset-InheritedProfileFixture $oldText; $script:FailureAt='postreplace-external-' + $external
                try {
                    Run-ProfileCase ('profile_inherited_external_' + $external + '_drift_no_repair') {
                        $out=@(Invoke-OpsGridApplyProfile 'windows-baseline-v1')
                        $stillChanged=switch($external) {
                            'root' { (Get-Acl $script:InstallRoot).Sddl -cne $rootSddl }
                            'credential-acl' { (Get-Acl $script:AgentCredentialFile).Sddl -cne $credentialSddl }
                            'credential-bytes' { [IO.File]::ReadAllText($script:AgentCredentialFile) -ceq 'synthetic-external-credential-edit' }
                        }
                        $script:OpsGridExitCode -eq 50 -and $script:AtomicCalls -eq 1 -and $script:ServiceCalls.Count -eq 0 -and
                        [IO.File]::ReadAllText($config) -ceq $newText -and $stillChanged -and
                        ($out -join '') -match 'operator recovery required' -and $script:Forbidden -eq 0
                    }
                }
                finally {
                    # Fixture-owned cleanup only; production must never repair these.
                    Set-FixtureNativeProfileAcl $script:InstallRoot $rootSddl -Directory
                    Set-FixtureNativeProfileAcl $script:AgentCredentialFile $credentialSddl
                    [IO.File]::WriteAllBytes($script:AgentCredentialFile,[Convert]::FromBase64String($credentialBytes))
                }
            }
            Reset-InheritedProfileFixture $oldText; $script:FailureAt='postreplace-external-acl'
            Run-ProfileCase 'profile_inherited_external_acl_drift_refuses_recovery_overwrite' {
                $out=@(Invoke-OpsGridApplyProfile 'windows-baseline-v1')
                $script:OpsGridExitCode -eq 50 -and $script:AtomicCalls -eq 1 -and $script:ServiceCalls.Count -eq 0 -and
                (Get-Acl $config).Sddl -cne $script:InheritedConfigSddl -and [IO.File]::ReadAllText($config) -ceq $newText -and
                ($out -join '') -match 'operator recovery required' -and $script:Forbidden -eq 0
            }
        }
        finally {
            Release-OpsGridLock
            if ([IO.Path]::GetFileName($root) -notlike 'opsgrid-profile-fixture-*' -or [IO.Path]::GetFullPath($root) -cne $root) { throw 'unsafe profile fixture cleanup' }
            Remove-Item -LiteralPath $root -Recurse -Force
        }
    }
    if ($script:Failures) { exit 1 }
    exit 0
}
& {
    foreach ($definition in $definitions) { . ([scriptblock]::Create($definition.Extent.Text)) }
    $script:OutputPrefix = '[opsgrid-agent]'
    $script:OpsGridFailureMarker = '__OPSGRID_FAILURE__'
    $script:OpsGridFailureCode = 0; $script:OpsGridFailureMessage = ''
    $script:ApiBaseUrlDefault = 'https://api.opsgrid.hacmieu.com'
    $script:OpsGridTempPaths = New-Object 'System.Collections.Generic.List[string]'
    $script:EnrollmentToken = $null
    $root = Join-Path ([IO.Path]::GetTempPath()) ('opsgrid-fixture-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $root | Out-Null
    try {
        $parser = Get-Command Get-OpsGridArguments -ErrorAction SilentlyContinue
        Assert-Fixture ($null -ne $parser) 'pure_argument_parser_exists'
        if ($null -ne $parser) {
            $parsed = Get-OpsGridArguments @('-EnrollmentToken=fixture;$(literal)&', '-ApiBaseUrl=https://api.example.test')
            Assert-Fixture ($parsed.EnrollmentToken -ceq 'fixture;$(literal)&' -and $parsed.ApiBaseUrl -ceq 'https://api.example.test' -and $parsed.ExplicitEnrollmentToken -and $parsed.ExplicitApiBaseUrl) 'literal_equal_arguments'
            $parsed = Get-OpsGridArguments @()
            Assert-Fixture ($parsed.ApiBaseUrl -ceq $script:ApiBaseUrlDefault -and -not $parsed.ExplicitApiBaseUrl -and -not $parsed.Help) 'parser_defaults'
            $parsed = Get-OpsGridArguments @('fixture', 'http://127.0.0.1:3000')
            Assert-Fixture ($parsed.EnrollmentToken -ceq 'fixture' -and $parsed.ExplicitEnrollmentToken -and $parsed.ExplicitApiBaseUrl) 'positional_compatibility'
            $parsed = Get-OpsGridArguments @('-ApplyProfile', 'windows-baseline-v1')
            Assert-Fixture ($parsed.ApplyProfile -ceq 'windows-baseline-v1' -and -not $parsed.ExplicitEnrollmentToken) 'reserved_profile_parse'
            $invalid = @(
                @('-ApplyProfile','windows-baseline-v1','-EnrollmentToken','fixture'),
                @('-ApplyProfile','windows-baseline-v1','-ApiBaseUrl','https://api.example.test'),
                @('-ApplyProfile','windows-baseline-v1','fixture'),
                @('-EnrollmentToken','fixture','-EnrollmentToken=other'), @('-ApiBaseUrl'),
                @('-EnrollmentToken',''), @('-Help','-Help'), @('-Unknown'), @('-ApplyProfile'),
                @('-EnrollmentToken',"fixture`ncontrol"), @('-ApiBaseUrl','http://remote.example.test')
            )
            $index = 0
            foreach ($case in $invalid) { $index++; Assert-Fixture (Test-Rejected { Get-OpsGridArguments $case }) ('invalid_arguments_' + $index) }
        }
        foreach ($url in @('https://u@host.test','https://@host.test','https://host.test/','https://host.test/path','https://host.test?','https://host.test#','https://host.test:',"https://host.test`n",'http://remote.test','ftp://host.test','https://host.test\evil','https://host.test/%2e%2e')) {
            Assert-Fixture (Test-Rejected { Test-ApiBaseUrl $url }) 'unsafe_origin_rejected'
        }
        foreach ($url in @('https://host.test','http://localhost:3000','http://127.0.0.1:3000','http://[::1]:3000')) { Assert-Fixture ((Test-ApiBaseUrl $url) -is [uri]) 'safe_origin_accepted' }

        & {
            function Set-OpsGridSafePath { }
            $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
            $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
            if (-not $isAdmin) {
                Assert-Fixture (Test-Rejected { Test-OpsGridPreflight }) 'nonadmin_preflight_refusal'
                Write-Output '[opsgrid-agent] NOT RUN real ACL and protected lock fixture: Administrator prerequisite absent'
            }
            else {
                $script:InstallRoot = Join-Path $root 'protected-root'
                $script:InstallLockFile = Join-Path $script:InstallRoot 'install.lock'
                $script:OpsGridLockStream = $null
                try {
                    $null = Acquire-OpsGridLock
                    $acl = Get-Acl -LiteralPath $script:InstallRoot
                    $sids = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value })
                    Assert-Fixture ($acl.AreAccessRulesProtected -and @($sids | Where-Object { $_ -notin @('S-1-5-18','S-1-5-32-544') }).Count -eq 0) 'real_acl_restricted'
                    Assert-Fixture (Test-Rejected { $s = [IO.File]::Open($script:InstallLockFile,'Open','ReadWrite','None'); $s.Dispose() }) 'real_lock_exclusive'
                }
                finally { Release-OpsGridLock }
            }
            function Get-CimInstance { param($ClassName,$ErrorAction) if ($ClassName -eq 'Win32_Processor') { [pscustomobject]@{ Architecture=12 } } else { [pscustomobject]@{ Caption='Microsoft Windows'; Version='fixture' } } }
            Assert-Fixture (Test-Rejected { Get-WindowsPlatform }) 'non_amd64_refusal'
            function Get-CimInstance { param($ClassName,$ErrorAction) if ($ClassName -eq 'Win32_Processor') { [pscustomobject]@{ Architecture=9 } } else { [pscustomobject]@{ Caption='Microsoft Windows'; Version='fixture' } } }
            Assert-Fixture ((Get-WindowsPlatform).Architecture -eq 9) 'amd64_supported'
            function Get-AlloyKnownBinaryPaths { @() }
            function Test-AlloyOfficialPath { $true }
            function Test-OpsGridSafeRegularFile { $true }
            function Get-CimInstance { @('alloy','grafana-alloy') | ForEach-Object { [pscustomobject]@{Name=$_; DisplayName='Alloy'; PathName='"C:\fixture\alloy.exe"'; StartName='LocalSystem'; State='Stopped'} } }
            function Get-Service { @('alloy','grafana-alloy') | ForEach-Object { [pscustomobject]@{Name=$_} } }
            Assert-Fixture (Test-Rejected { Get-AlloyService }) 'ambiguous_official_services_refusal'
            function Test-OpsGridSafeDirectory { $true }
            function Set-OpsGridDirectoryAcl { }
            function Set-OpsGridFileAcl { }
            function New-OpsGridTempDirectory { $root }
            function Invoke-WebRequest { param($Uri,$OutFile,$UseBasicParsing,$ErrorAction) [IO.File]::WriteAllText($OutFile,'synthetic non-executable fixture') }
            function Get-AuthenticodeSignature { [pscustomobject]@{Status='NotSigned'; SignerCertificate=$null} }
            function Start-Process { $script:ExecutedInstaller++; throw 'must not execute' }
            $script:ExecutedInstaller = 0
            $script:AlloyInstallDirectory = Join-Path $root 'install-fixture'
            $script:AlloyConfigDirectory = Join-Path $root 'config-fixture'
            $script:InstallRoot = $root; $script:AlloyInstallerUrl = 'https://fixture.invalid'; $script:AlloyFreshConfigPath = Join-Path $root 'config.alloy'
            Assert-Fixture (Test-Rejected { Install-AlloyOfficial }) 'unsigned_installer_refusal'
            Assert-Fixture ($script:ExecutedInstaller -eq 0) 'unsigned_installer_never_executed'
        }
        # Real temp-file atomic replacement: no service/security mocks and no secrets.
        $atomicSource = Join-Path $root 'atomic-source'; $atomicDestination = Join-Path $root 'atomic-destination'
        [IO.File]::WriteAllText($atomicSource,'new fixture'); [IO.File]::WriteAllText($atomicDestination,'old fixture')
        $atomicWorked = $true
        try { Invoke-OpsGridAtomicReplace $atomicSource $atomicDestination } catch { $atomicWorked = $false }
        Assert-Fixture ($atomicWorked -and [IO.File]::ReadAllText($atomicDestination) -ceq 'new fixture') 'real_atomic_replace'
        $target = Join-Path $root 'junction-target'; $junction = Join-Path $root 'junction'
        New-Item -ItemType Directory -Path $target | Out-Null
        New-Item -ItemType Junction -Path $junction -Target $target | Out-Null
        try { Assert-Fixture (-not (Test-OpsGridSafeDirectory $junction)) 'real_reparse_directory_refusal' }
        finally { [IO.Directory]::Delete($junction) }

        # All external effects replaced in this child scope. Actual orchestration/POST/rollback routing retained.
        function Test-OpsGridPreflight { $script:Effects++ }
        function Get-WindowsPlatform { [pscustomobject]@{ Os='Microsoft Windows fixture' } }
        function Acquire-OpsGridLock { $script:Effects++; $true }
        function Release-OpsGridLock { }
        function Get-AlloyService { [pscustomobject]@{ ExecutablePath='fixture-alloy.exe' } }
        function Test-AlloyOfficialPath([string]$ExecutablePath) { return $ExecutablePath -ceq 'fixture-alloy.exe' }
        function Get-AlloyConfigPath { Join-Path $root 'config.alloy' }
        function Test-AlloyConfigPath { $true }
        function Get-AlloyServiceIdentity { $null }
        function New-OpsGridTransactionSnapshot { [pscustomobject]@{ InstallRootExistedBeforeRun=$false } }
        function Restore-OpsGridTransaction { $script:Restores++ }
        function Remove-OpsGridFreshInstallRoot { $true }
        function Remove-OpsGridTempPaths { $true }
        function Set-OpsGridCredential { $script:Commits++ }
        function Register-OpsGridTempPath { }
        $realRenderConfig = ${function:Render-AlloyConfig}
        function Render-AlloyConfig {
            param($TemplatePath,$CredentialPath,$OutputPath)
            if ($script:Scenario -like 'local-*') { & $realRenderConfig -TemplatePath $TemplatePath -CredentialPath $CredentialPath -OutputPath $OutputPath }
        }
        $script:OpsGridInstallerRoot = $root
        New-Item -ItemType Directory -Path (Join-Path $root 'alloy') | Out-Null
        function Test-OpsGridSafeRegularFile { $true }
        function Invoke-AlloyValidate { if($script:Scenario -eq 'local-schema') { Fail-OpsGrid 40 'fixture schema failure' } }
        function Invoke-OpsGridAtomicReplace { $script:ConfigCommits++ }
        function Start-OpsGridAlloyAndWait { $false }
        function Start-Sleep { }
        function Get-OpsGridHttpStatusCode { if ($script:Scenario -eq '429') { return 429 }; if ($script:Scenario -eq '503') { return 503 }; return $null }
        function Invoke-RestMethod {
            param($Method, $Uri, $ContentType, $Body, $TimeoutSec, $MaximumRedirection, $ErrorAction)
            $script:Posts++
            if ($Method -ne 'Post' -or $MaximumRedirection -ne 0) { throw 'unsafe dispatch' }
            if ($script:Scenario -eq 'success') { return [pscustomobject]@{status='ACTIVE'; agentId='a'; organizationId='o'; vmId='v'; credential=('AGT_'+'fixture')} }
            if ($script:Scenario -eq 'invalid-response') { return [pscustomobject]@{status='ACTIVE'} }
            if ($script:Scenario -eq 'timeout') { throw [TimeoutException]::new('fixture secret must not escape') }
            throw [Net.WebException]::new('fixture secret must not escape')
        }
        $script:InstallRoot = Join-Path $root 'absent-root'
        $script:AlloyConfigDirectory = Join-Path $root 'absent-config'
        $script:AlloyInstallDirectory = Join-Path $root 'absent-alloy'
        $script:AgentCredentialFile = Join-Path $root 'agent.credential'
        $script:AlloyCredentialConfigPath = $script:AgentCredentialFile.Replace('\','/')
        $Help = $false; $ApiBaseUrl = $script:ApiBaseUrlDefault; $EnrollmentToken = 'fixture-input'
        $ApplyProfile = 'unreviewed-profile'; $script:Effects = 0
        $output = @(Invoke-OpsGrid)
        Assert-Fixture ($script:OpsGridExitCode -eq 10 -and $script:Effects -eq 0) 'unreviewed_profile_fails_before_effects'
        $ApplyProfile = $null
        & {
            foreach($definition in $definitions | Where-Object { $_.Name -in @('Register-OpsGridTempPath','New-OpsGridTempDirectory','Remove-OpsGridTempPaths','Get-AlloyServiceIdentity') }) { . ([scriptblock]::Create($definition.Extent.Text)) }
            Assert-Fixture (Test-Rejected { Get-AlloyServiceIdentity ([pscustomobject]@{StartName='';CimService=$null}) }) 'unknown_service_identity_refused'
            # Real caller-owned Windows DACL/traversal checks, not the admin-only
            # SYSTEM-owner/Audit ACL restoration gate (which remains NOT RUN).
            function Set-OpsGridAclFromSddl { param($Path,$Sddl,[switch]$Directory) if($script:EarlyFailure -eq 'restore-failed') { throw 'fixture ACL recovery failure' }; Set-OpsGridProfileAcl $Path $Sddl -Directory:$Directory }
            function Set-OpsGridDirectoryAcl { param($Path) $acl=Get-Acl $Path; $acl.SetAccessRuleProtection($true,$false); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')); Set-Acl $Path $acl }
            function Acquire-OpsGridLock { Set-OpsGridDirectoryAcl $script:InstallRoot; $true }
            function Get-AlloyService { if($script:EarlyFailure -in @('discovery','restore-failed')) { throw 'fixture service discovery failure' }; [pscustomobject]@{Name='alloy-fixture';ExecutablePath='fixture-alloy.exe'} }
            function Get-AlloyConfigPath { if($script:EarlyFailure -eq 'config-discovery') { throw 'fixture config discovery failure' }; Join-Path $script:AlloyConfigDirectory 'config.alloy' }
            function Install-AlloyOfficial { throw 'unexpected installation' }
            function Remove-OpsGridPartialInstall { throw 'unexpected partial service cleanup' }
            function New-OpsGridTransactionSnapshot { throw 'fixture snapshot I/O failure' }
            foreach($earlyFailure in @('discovery','config-discovery','snapshot','restore-failed')) {
                $script:EarlyFailure=$earlyFailure; $script:Posts=0; $script:Restores=0
                $script:InstallRoot=Join-Path $root ('early-' + $earlyFailure)
                $script:AlloyConfigDirectory=Join-Path $script:InstallRoot 'Alloy'; $script:AlloyInstallDirectory=Join-Path $root 'absent-alloy'
                [IO.Directory]::CreateDirectory($script:AlloyConfigDirectory) | Out-Null
                $acl=Get-Acl $script:InstallRoot
                $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-19'),'ReadAndExecute','Allow'))
                Set-Acl $script:InstallRoot $acl; $originalAcl=(Get-Acl $script:InstallRoot).Sddl
                $EnrollmentToken='fixture-input'; $script:OpsGridTempPaths=New-Object 'System.Collections.Generic.List[string]'
                $out=@(Invoke-OpsGrid)
                if($earlyFailure -ne 'restore-failed') {
                    Assert-Fixture ((Get-Acl $script:InstallRoot).Sddl -ceq $originalAcl -and $script:Posts -eq 0 -and $script:Restores -eq 0 -and $script:OpsGridExitCode -in @(20,40)) ('early_failure_restores_service_traversal_acl_' + $earlyFailure)
                }
                else {
                    $receiptFiles=@(Get-ChildItem $script:InstallRoot -Recurse -Filter 'recovery.json'); $receipt=if($receiptFiles.Count -eq 1) {[IO.File]::ReadAllText($receiptFiles[0].FullName) | ConvertFrom-Json} else {$null}
                    Assert-Fixture ($null -ne $receipt -and $receipt.RecoveryKind -ceq 'InstallRootAcl' -and $receipt.InstallRootAclSddl -ceq $originalAcl -and $script:OpsGridExitCode -eq 20 -and $script:Posts -eq 0 -and ($out -join '') -notmatch 'AGT_|fixture-input') 'early_acl_restore_failure_private_receipt_primary_exit'
                }
            }
        }
        & {
            $script:InstallRoot=Join-Path $root 'committed-cleanup'; $script:AlloyConfigDirectory=Join-Path $script:InstallRoot 'Alloy'
            [IO.Directory]::CreateDirectory($script:AlloyConfigDirectory) | Out-Null
            $script:AlloyInstallDirectory=Join-Path $root 'absent-alloy'; $script:Scenario='success'
            function Test-OpsGridPreflight { $env:PATH += ';fixture-path-mutation' }
            function Get-AlloyConfigPath { Join-Path $script:AlloyConfigDirectory 'config.alloy' }
            function Acquire-OpsGridLock { $true }
            function Release-OpsGridLock { throw 'synthetic secret cleanup failure' }
            function New-OpsGridTransactionSnapshot { [pscustomobject]@{InstallRootExistedBeforeRun=$true} }
            function Set-OpsGridAclFromSddl { $script:EarlyAclRestoreCalls++; throw 'unexpected early ACL restore after snapshot' }
            function Set-OpsGridCredential {
                $script:Commits++
                $acl=Get-Acl $script:InstallRoot
                $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-19'),'ReadAndExecute','Allow'))
                Set-OpsGridProfileAcl $script:InstallRoot $acl.GetSecurityDescriptorSddlForm('Access,Owner,Group') -Directory
                $script:CommittedRootAcl=(Get-Acl $script:InstallRoot).Sddl
            }
            function Start-OpsGridAlloyAndWait { $script:CommitHealthOk }
            foreach($healthOk in @($true,$false)) {
                $script:CommitHealthOk=$healthOk; $script:Commits=0; $script:ConfigCommits=0; $script:Restores=0; $script:Posts=0; $script:EarlyAclRestoreCalls=0
                $EnrollmentToken='fixture-input'; $beforePath=$env:PATH; $out=@(Invoke-OpsGrid)
                Assert-Fixture ($script:OpsGridExitCode -eq 50 -and $script:Posts -eq 1 -and $script:Commits -eq 1 -and $script:ConfigCommits -eq 1 -and $script:Restores -eq $(if($healthOk){0}else{1}) -and $script:EarlyAclRestoreCalls -eq 0 -and (Get-Acl $script:InstallRoot).Sddl -ceq $script:CommittedRootAcl) ('postsnapshot_cleanup_failure_never_early_acl_restore_' + $healthOk)
                Assert-Fixture ($env:PATH -ceq $beforePath -and $null -eq $script:EnrollmentToken -and ($out -join '') -notmatch 'AGT_|fixture-input|synthetic secret') ('postsnapshot_cleanup_failure_clears_secret_path_' + $healthOk)
            }
        }
        $script:InstallRoot = Join-Path $root 'absent-root'; $script:AlloyConfigDirectory = Join-Path $root 'absent-config'; $script:AlloyInstallDirectory = Join-Path $root 'absent-alloy'
        foreach ($localFailure in @('missing-template','invalid-placeholder','schema')) {
            $script:Scenario = 'local-' + $localFailure; $script:Posts = 0; $script:Restores = 0; $script:Commits = 0; $script:ConfigCommits = 0
            $template = Join-Path $root 'alloy\windows.config.alloy.template'
            if ($localFailure -ne 'missing-template') {
                $content = if($localFailure -eq 'invalid-placeholder') {'fixture.invalid.no.placeholder {}'} else {'local.file "credential" { filename = "__CREDENTIAL_FILE__" }'}
                [IO.File]::WriteAllText($template,$content)
            }
            $null = Invoke-OpsGrid
            Assert-Fixture ($script:OpsGridExitCode -eq 40 -and $script:Posts -eq 0 -and $script:Commits -eq 0 -and $script:ConfigCommits -eq 0 -and $script:Restores -eq 1) ('local_preflight_zero_enrollment_' + $localFailure)
        }
        foreach ($scenario in @('timeout','429','503','lost-response','invalid-response','success')) {
            $script:Scenario = $scenario; $script:Posts = 0; $script:Commits = 0; $script:ConfigCommits = 0; $script:Restores = 0; $script:Effects = 0
            $EnrollmentToken = 'fixture-input'
            $output = @(Invoke-OpsGrid)
            Assert-Fixture ($script:Posts -eq 1) ('enrollment_dispatched_failure_is_single_attempt_' + $scenario)
            Assert-Fixture ($script:OpsGridExitCode -ne 0 -and $script:Restores -eq 1) ('rollback_nonzero_' + $scenario)
            if ($scenario -ne 'success') { Assert-Fixture ($script:Commits -eq 0 -and $script:ConfigCommits -eq 0 -and -not (Test-Path $script:AgentCredentialFile)) ('no_fresh_commit_' + $scenario) }
            $text = $output -join "`n"
            Assert-Fixture ($text -match 'split state' -and $text -match 'recovery required' -and $text -notmatch 'AGT_|ENR_|fixture-input|fixture secret' -and @($output | Where-Object { $_ -notlike '[[]opsgrid-agent[]]*' }).Count -eq 0) ('redacted_recovery_' + $scenario)
            if ($scenario -ne 'success') { Assert-Fixture ($text -match 'outcome unknown' -and $script:OpsGridExitCode -eq 30) ('unknown_outcome_' + $scenario) }
            else { Assert-Fixture ($script:OpsGridExitCode -eq 50 -and $script:Commits -eq 1 -and $script:ConfigCommits -eq 1) ('local_activation_failure_no_reenrollment_exit' + $script:OpsGridExitCode + '_stage' + $script:OpsGridStage + '_commits' + $script:Commits + '_config' + $script:ConfigCommits) }
        }
        # Regression: failed rollback retains original evidence but purges fresh secrets.
        & {
            . ([scriptblock]::Create(($definitions | Where-Object Name -eq 'Remove-OpsGridTempPaths').Extent.Text))
            function New-OpsGridTransactionSnapshot {
                $directory = Join-Path $script:InstallRoot ('.tmp-' + [guid]::NewGuid().ToString('N'))
                [IO.Directory]::CreateDirectory($directory) | Out-Null
                $originalCredential = Join-Path $directory 'credential.snapshot'
                $originalConfig = Join-Path $directory 'config.snapshot'
                [IO.File]::WriteAllText($originalCredential,'original-fixture-identity')
                [IO.File]::WriteAllText($originalConfig,'original-fixture-config')
                [IO.File]::WriteAllText((Join-Path $directory 'recovery.json'),'{"OriginalStatus":"Running"}')
                $script:OpsGridTempPaths.Add($directory); $script:OpsGridTempPaths.Add($originalCredential); $script:OpsGridTempPaths.Add($originalConfig)
                $script:SnapshotDisposable = Join-Path $directory 'fresh-response.tmp'
                [IO.File]::WriteAllText($script:SnapshotDisposable,'AGT_new_fixture_response')
                $script:OpsGridTempPaths.Add($script:SnapshotDisposable)
                $disposable = Join-Path $script:InstallRoot '.agent.credential.fixture.tmp'
                [IO.File]::WriteAllText($disposable,'AGT_new_fixture')
                $script:OpsGridTempPaths.Add($disposable)
                $validation = Join-Path $script:InstallRoot ('.tmp-' + [guid]::NewGuid().ToString('N'))
                [IO.Directory]::CreateDirectory($validation) | Out-Null
                [IO.File]::WriteAllText((Join-Path $validation 'validate.stderr'),'synthetic secret transcript')
                $script:OpsGridTempPaths.Add($validation)
                $script:RecoveryDirectory=$directory; $script:DisposableCredential=$disposable; $script:DisposableValidation=$validation
                [pscustomobject]@{InstallRootExistedBeforeRun=$false;SnapshotDirectory=$directory;CredentialSnapshot=$originalCredential;ConfigSnapshot=$originalConfig}
            }
            function Restore-OpsGridTransaction { if($script:BreakRecovery) { throw 'AGT_new_fixture synthetic secret rollback' }; $true }
            function Remove-OpsGridFreshInstallRoot { $script:RootCleanupCalls++; $true }
            foreach($breakRecovery in @($true,$false)) {
                $script:BreakRecovery=$breakRecovery; $script:RootCleanupCalls=0; $script:Scenario='success'
                $script:InstallRoot=Join-Path $root ('recovery-' + $breakRecovery)
                [IO.Directory]::CreateDirectory($script:InstallRoot) | Out-Null
                $EnrollmentToken='fixture-input'; $out=@(Invoke-OpsGrid)
                $retained=[IO.File]::Exists((Join-Path $script:RecoveryDirectory 'credential.snapshot')) -and [IO.File]::Exists((Join-Path $script:RecoveryDirectory 'config.snapshot')) -and [IO.File]::Exists((Join-Path $script:RecoveryDirectory 'recovery.json'))
                Assert-Fixture (($breakRecovery -and $retained -and $script:RootCleanupCalls -eq 0) -or (-not $breakRecovery -and -not [IO.Directory]::Exists($script:RecoveryDirectory) -and $script:RootCleanupCalls -eq 1)) ('original_recovery_retention_' + $breakRecovery)
                Assert-Fixture (-not [IO.File]::Exists($script:DisposableCredential) -and -not [IO.File]::Exists($script:SnapshotDisposable) -and -not [IO.Directory]::Exists($script:DisposableValidation)) ('disposable_secret_cleanup_' + $breakRecovery)
                Assert-Fixture ($script:OpsGridExitCode -eq 50 -and ($out -join '') -notmatch 'AGT_|fixture-input|synthetic secret') ('rollback_failure_stable_redacted_' + $breakRecovery)
            }
        }
    }
    finally {
        # Root generated here, verify identity before removing fixture tree.
        if ([IO.Path]::GetFileName($root) -notlike 'opsgrid-fixture-*') { throw 'unsafe fixture cleanup' }
        Remove-Item -LiteralPath $root -Force -Recurse
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
