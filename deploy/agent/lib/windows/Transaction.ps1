# Internal installer declarations; dot-sourced by the guarded entrypoint.
function Register-OpsGridTempPath([string]$Path) {
    if (-not [string]::IsNullOrWhiteSpace($Path) -and -not $script:OpsGridTempPaths.Contains($Path)) { $script:OpsGridTempPaths.Add($Path) }
    return $Path
}

function New-OpsGridTempDirectory {
    if (-not [System.IO.Directory]::Exists($script:InstallRoot)) { [System.IO.Directory]::CreateDirectory($script:InstallRoot) | Out-Null }
    $path = Join-Path $script:InstallRoot ('.tmp-' + [guid]::NewGuid().ToString('N'))
    [System.IO.Directory]::CreateDirectory($path) | Out-Null
    Set-OpsGridDirectoryAcl -Path $path
    Register-OpsGridTempPath $path
}

function Remove-OpsGridFreshInstallRoot($Snapshot) {
    if ($null -eq $Snapshot -or $Snapshot.InstallRootExistedBeforeRun) { return $true }
    try {
        if ([System.IO.File]::Exists($script:InstallLockFile)) { Remove-Item -LiteralPath $script:InstallLockFile -Force -ErrorAction Stop }
        if ([System.IO.Directory]::Exists($script:InstallRoot)) {
            $rootItem = Get-Item -LiteralPath $script:InstallRoot -Force -ErrorAction Stop
            if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'fresh OpsGrid root is a reparse point' }
            $children = @(Get-ChildItem -LiteralPath $script:InstallRoot -Force -ErrorAction Stop)
            if ($children.Count -ne 0) { throw 'fresh OpsGrid root contains unexpected artifacts' }
            Remove-Item -LiteralPath $script:InstallRoot -Force -ErrorAction Stop
        }
        return (-not [System.IO.Directory]::Exists($script:InstallRoot))
    }
    catch { return $false }
}

function Remove-OpsGridFreshService([string]$Name) {
    try {
        $service = Get-Service -Name $Name -ErrorAction Stop
        if ([string]$service.Status -ne 'Stopped') {
            Stop-Service -Name $Name -Force -ErrorAction Stop
            if (-not (Wait-OpsGridServiceState -Name $Name -ExpectedStatus 'Stopped')) { throw 'fresh service did not stop' }
        }
        & sc.exe delete $Name 1>$null 2>$null
        if ($LASTEXITCODE -ne 0 -and -not (Wait-OpsGridServiceAbsent -Name $Name)) { throw 'fresh service delete failed' }
        if (-not (Wait-OpsGridServiceAbsent -Name $Name)) { throw 'fresh service still exists' }
        return $true
    }
    catch {
        return $false
    }
}

function Remove-OpsGridPartialInstall(
    [bool]$HadPreexistingService,
    [bool]$InstallRootExistedBeforeRun,
    [string]$InstallRootAclSddlBeforeRun,
    [bool]$ConfigDirectoryExistedBeforeRun,
    [string]$ConfigDirectoryAclSddlBeforeRun,
    [bool]$AlloyInstallDirectoryExistedBeforeRun,
    [string]$AlloyInstallDirectoryAclSddlBeforeRun
) {
    $failed = $false
    $freshServiceRemoved = $HadPreexistingService
    if (-not $HadPreexistingService) {
        $partialServices = @()
        $serviceEnumerationSucceeded = $true
        try {
            $partialServices = @(Get-CimInstance -ClassName Win32_Service -ErrorAction Stop | Where-Object {
                ([string]$_.Name -match '(?i)^(?:alloy|grafana-alloy)$') -or
                ([string]$_.DisplayName -match '(?i)^(?:Grafana(?: Labs)? Alloy|Alloy)$') -or
                ([string]$_.PathName -match '(?i)alloy-service-windows-amd64\.exe')
            })
        } catch { $failed = $true; $serviceEnumerationSucceeded = $false }
        if (-not $serviceEnumerationSucceeded) {
            $freshServiceRemoved = $false
        }
        elseif ($partialServices.Count -eq 1) {
            $partialName = [string]$partialServices[0].Name
            $freshServiceRemoved = Remove-OpsGridFreshService -Name $partialName
            if (-not $freshServiceRemoved) { $failed = $true }
        }
        elseif ($partialServices.Count -gt 1) {
            $failed = $true
            $freshServiceRemoved = $false
        }
        else { $freshServiceRemoved = $true }
        if ($freshServiceRemoved) {
            try { if (-not (Remove-OpsGridFreshAlloyRegistryState)) { $failed = $true } } catch { $failed = $true }
            try { if (-not (Remove-OpsGridFreshAlloyUserArtifacts)) { $failed = $true } } catch { $failed = $true }
        }
    }
    try {
        if ($InstallRootExistedBeforeRun -and -not [string]::IsNullOrWhiteSpace($InstallRootAclSddlBeforeRun)) {
            Set-OpsGridAclFromSddl -Path $script:InstallRoot -Sddl $InstallRootAclSddlBeforeRun -Directory
            if ([string](Get-Acl -LiteralPath $script:InstallRoot -ErrorAction Stop).Sddl -ne $InstallRootAclSddlBeforeRun) { throw 'install-root ACL rollback verification failed' }
        }
    } catch { $failed = $true }
    try {
        if ($ConfigDirectoryExistedBeforeRun -and -not [string]::IsNullOrWhiteSpace($ConfigDirectoryAclSddlBeforeRun)) {
            Set-OpsGridAclFromSddl -Path $script:AlloyConfigDirectory -Sddl $ConfigDirectoryAclSddlBeforeRun -Directory
            if ([string](Get-Acl -LiteralPath $script:AlloyConfigDirectory -ErrorAction Stop).Sddl -ne $ConfigDirectoryAclSddlBeforeRun) { throw 'config-directory ACL rollback verification failed' }
        }
    } catch { $failed = $true }
    try {
        if ($AlloyInstallDirectoryExistedBeforeRun -and -not [string]::IsNullOrWhiteSpace($AlloyInstallDirectoryAclSddlBeforeRun) -and [System.IO.Directory]::Exists($script:AlloyInstallDirectory)) {
            Set-OpsGridAclFromSddl -Path $script:AlloyInstallDirectory -Sddl $AlloyInstallDirectoryAclSddlBeforeRun -Directory
            if ([string](Get-Acl -LiteralPath $script:AlloyInstallDirectory -ErrorAction Stop).Sddl -ne $AlloyInstallDirectoryAclSddlBeforeRun) { throw 'Alloy install-directory ACL rollback verification failed' }
        }
    } catch { $failed = $true }
    if ($freshServiceRemoved) {
        try {
            if (-not $ConfigDirectoryExistedBeforeRun -and [System.IO.Directory]::Exists($script:AlloyConfigDirectory)) {
                $item = Get-Item -LiteralPath $script:AlloyConfigDirectory -Force -ErrorAction Stop
                if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'fresh Alloy config directory is a reparse point' }
                Remove-Item -LiteralPath $script:AlloyConfigDirectory -Recurse -Force -ErrorAction Stop
                if ([System.IO.Directory]::Exists($script:AlloyConfigDirectory)) { throw 'fresh Alloy config directory cleanup failed' }
            }
        } catch { $failed = $true }
        try {
            if (-not $AlloyInstallDirectoryExistedBeforeRun -and [System.IO.Directory]::Exists($script:AlloyInstallDirectory)) {
                $item = Get-Item -LiteralPath $script:AlloyInstallDirectory -Force -ErrorAction Stop
                if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'fresh Alloy install directory is a reparse point' }
                Remove-Item -LiteralPath $script:AlloyInstallDirectory -Recurse -Force -ErrorAction Stop
                if ([System.IO.Directory]::Exists($script:AlloyInstallDirectory)) { throw 'fresh Alloy install directory cleanup failed' }
            }
        } catch { $failed = $true }
    }
    return (-not $failed)
}

function Remove-OpsGridTempPaths([string]$RetainDirectory = $null) {
    $failed = $false
    $originalNames = @('credential.snapshot','config.snapshot','recovery.json')
    if (-not [string]::IsNullOrWhiteSpace($RetainDirectory)) {
        $RetainDirectory = [IO.Path]::GetFullPath($RetainDirectory)
        if (-not $script:OpsGridTempPaths.Contains($RetainDirectory) -or
            -not [string]::Equals([IO.Path]::GetDirectoryName($RetainDirectory),[IO.Path]::GetFullPath($script:InstallRoot),[StringComparison]::OrdinalIgnoreCase) -or
            [IO.Path]::GetFileName($RetainDirectory) -cnotmatch '^\.tmp-[a-f0-9]{32}$' -or -not (Test-OpsGridSafeDirectory $RetainDirectory)) { throw 'unsafe retained snapshot directory' }
        # Private snapshots may only retain originals and their explicit receipt,
        # not stray fresh credentials, restore attempts or validator transcripts.
        foreach ($item in @(Get-ChildItem -LiteralPath $RetainDirectory -Force -ErrorAction Stop)) {
            if ($item.Name -cnotin $originalNames) {
                try {
                    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe retained snapshot child' }
                    Remove-Item -LiteralPath $item.FullName -Force -Recurse -ErrorAction Stop
                } catch { $failed = $true }
            }
        }
    }
    foreach ($path in @($script:OpsGridTempPaths | Sort-Object Length -Descending)) {
        if (-not [string]::IsNullOrWhiteSpace($RetainDirectory)) {
            if ([string]::Equals($path, $RetainDirectory, [StringComparison]::OrdinalIgnoreCase) -or
                ([string]::Equals([IO.Path]::GetDirectoryName($path), $RetainDirectory, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($path) -cin $originalNames)) { continue }
        }
        try {
            if ([System.IO.File]::Exists($path) -or [System.IO.Directory]::Exists($path)) {
                Remove-Item -LiteralPath $path -Force -Recurse -ErrorAction Stop
            }
            if ([System.IO.File]::Exists($path) -or [System.IO.Directory]::Exists($path)) { $failed = $true }
        }
        catch { $failed = $true }
    }
    $script:OpsGridTempPaths.Clear()
    return (-not $failed)
}

function Set-OpsGridAclFromSddl([string]$Path, [string]$Sddl, [switch]$Directory) {
    if ([string]::IsNullOrWhiteSpace($Sddl)) { return }
    if (-not [System.IO.File]::Exists($Path) -and -not [System.IO.Directory]::Exists($Path)) { throw 'ACL target is unavailable' }
    if ($Directory) { $acl = New-Object System.Security.AccessControl.DirectorySecurity }
    else { $acl = New-Object System.Security.AccessControl.FileSecurity }
    $acl.SetSecurityDescriptorSddlForm($Sddl)
    Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
}

function Test-OpsGridFileSnapshot([string]$Path, [string]$SnapshotPath) {
    if (-not [System.IO.File]::Exists($Path) -or -not [System.IO.File]::Exists($SnapshotPath)) { return $false }
    $left = [System.IO.File]::ReadAllBytes($Path)
    $right = [System.IO.File]::ReadAllBytes($SnapshotPath)
    if ($left.Length -ne $right.Length) { return $false }
    for ($index = 0; $index -lt $left.Length; $index++) { if ($left[$index] -ne $right[$index]) { return $false } }
    return $true
}

function Wait-OpsGridServiceState([string]$Name, [string]$ExpectedStatus) {
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while ($true) {
        $current = Get-Service -Name $Name -ErrorAction Stop
        if ([string]$current.Status -eq $ExpectedStatus) { return $true }
        if ([DateTime]::UtcNow -ge $deadline) { return $false }
        Start-Sleep -Milliseconds 250
    }
}

function Wait-OpsGridServiceAbsent([string]$Name) {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ($true) {
        try {
            $service = Get-Service -Name $Name -ErrorAction Stop
            $service = $null
        }
        catch [Microsoft.PowerShell.Commands.ServiceCommandException] {
            return $true
        }
        catch {
            return $false
        }
        if ([DateTime]::UtcNow -ge $deadline) { return $false }
        Start-Sleep -Milliseconds 250
    }
}

function Get-OpsGridServiceStartType($ServiceName, $Service) {
    $mode = $null
    try {
        $cim = Get-CimInstance -ClassName Win32_Service -Filter ("Name='{0}'" -f $ServiceName) -ErrorAction Stop
        $mode = [string](Get-OpsGridPropertyValue $cim 'StartMode')
    }
    catch { $mode = $null }
    if ([string]::IsNullOrWhiteSpace($mode)) {
        try { $mode = [string](Get-OpsGridPropertyValue (Get-OpsGridPropertyValue $Service 'Service') 'StartType') } catch { $mode = $null }
    }
    switch -Regex ($mode) {
        '(?i)^auto(?:matic)?$' { return 'Automatic' }
        '(?i)^manual$' { return 'Manual' }
        '(?i)^disabled$' { return 'Disabled' }
        default { throw 'Alloy service startup mode is unavailable' }
    }
}

function New-OpsGridTransactionSnapshot(
    $Service,
    [string]$ConfigPath,
    [bool]$HadPreexistingService = $true,
    [bool]$InstallRootExistedBeforeRun = $true,
    [string]$InstallRootAclSddlBeforeRun = $null,
    [bool]$ConfigDirectoryExistedBeforeRun = $true,
    [string]$ConfigDirectoryAclSddlBeforeRun = $null,
    [bool]$AlloyInstallDirectoryExistedBeforeRun = $true,
    [string]$AlloyInstallDirectoryAclSddlBeforeRun = $null
) {
    $snapshotDirectory = New-OpsGridTempDirectory
    $credentialSnapshot = Join-Path $snapshotDirectory 'credential.snapshot'
    $configSnapshot = Join-Path $snapshotDirectory 'config.snapshot'
    if (-not (Test-OpsGridCredentialPath -Path $script:AgentCredentialFile)) { throw 'credential path is unsafe' }
    $credentialExists = [System.IO.File]::Exists($script:AgentCredentialFile)
    $configExists = [System.IO.File]::Exists($ConfigPath)
    $credentialAclSddl = $null
    $configAclSddl = $null
    $installRootAclSddl = $null
    $configDirectory = [System.IO.Path]::GetDirectoryName($ConfigPath)
    $configDirectoryAclSddl = $null
    if ($InstallRootExistedBeforeRun -and -not [string]::IsNullOrWhiteSpace($InstallRootAclSddlBeforeRun)) { $installRootAclSddl = $InstallRootAclSddlBeforeRun }
    elseif ($InstallRootExistedBeforeRun -and [System.IO.Directory]::Exists($script:InstallRoot)) { $installRootAclSddl = [string](Get-Acl -LiteralPath $script:InstallRoot -ErrorAction Stop).Sddl }
    if ($ConfigDirectoryExistedBeforeRun -and -not [string]::IsNullOrWhiteSpace($ConfigDirectoryAclSddlBeforeRun)) { $configDirectoryAclSddl = $ConfigDirectoryAclSddlBeforeRun }
    elseif ($ConfigDirectoryExistedBeforeRun -and -not [string]::IsNullOrWhiteSpace($configDirectory) -and [System.IO.Directory]::Exists($configDirectory)) { $configDirectoryAclSddl = [string](Get-Acl -LiteralPath $configDirectory -ErrorAction Stop).Sddl }
    $alloyInstallDirectoryAclSddl = $null
    if ($AlloyInstallDirectoryExistedBeforeRun -and -not [string]::IsNullOrWhiteSpace($AlloyInstallDirectoryAclSddlBeforeRun)) { $alloyInstallDirectoryAclSddl = $AlloyInstallDirectoryAclSddlBeforeRun }
    elseif ($AlloyInstallDirectoryExistedBeforeRun -and [System.IO.Directory]::Exists($script:AlloyInstallDirectory)) { $alloyInstallDirectoryAclSddl = [string](Get-Acl -LiteralPath $script:AlloyInstallDirectory -ErrorAction Stop).Sddl }
    if ($credentialExists) {
        $credentialAclSddl = [string](Get-Acl -LiteralPath $script:AgentCredentialFile -ErrorAction Stop).Sddl
        Copy-Item -LiteralPath $script:AgentCredentialFile -Destination $credentialSnapshot -Force -ErrorAction Stop
        Register-OpsGridTempPath $credentialSnapshot
    }
    if ($configExists) {
        $configAclSddl = [string](Get-Acl -LiteralPath $ConfigPath -ErrorAction Stop).Sddl
        Copy-Item -LiteralPath $ConfigPath -Destination $configSnapshot -Force -ErrorAction Stop
        Register-OpsGridTempPath $configSnapshot
    }
    $currentService = Get-Service -Name ([string]$Service.Name) -ErrorAction Stop
    if ($HadPreexistingService -and [string]$currentService.Status -notin @('Running', 'Stopped', 'Paused')) { throw 'Alloy service is in an unsupported transitional state' }
    $startType = if ($HadPreexistingService) { Get-OpsGridServiceStartType -ServiceName ([string]$Service.Name) -Service $Service } else { 'Disabled' }
    $snapshot = [pscustomobject]@{
        SnapshotDirectory = $snapshotDirectory
        CredentialExists = $credentialExists; ConfigExists = $configExists
        CredentialSnapshot = $credentialSnapshot; ConfigSnapshot = $configSnapshot
        CredentialAclSddl = $credentialAclSddl; ConfigAclSddl = $configAclSddl
        InstallRootExistedBeforeRun = $InstallRootExistedBeforeRun; InstallRootAclSddl = $installRootAclSddl
        ConfigDirectoryExistedBeforeRun = $ConfigDirectoryExistedBeforeRun; ConfigDirectoryAclSddl = $configDirectoryAclSddl
        AlloyInstallDirectoryExistedBeforeRun = $AlloyInstallDirectoryExistedBeforeRun; AlloyInstallDirectoryAclSddl = $alloyInstallDirectoryAclSddl
        ConfigPath = $ConfigPath; Service = $Service
        OriginalStatus = [string]$currentService.Status
        WasRunning = $HadPreexistingService -and ([string]$currentService.Status -eq 'Running')
        WasStopped = $HadPreexistingService -and ([string]$currentService.Status -eq 'Stopped')
        WasPaused = $HadPreexistingService -and ([string]$currentService.Status -eq 'Paused')
        StartType = $startType
        HadPreexistingService = $HadPreexistingService
    }
    # Explicit metadata only: never serialize live Service/CIM objects, HTTP
    # responses, tokens, or newly-issued credentials into the recovery snapshot.
    $metadata = [ordered]@{
        SchemaVersion = 1; ServiceName = [string]$Service.Name
        OriginalStatus = $snapshot.OriginalStatus; StartType = $snapshot.StartType
        HadPreexistingService = $snapshot.HadPreexistingService
        CredentialPath = $script:AgentCredentialFile; CredentialExists = $credentialExists
        ConfigPath = $ConfigPath; ConfigExists = $configExists
        CredentialSnapshot = 'credential.snapshot'; ConfigSnapshot = 'config.snapshot'
        CredentialAclSddl = $credentialAclSddl; ConfigAclSddl = $configAclSddl
        InstallRoot = $script:InstallRoot; InstallRootExistedBeforeRun = $InstallRootExistedBeforeRun; InstallRootAclSddl = $installRootAclSddl
        ConfigDirectory = $configDirectory; ConfigDirectoryExistedBeforeRun = $ConfigDirectoryExistedBeforeRun; ConfigDirectoryAclSddl = $configDirectoryAclSddl
        AlloyInstallDirectory = $script:AlloyInstallDirectory; AlloyInstallDirectoryExistedBeforeRun = $AlloyInstallDirectoryExistedBeforeRun; AlloyInstallDirectoryAclSddl = $alloyInstallDirectoryAclSddl
    }
    $metadataPath = Register-OpsGridTempPath (Join-Path $snapshotDirectory 'recovery.json')
    Write-OpsGridUtf8NoBom -Path $metadataPath -Content ($metadata | ConvertTo-Json -Depth 3)
    return $snapshot
}

function Restore-OpsGridTransaction($Snapshot) {
    if ($null -eq $Snapshot) { return }
    $rollbackErrors = New-Object System.Collections.Generic.List[string]
    $serviceQuiesced = $true
    $persistentStateRestored = $true
    $freshServiceRemoved = [bool]$Snapshot.HadPreexistingService
    if (-not $Snapshot.HadPreexistingService) {
        $freshServiceRemoved = Remove-OpsGridFreshService -Name ([string]$Snapshot.Service.Name)
        if (-not $freshServiceRemoved) { $rollbackErrors.Add('service stop/delete'); $serviceQuiesced = $false }
    }
    else {
        try {
            $currentService = Get-Service -Name ([string]$Snapshot.Service.Name) -ErrorAction Stop
            if ([string]$currentService.Status -ne 'Stopped') {
                Stop-Service -Name ([string]$Snapshot.Service.Name) -Force -ErrorAction Stop
                if (-not (Wait-OpsGridServiceState -Name ([string]$Snapshot.Service.Name) -ExpectedStatus 'Stopped')) { throw 'service quiesce failed' }
            }
        }
        catch { $rollbackErrors.Add('service quiesce'); $serviceQuiesced = $false }
    }
    try {
        if ($serviceQuiesced -and ($Snapshot.HadPreexistingService -or $freshServiceRemoved)) {
            if ($Snapshot.CredentialExists) {
            $temp = Join-Path $script:InstallRoot ('.restore-credential.' + [guid]::NewGuid().ToString('N') + '.tmp')
            Register-OpsGridTempPath $temp
            Copy-Item -LiteralPath $Snapshot.CredentialSnapshot -Destination $temp -Force -ErrorAction Stop
            Invoke-OpsGridAtomicReplace -Source $temp -Destination $script:AgentCredentialFile
            if (-not (Test-OpsGridFileSnapshot $script:AgentCredentialFile $Snapshot.CredentialSnapshot)) { throw 'credential rollback verification failed' }
            Set-OpsGridAclFromSddl -Path $script:AgentCredentialFile -Sddl $Snapshot.CredentialAclSddl
            if ([string](Get-Acl -LiteralPath $script:AgentCredentialFile -ErrorAction Stop).Sddl -ne [string]$Snapshot.CredentialAclSddl) { throw 'credential ACL rollback verification failed' }
        }
        else {
            if ([System.IO.File]::Exists($script:AgentCredentialFile)) { Remove-Item -LiteralPath $script:AgentCredentialFile -Force -ErrorAction Stop }
            if ([System.IO.File]::Exists($script:AgentCredentialFile)) { throw 'new credential cleanup failed' }
            }
        }
    } catch { $rollbackErrors.Add('credential'); $persistentStateRestored = $false }
    try {
        if ($serviceQuiesced -and ($Snapshot.HadPreexistingService -or $freshServiceRemoved)) {
        if ($Snapshot.ConfigExists) {
            $tempConfig = Join-Path ([System.IO.Path]::GetDirectoryName($Snapshot.ConfigPath)) ('.restore-config.' + [guid]::NewGuid().ToString('N') + '.tmp')
            Register-OpsGridTempPath $tempConfig
            Copy-Item -LiteralPath $Snapshot.ConfigSnapshot -Destination $tempConfig -Force -ErrorAction Stop
            Invoke-OpsGridAtomicReplace -Source $tempConfig -Destination $Snapshot.ConfigPath
            if (-not (Test-OpsGridFileSnapshot $Snapshot.ConfigPath $Snapshot.ConfigSnapshot)) { throw 'config rollback verification failed' }
            Set-OpsGridAclFromSddl -Path $Snapshot.ConfigPath -Sddl $Snapshot.ConfigAclSddl
            if ([string](Get-Acl -LiteralPath $Snapshot.ConfigPath -ErrorAction Stop).Sddl -ne [string]$Snapshot.ConfigAclSddl) { throw 'config ACL rollback verification failed' }
        }
        else {
            if ([System.IO.File]::Exists($Snapshot.ConfigPath)) { Remove-Item -LiteralPath $Snapshot.ConfigPath -Force -ErrorAction Stop }
            if ([System.IO.File]::Exists($Snapshot.ConfigPath)) { throw 'new config cleanup failed' }
        }
        }
    } catch { $rollbackErrors.Add('config'); $persistentStateRestored = $false }
    try {
        if ($serviceQuiesced -and -not [string]::IsNullOrWhiteSpace([string]$Snapshot.InstallRootAclSddl)) {
            Set-OpsGridAclFromSddl -Path $script:InstallRoot -Sddl $Snapshot.InstallRootAclSddl -Directory
            if ([string](Get-Acl -LiteralPath $script:InstallRoot -ErrorAction Stop).Sddl -ne [string]$Snapshot.InstallRootAclSddl) { throw 'install-root ACL rollback verification failed' }
        }
    } catch { $rollbackErrors.Add('install-root ACL'); $persistentStateRestored = $false }
    try {
        if ($serviceQuiesced -and -not [string]::IsNullOrWhiteSpace([string]$Snapshot.ConfigDirectoryAclSddl)) {
            $configDirectory = [System.IO.Path]::GetDirectoryName($Snapshot.ConfigPath)
            Set-OpsGridAclFromSddl -Path $configDirectory -Sddl $Snapshot.ConfigDirectoryAclSddl -Directory
            if ([string](Get-Acl -LiteralPath $configDirectory -ErrorAction Stop).Sddl -ne [string]$Snapshot.ConfigDirectoryAclSddl) { throw 'config-directory ACL rollback verification failed' }
        }
    } catch { $rollbackErrors.Add('config-directory ACL'); $persistentStateRestored = $false }
    try {
        if ($serviceQuiesced -and -not [string]::IsNullOrWhiteSpace([string]$Snapshot.AlloyInstallDirectoryAclSddl) -and [System.IO.Directory]::Exists($script:AlloyInstallDirectory)) {
            Set-OpsGridAclFromSddl -Path $script:AlloyInstallDirectory -Sddl $Snapshot.AlloyInstallDirectoryAclSddl -Directory
            if ([string](Get-Acl -LiteralPath $script:AlloyInstallDirectory -ErrorAction Stop).Sddl -ne [string]$Snapshot.AlloyInstallDirectoryAclSddl) { throw 'Alloy install-directory ACL rollback verification failed' }
        }
    } catch { $rollbackErrors.Add('Alloy install-directory ACL'); $persistentStateRestored = $false }
    $serviceName = [string]$Snapshot.Service.Name
    try {
        if ($serviceQuiesced -and $persistentStateRestored -and $Snapshot.HadPreexistingService) {
            switch ([string]$Snapshot.OriginalStatus) {
                'Running' {
                    Start-Service -Name $serviceName -ErrorAction Stop
                    if (-not (Wait-OpsGridServiceState -Name $serviceName -ExpectedStatus 'Running')) { throw 'service running-state rollback failed' }
                }
                'Paused' {
                    $currentForPause = Get-Service -Name $serviceName -ErrorAction Stop
                    if ([string]$currentForPause.Status -eq 'Stopped') {
                        Start-Service -Name $serviceName -ErrorAction Stop
                        if (-not (Wait-OpsGridServiceState -Name $serviceName -ExpectedStatus 'Running')) { throw 'service pause rollback start failed' }
                    }
                    if ([string](Get-Service -Name $serviceName -ErrorAction Stop).Status -ne 'Paused') {
                        Suspend-Service -Name $serviceName -ErrorAction Stop
                        if (-not (Wait-OpsGridServiceState -Name $serviceName -ExpectedStatus 'Paused')) { throw 'service paused-state rollback failed' }
                    }
                }
                'Stopped' {
                    Stop-Service -Name $serviceName -Force -ErrorAction Stop
                    if (-not (Wait-OpsGridServiceState -Name $serviceName -ExpectedStatus 'Stopped')) { throw 'service stopped-state rollback failed' }
                }
                default { throw 'service original state is unsupported' }
            }
            if (-not [string]::IsNullOrWhiteSpace([string]$Snapshot.StartType)) {
                Set-Service -Name $serviceName -StartupType ([string]$Snapshot.StartType) -ErrorAction Stop
                $restoredService = Get-Service -Name $serviceName -ErrorAction Stop
                if ([string]$restoredService.StartType -ne [string]$Snapshot.StartType) { throw 'service startup rollback failed' }
            }
        }
    } catch { $rollbackErrors.Add('service state') }
    try {
        if (-not $Snapshot.HadPreexistingService -and $freshServiceRemoved -and -not (Remove-OpsGridFreshAlloyRegistryState)) { throw 'fresh Alloy registry cleanup failed' }
    } catch { $rollbackErrors.Add('Alloy registry state') }
    try {
        if (-not $Snapshot.HadPreexistingService -and $freshServiceRemoved -and -not (Remove-OpsGridFreshAlloyUserArtifacts)) { throw 'fresh Alloy user artifact cleanup failed' }
    } catch { $rollbackErrors.Add('Alloy user artifacts') }
    # Stop/delete the fresh service before removing its installed files, because
    # the Alloy process can otherwise keep the executable/config directory open.
    try {
        if (-not $Snapshot.HadPreexistingService -and $freshServiceRemoved -and -not $Snapshot.ConfigDirectoryExistedBeforeRun) {
            $configDirectory = [System.IO.Path]::GetDirectoryName($Snapshot.ConfigPath)
            if ([System.IO.Directory]::Exists($configDirectory)) {
                $directoryItem = Get-Item -LiteralPath $configDirectory -Force -ErrorAction Stop
                if (($directoryItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'fresh config directory is a reparse point' }
                Remove-Item -LiteralPath $configDirectory -Recurse -Force -ErrorAction Stop
            }
            if ([System.IO.Directory]::Exists($configDirectory)) { throw 'fresh config directory cleanup failed' }
        }
    } catch { $rollbackErrors.Add('fresh config directory') }
    try {
        if (-not $Snapshot.HadPreexistingService -and $freshServiceRemoved -and -not $Snapshot.AlloyInstallDirectoryExistedBeforeRun) {
            if ([System.IO.Directory]::Exists($script:AlloyInstallDirectory)) {
                $directoryItem = Get-Item -LiteralPath $script:AlloyInstallDirectory -Force -ErrorAction Stop
                if (($directoryItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'fresh Alloy install directory is a reparse point' }
                Remove-Item -LiteralPath $script:AlloyInstallDirectory -Recurse -Force -ErrorAction Stop
            }
            if ([System.IO.Directory]::Exists($script:AlloyInstallDirectory)) { throw 'fresh Alloy install directory cleanup failed' }
        }
    } catch { $rollbackErrors.Add('fresh Alloy install directory') }
    if ($rollbackErrors.Count -gt 0) { throw ('transaction rollback failed: ' + [string]::Join(', ', $rollbackErrors)) }
    return $true
}
