# Keep raw arguments so malformed/unknown parameters are reported through the
# stable OpsGrid contract rather than PowerShell's unprefixed binder errors.
param()

# Dot-sourcing must not execute initialization or clobber caller variables.
if ($MyInvocation.InvocationName -eq '.') {
    return
}

$script:OpsGridInstallerRoot = $PSScriptRoot
# OPSGRID_BUNDLE_BEGIN
. (Join-Path $script:OpsGridInstallerRoot 'lib/windows/Runtime.ps1')
. (Join-Path $script:OpsGridInstallerRoot 'lib/windows/Preflight.ps1')
. (Join-Path $script:OpsGridInstallerRoot 'lib/windows/Security.ps1')
. (Join-Path $script:OpsGridInstallerRoot 'lib/windows/Alloy.ps1')
. (Join-Path $script:OpsGridInstallerRoot 'lib/windows/Enrollment.ps1')
. (Join-Path $script:OpsGridInstallerRoot 'lib/windows/Configuration.ps1')
. (Join-Path $script:OpsGridInstallerRoot 'lib/windows/Transaction.ps1')
. (Join-Path $script:OpsGridInstallerRoot 'lib/windows/Profiles.ps1')
# OPSGRID_BUNDLE_END

function Invoke-OpsGrid {
    if (-not [string]::IsNullOrEmpty($ApplyProfile)) { Invoke-OpsGridApplyProfile $ApplyProfile; return }
    $tokenForRun = $null
    $credential = $null
    $enrollment = $null
    $originalPath = [string]$env:PATH
    $service = $null
    $configPath = $null
    $serviceIdentity = $null
    $validationExecutable = $null
    $existingService = $false
    $transaction = $null
    $transactionSnapshotCreated = $false
    $rollbackTransaction = $null
    $rollbackFailed = $false
    $retainedSnapshotDirectory = $null
    $partialInstallRootCleanupPending = $false
    $partialInstallAttempted = $false
    $lockAcquired = $false
    $stagedCredential = $null
    $stagedConfig = $null
    $installRootExistedBeforeRun = $false
    $installRootAclSddlBeforeRun = $null
    $configDirectoryExistedBeforeRun = $false
    $configDirectoryAclSddlBeforeRun = $null
    $alloyInstallDirectoryExistedBeforeRun = $false
    $alloyInstallDirectoryAclSddlBeforeRun = $null
    $script:OpsGridFailureCode = 0
    $script:OpsGridFailureMessage = ''
    $script:OpsGridExitCode = 0
    $script:OpsGridInstalledByRun = $false
    $script:OpsGridTempPaths.Clear()
    $script:OpsGridEnrollmentDispatched = $false
    $script:OpsGridEnrollmentSucceeded = $false

    try {
        # Reserved profile mode has no reviewed target/transaction in Task3.
        # Refuse before preflight, path/ACL/lock/download/token or service effects.
        if (-not [string]::IsNullOrEmpty($ApplyProfile)) { Fail-OpsGrid 10 'profile target is not reviewed; no changes made' }
        if ($Help) { Show-Usage; return }
        $script:OpsGridStage = 'url'
        $null = Test-ApiBaseUrl -Value $ApiBaseUrl
        Test-OpsGridPreflight
        $script:OpsGridStage = 'platform'
        $platform = Get-WindowsPlatform
        $script:OpsGridStage = 'lock'
        # Capture pre-run directory security/existence before lock acquisition repairs
        # the OpsGrid root ACL or a fresh official install creates any Alloy paths.
        $installRootExistedBeforeRun = [System.IO.Directory]::Exists($script:InstallRoot)
        if ($installRootExistedBeforeRun) { $installRootAclSddlBeforeRun = [string](Get-Acl -LiteralPath $script:InstallRoot -ErrorAction Stop).Sddl }
        $configDirectoryExistedBeforeRun = [System.IO.Directory]::Exists($script:AlloyConfigDirectory)
        if ($configDirectoryExistedBeforeRun) { $configDirectoryAclSddlBeforeRun = [string](Get-Acl -LiteralPath $script:AlloyConfigDirectory -ErrorAction Stop).Sddl }
        $alloyInstallDirectoryExistedBeforeRun = [System.IO.Directory]::Exists($script:AlloyInstallDirectory)
        if ($alloyInstallDirectoryExistedBeforeRun) { $alloyInstallDirectoryAclSddlBeforeRun = [string](Get-Acl -LiteralPath $script:AlloyInstallDirectory -ErrorAction Stop).Sddl }
        $null = Acquire-OpsGridLock
        $lockAcquired = $true

        $script:OpsGridStage = 'service'
        $service = Get-AlloyService
        $existingService = ($null -ne $service)
        if (-not $existingService) {
            if (-not (Test-OpsGridNoPreexistingAlloyRegistryState)) { Fail-OpsGrid 20 'pre-existing Alloy registry state is unsupported for fresh install' }
            if (-not (Test-OpsGridNoPreexistingAlloyUserArtifacts)) { Fail-OpsGrid 20 'pre-existing Alloy user artifacts are unsupported for fresh install' }
            foreach ($targetDirectory in @($script:AlloyInstallDirectory, $script:AlloyConfigDirectory)) {
                if (-not (Test-OpsGridSafeDirectory -Path $targetDirectory)) { Fail-OpsGrid 20 'Alloy target directory path is unsafe or occupied by a file' }
                if ([string]::Equals($targetDirectory, $script:AlloyInstallDirectory, [System.StringComparison]::OrdinalIgnoreCase) -and [System.IO.Directory]::Exists($targetDirectory)) { Fail-OpsGrid 20 'pre-existing Alloy install directory is unsupported for fresh install' }
                if ([System.IO.Directory]::Exists($targetDirectory)) {
                    $targetItem = Get-Item -LiteralPath $targetDirectory -Force -ErrorAction Stop
                    if (($targetItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { Fail-OpsGrid 20 'partial Alloy target directory is a reparse point' }
                    if (@(Get-ChildItem -LiteralPath $targetDirectory -Force -ErrorAction Stop).Count -gt 0) { Fail-OpsGrid 20 'partial Alloy target state exists without an official service' }
                }
            }
            $partialInstallAttempted = $true
            $script:AlloyUserArtifactRunStartedUtc = [DateTime]::UtcNow
            Install-AlloyOfficial
            if (-not $existingService -and -not (Capture-OpsGridFreshAlloyUserArtifacts)) { Fail-OpsGrid 20 'official installer created unsafe or untracked Alloy user artifacts' }
            $service = Get-AlloyService
            if ($null -eq $service) { Fail-OpsGrid 20 'Alloy service was not registered by the official installer' }
            $registeredConfigPath = Get-AlloyConfigPath -Service $service
            if ([string]::IsNullOrWhiteSpace($registeredConfigPath) -or -not [string]::Equals($registeredConfigPath, $script:AlloyFreshConfigPath, [System.StringComparison]::OrdinalIgnoreCase)) {
                Fail-OpsGrid 20 'official Alloy installer registered an unexpected config path'
            }
            $configPath = $script:AlloyFreshConfigPath
        }
        else {
            $configPath = Get-AlloyConfigPath -Service $service
            if ([string]::IsNullOrWhiteSpace($configPath)) { Fail-OpsGrid 20 'official Alloy service config path is unsafe or unavailable' }
        }
        if (-not (Test-AlloyConfigPath $configPath)) { Fail-OpsGrid 20 'Alloy config path is unsafe or unavailable' }
        if ($existingService) {
            $discoveredConfigDirectory = [System.IO.Path]::GetDirectoryName($configPath)
            $configDirectoryExistedBeforeRun = [System.IO.Directory]::Exists($discoveredConfigDirectory)
            $configDirectoryAclSddlBeforeRun = $null
            if ($configDirectoryExistedBeforeRun) { $configDirectoryAclSddlBeforeRun = [string](Get-Acl -LiteralPath $discoveredConfigDirectory -ErrorAction Stop).Sddl }
        }
        $script:OpsGridStage = 'transaction'
        # Snapshot before identity discovery and enrollment so every post-install
        # failure, including enrollment failure, can restore the pre-run state.
        $transaction = New-OpsGridTransactionSnapshot -Service $service -ConfigPath $configPath -HadPreexistingService $existingService `
            -InstallRootExistedBeforeRun $installRootExistedBeforeRun `
            -InstallRootAclSddlBeforeRun $installRootAclSddlBeforeRun `
            -ConfigDirectoryExistedBeforeRun $configDirectoryExistedBeforeRun `
            -ConfigDirectoryAclSddlBeforeRun $configDirectoryAclSddlBeforeRun `
            -AlloyInstallDirectoryExistedBeforeRun $alloyInstallDirectoryExistedBeforeRun `
            -AlloyInstallDirectoryAclSddlBeforeRun $alloyInstallDirectoryAclSddlBeforeRun
        $transactionSnapshotCreated = $true
        $serviceIdentity = Get-AlloyServiceIdentity -Service $service

        # Resolve/check the signed installed CLI before reading or dispatching a
        # one-time token. A missing wrapper sibling must not create split state.
        $script:OpsGridStage = 'validator-discovery'
        $validationExecutable = Get-OpsGridAlloyValidationExecutable $service
        # The template contains only the approved credential filename. Render and
        # validate all local inputs before consuming a one-time enrollment token;
        # no credential bytes or committed config exist at this boundary.
        $script:OpsGridStage = 'transaction'
        $stagedConfig = Join-Path ([System.IO.Path]::GetDirectoryName($configPath)) ('.opsgrid-config.' + [guid]::NewGuid().ToString('N') + '.tmp')
        Register-OpsGridTempPath $stagedConfig
        $templatePath = Join-Path $script:OpsGridInstallerRoot 'alloy\windows.config.alloy.template'
        $null = Render-AlloyConfig -TemplatePath $templatePath -CredentialPath $script:AlloyCredentialConfigPath -OutputPath $stagedConfig
        $script:OpsGridStage = 'validate'
        if (-not (Test-AlloyOfficialPath $validationExecutable)) { Fail-OpsGrid 20 'Alloy validation executable changed or is unavailable' }
        $null = Invoke-AlloyValidate -AlloyPath $validationExecutable -ConfigPath $stagedConfig
        $script:OpsGridStage = 'token'
        if ([string]::IsNullOrWhiteSpace($EnrollmentToken)) { $tokenForRun = Read-EnrollmentToken }
        else { $tokenForRun = [string]$EnrollmentToken }
        if ([string]::IsNullOrWhiteSpace($tokenForRun)) { Fail-OpsGrid 10 'enrollment token is required' }
        $script:EnrollmentToken = $tokenForRun
        $script:OpsGridStage = 'enrollment'
        $enrollment = Invoke-Enrollment -Token $tokenForRun -Os ([string]$platform.Os) -BaseUrl $ApiBaseUrl
        $credential = [string](Get-OpsGridPropertyValue $enrollment 'credential')

        $script:OpsGridStage = 'transaction'
        $null = Set-OpsGridCredential -Credential $credential -Path $script:AgentCredentialFile -ServiceIdentity $serviceIdentity
        $stagedCredential = $script:AgentCredentialFile
        Invoke-OpsGridAtomicReplace -Source $stagedConfig -Destination $configPath
        $script:OpsGridStage = 'service-health'
        if (-not (Start-OpsGridAlloyAndWait -Service $service)) { Fail-OpsGrid 50 'Alloy service failed health check' }
        if (-not $existingService -and -not (Capture-OpsGridFreshAlloyUserArtifacts)) { Fail-OpsGrid 50 'Alloy user artifact identity changed during service activation' }
        $transaction = $null
        Write-OpsGridLog 'Alloy enrollment and service health confirmed.'
    }
    catch {
        # Capture the original stable classification before rollback can fail or
        # throw. A rollback error is reported without exposing implementation
        # details, while the original 30/40/50 contract is retained.
        $failureCode = [int]$script:OpsGridFailureCode
        $failureMessage = [string]$script:OpsGridFailureMessage
        $rollbackFailed = $false
        if ($null -ne $transaction) {
            $rollbackTransaction = $transaction
            try { $null = Restore-OpsGridTransaction -Snapshot $transaction }
            catch {
                $rollbackFailed = $true
                $retainedSnapshotDirectory = [string]$transaction.SnapshotDirectory
            }
        }
        elseif ($lockAcquired) {
            $partialInstallRootCleanupPending = -not $installRootExistedBeforeRun
            $partialRollbackOk = $true
            if ($partialInstallAttempted) {
                if (-not $existingService) { $null = Capture-OpsGridFreshAlloyUserArtifacts }
                $partialRollbackOk = Remove-OpsGridPartialInstall -HadPreexistingService $existingService -InstallRootExistedBeforeRun $installRootExistedBeforeRun -InstallRootAclSddlBeforeRun $installRootAclSddlBeforeRun -ConfigDirectoryExistedBeforeRun $configDirectoryExistedBeforeRun -ConfigDirectoryAclSddlBeforeRun $configDirectoryAclSddlBeforeRun -AlloyInstallDirectoryExistedBeforeRun $alloyInstallDirectoryExistedBeforeRun -AlloyInstallDirectoryAclSddlBeforeRun $alloyInstallDirectoryAclSddlBeforeRun
            }
            if (-not $partialRollbackOk) { $rollbackFailed = $true }
        }
        if (@(10, 20, 30, 40, 50) -notcontains $failureCode) {
            if ($script:OpsGridStage -in @('url', 'preflight', 'platform', 'token')) { $failureCode = 10; $failureMessage = 'Windows preflight failed' }
            elseif ($script:OpsGridStage -eq 'enrollment') { $failureCode = 30; $failureMessage = 'enrollment failed' }
            elseif ($script:OpsGridStage -in @('transaction', 'validate')) { $failureCode = 40; $failureMessage = 'config transaction failed' }
            elseif ($script:OpsGridStage -eq 'service-health') { $failureCode = 50; $failureMessage = 'Alloy service failed' }
            else { $failureCode = 20; $failureMessage = 'Alloy installation failed' }
        }
        if ($rollbackFailed) { $failureMessage = 'transaction rollback failed' }
        elseif ([string]::IsNullOrWhiteSpace($failureMessage)) { $failureMessage = 'operation failed' }
        Write-OpsGridLog $failureMessage
        if ($script:OpsGridEnrollmentSucceeded) {
            Write-OpsGridLog 'server enrollment succeeded but local activation failed; split state; operator recovery required; local rollback does not revoke the agent; do not request a new enrollment token without approval'
        }
        elseif ($script:OpsGridEnrollmentDispatched -and $failureMessage -notmatch 'outcome unknown') {
            Write-OpsGridLog 'enrollment outcome unknown; split state possible; operator recovery required; do not retry enrollment'
        }
        $script:OpsGridExitCode = $failureCode
    }
    finally {
        try {
        try { Release-OpsGridLock }
        catch {
            Write-OpsGridLog 'installer lock cleanup failed'
            if ([int]$script:OpsGridExitCode -eq 0) { $script:OpsGridExitCode = 50 }
        }
        # Lock acquisition hardens the preexisting root before a full snapshot
        # exists. Restore its saved ACL even when discovery/identity/snapshot I/O
        # failed early; this must never uninstall or mutate service/config state.
        if ($lockAcquired -and $installRootExistedBeforeRun -and -not $transactionSnapshotCreated -and [int]$script:OpsGridExitCode -ne 0 -and -not [string]::IsNullOrWhiteSpace($installRootAclSddlBeforeRun)) {
            try {
                Set-OpsGridAclFromSddl -Path $script:InstallRoot -Sddl $installRootAclSddlBeforeRun -Directory
                if ([string](Get-Acl -LiteralPath $script:InstallRoot -ErrorAction Stop).Sddl -cne $installRootAclSddlBeforeRun) { throw 'early root ACL rollback verification failed' }
            }
            catch {
                Write-OpsGridLog 'early installation root ACL rollback failed; operator recovery required'
                try {
                    $retainedSnapshotDirectory = New-OpsGridTempDirectory
                    $receipt = [ordered]@{SchemaVersion=1;RecoveryKind='InstallRootAcl';InstallRoot=$script:InstallRoot;InstallRootExistedBeforeRun=$true;InstallRootAclSddl=$installRootAclSddlBeforeRun;CredentialPath=$script:AgentCredentialFile}
                    $receiptPath = Register-OpsGridTempPath (Join-Path $retainedSnapshotDirectory 'recovery.json')
                    Write-OpsGridUtf8NoBom -Path $receiptPath -Content ($receipt | ConvertTo-Json -Depth 2)
                }
                catch { Write-OpsGridLog 'private root ACL recovery metadata could not be written; operator recovery required' }
            }
        }
        $tempCleanupOk = $false
        try { $tempCleanupOk = Remove-OpsGridTempPaths -RetainDirectory $retainedSnapshotDirectory }
        catch { $tempCleanupOk = $false }
        if (-not $tempCleanupOk) {
            Write-OpsGridLog 'temporary secret cleanup failed'
            if ([int]$script:OpsGridExitCode -eq 0) { $script:OpsGridExitCode = 50 }
        }
        if ($null -ne $rollbackTransaction -and -not $rollbackFailed -and -not (Remove-OpsGridFreshInstallRoot -Snapshot $rollbackTransaction)) {
            Write-OpsGridLog 'fresh OpsGrid installation root cleanup failed'
            if ([int]$script:OpsGridExitCode -eq 0) { $script:OpsGridExitCode = 50 }
        }
        if ($partialInstallRootCleanupPending -and -not (Remove-OpsGridFreshInstallRoot -Snapshot ([pscustomobject]@{ InstallRootExistedBeforeRun = $false }))) {
            Write-OpsGridLog 'fresh OpsGrid installation root cleanup failed'
            if ([int]$script:OpsGridExitCode -eq 0) { $script:OpsGridExitCode = 50 }
        }
        }
        finally {
            $env:PATH = $originalPath
            $tokenForRun = $null
            $credential = $null
            $enrollment = $null
            $script:EnrollmentToken = $null
            $EnrollmentToken = $null
            Clear-Variable -Name tokenForRun -ErrorAction SilentlyContinue
        }
    }
}

# Normal invocation runs only after the early dot-source guard and executes the
# complete preflight, enrollment, transaction, and service-health flow.
if ($MyInvocation.InvocationName -ne '.') {
    try { $parsedArguments = Get-OpsGridArguments -Arguments @($args) }
    catch { Write-OpsGridLog 'invalid installer arguments'; exit 10 }
    $Help = $parsedArguments.Help
    $EnrollmentToken = $parsedArguments.EnrollmentToken
    $ApiBaseUrl = $parsedArguments.ApiBaseUrl
    $ApplyProfile = $parsedArguments.ApplyProfile
    $parsedArguments = $null
    Invoke-OpsGrid
    exit $script:OpsGridExitCode
}
