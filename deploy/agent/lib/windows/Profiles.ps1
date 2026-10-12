# Internal installer declarations; dot-sourced by the guarded entrypoint.
function Get-OpsGridConfigTokens([string]$Text) {
    $tokens = New-Object 'System.Collections.Generic.List[string]'
    $i = 0
    while ($i -lt $Text.Length) {
        $c = $Text[$i]
        if ([char]::IsWhiteSpace($c)) { $i++; continue }
        if ($i + 1 -lt $Text.Length -and $Text.Substring($i,2) -eq '//') {
            while ($i -lt $Text.Length -and $Text[$i] -notin @([char]10,[char]13)) { $i++ }
            continue
        }
        if ($i + 1 -lt $Text.Length -and $Text.Substring($i,2) -eq '/*') {
            $end = $Text.IndexOf('*/',$i+2,[StringComparison]::Ordinal)
            if ($end -lt 0) { throw 'invalid config comment' }
            $i = $end + 2; continue
        }
        if ($c -eq '"') {
            $start = $i++; $closed = $false
            while ($i -lt $Text.Length) {
                if ([int]$Text[$i] -lt 32) { throw 'invalid config string' }
                if ($Text[$i] -eq '\') { $i += 2; continue }
                if ($Text[$i] -eq '"') { $i++; $closed=$true; break }
                $i++
            }
            if (-not $closed) { throw 'invalid config string' }
            $tokens.Add($Text.Substring($start,$i-$start)); continue
        }
        $match = [regex]::Match($Text.Substring($i),'^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|==|!=|<=|>=|&&|\|\||[{}\[\]().,=:+*/!<>%-])')
        if (-not $match.Success) { throw 'invalid config token' }
        $tokens.Add($match.Value); $i += $match.Length
    }
    return $tokens.ToArray()
}

function ConvertTo-OpsGridCanonicalConfig([string]$Text) {
    # Length framing retains token boundaries: foo bar cannot become foobar.
    # Quoted contents (including comment-looking text/escapes) remain literal.
    $result = New-Object Text.StringBuilder
    foreach ($token in @(Get-OpsGridConfigTokens $Text)) { $null=$result.Append($token.Length).Append(':').Append($token) }
    return $result.ToString()
}

function Test-OpsGridGatewayEndpoint([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -ne $Value.Trim() -or $Value -match '[\s\x00-\x1F\x7F\\"?#]' -or
        $Value -match '(?i)%(?:2e|2f|5c|0[0-9a-f]|1[0-9a-f]|7f)' -or $Value -match '(?:^|/)\.{1,2}(?:/|$)') { throw 'unsafe Gateway endpoint' }
    $match=[regex]::Match($Value,'^(?<origin>https?://[^/]+)(?:/[^?\x23]*)?$')
    if (-not $match.Success) { throw 'unsafe Gateway endpoint' }
    $null=Get-OpsGridApiOrigin $match.Groups['origin'].Value
    $uri=[uri]$Value
    if (-not $uri.IsAbsoluteUri) { throw 'unsafe Gateway endpoint' }
    return $uri
}

function Get-OpsGridProfileTemplatePaths([string]$ProfileName) {
    if ($ProfileName -cne 'windows-baseline-v1') { throw 'profile target is not reviewed' }
    return [pscustomobject]@{
        Original=(Join-Path $script:OpsGridInstallerRoot 'alloy\windows.config.alloy.template')
        Target=(Join-Path $script:OpsGridInstallerRoot 'alloy\windows-baseline-v1.config.alloy.template')
    }
}

function Get-OpsGridProfileConfigValue([string]$Text,[string]$Name) {
    $tokens=@(Get-OpsGridConfigTokens $Text); $values=New-Object 'System.Collections.Generic.List[string]'
    for ($i=0; $i -lt $tokens.Count-2; $i++) {
        if ($tokens[$i] -ceq $Name -and $tokens[$i+1] -ceq '=') {
            $token=$tokens[$i+2]
            if ($token -notmatch '^"[^"\\\r\n]*"$') { throw 'managed config value is unsafe' }
            $values.Add($token.Substring(1,$token.Length-2))
        }
    }
    if ($values.Count -ne 1) { throw 'managed config value is not unique' }
    return $values[0]
}

function Expand-OpsGridProfileTemplate([string]$Text,[string]$CredentialPath,[string]$GatewayUrl) {
    $credential=Get-OpsGridProfileConfigValue $Text 'filename'
    $gateway=Get-OpsGridProfileConfigValue $Text 'url'
    if ($credential -cne '__CREDENTIAL_FILE__') { throw 'managed template credential placeholder is invalid' }
    $null=Test-OpsGridGatewayEndpoint $gateway
    # Replace quoted lexemes only, never comment fragments or unquoted tokens.
    $tokens=@(Get-OpsGridConfigTokens $Text)
    $credentialCount=@($tokens | Where-Object { $_ -ceq '"__CREDENTIAL_FILE__"' }).Count
    $gatewayCount=@($tokens | Where-Object { $_ -ceq ('"'+$gateway+'"') }).Count
    if ($credentialCount -ne 1 -or $gatewayCount -ne 1) { throw 'managed template parameters are ambiguous' }
    return $Text.Replace('"__CREDENTIAL_FILE__"',('"'+$CredentialPath+'"')).Replace(('"'+$gateway+'"'),('"'+$GatewayUrl+'"'))
}

function Get-OpsGridManagedWindowsConfig([string]$ConfigPath,[string]$CredentialPath,[string]$OriginalTemplatePath,[string]$ProfileTemplatePath) {
    if (-not (Test-AlloyConfigPath $ConfigPath) -or -not (Test-OpsGridCredentialPath $CredentialPath)) { throw 'managed paths are unsafe' }
    foreach ($path in @($ConfigPath,$CredentialPath,$OriginalTemplatePath,$ProfileTemplatePath)) {
        if (-not [IO.Path]::IsPathRooted($path) -or -not (Test-OpsGridSafeRegularFile $path)) { throw 'managed file is unavailable or unsafe' }
    }
    $text=[IO.File]::ReadAllText($ConfigPath)
    $gateway=Get-OpsGridProfileConfigValue $text 'url'; $null=Test-OpsGridGatewayEndpoint $gateway
    $credential=Get-OpsGridProfileConfigValue $text 'filename'
    if ($credential -cne $script:AlloyCredentialConfigPath -or $credential -cne $CredentialPath.Replace('\','/')) { throw 'managed credential reference is unsafe' }
    $canonical=ConvertTo-OpsGridCanonicalConfig $text
    # Pin both safe assets and their whole instantiated identities once. The
    # installed lock does not freeze deployment-side templates during validation.
    $assets=@{}
    foreach ($kind in @('Target','Original')) {
        $template=if($kind -eq 'Target') {$ProfileTemplatePath} else {$OriginalTemplatePath}
        if(-not (Test-OpsGridSafeRegularFile $template)) { throw 'managed template path changed' }
        $bytes=[IO.File]::ReadAllBytes($template)
        if(-not (Test-OpsGridSafeRegularFile $template)) { throw 'managed template ancestry changed' }
        $assetText=[Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xFEFF)
        $expanded=Expand-OpsGridProfileTemplate $assetText $credential $gateway
        $assets[$kind]=[pscustomobject]@{Bytes=$bytes;Canonical=(ConvertTo-OpsGridCanonicalConfig $expanded);ConfigBytes=([Text.Encoding]::UTF8.GetBytes($expanded))}
    }
    foreach ($kind in @('Target','Original')) {
        if ($canonical -ceq $assets[$kind].Canonical) {
            return [pscustomobject]@{
                Kind=$kind; GatewayUrl=$gateway; CredentialPath=$credential; Canonical=$canonical
                OriginalTemplateBytes=$assets.Original.Bytes;OriginalCanonical=$assets.Original.Canonical
                TargetTemplateBytes=$assets.Target.Bytes;TargetCanonical=$assets.Target.Canonical;TargetConfigBytes=$assets.Target.ConfigBytes
            }
        }
    }
    throw 'config is not a complete managed Windows identity'
}

function Set-OpsGridProfileAcl([string]$Path,[string]$Sddl,[switch]$Directory) {
    # Native ACL persistence avoids Set-Acl's SACL privilege request on Windows.
    # Only sections actually captured by Get-Acl are written; no audit-policy change.
    $acl=if($Directory) {New-Object Security.AccessControl.DirectorySecurity} else {New-Object Security.AccessControl.FileSecurity}
    $sections=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
    $acl.SetSecurityDescriptorSddlForm($Sddl,$sections)
    if ($PSVersionTable.PSVersion.Major -ge 7) {
        if($Directory) { [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($Path),$acl) }
        else { [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($Path),$acl) }
    }
    elseif($Directory) { [IO.Directory]::SetAccessControl($Path,$acl) }
    else { [IO.File]::SetAccessControl($Path,$acl) }
}

function Set-OpsGridProfileStagingAcl([string]$Path,[string]$Sddl) {
    # A staging file has a different parent. Freeze the ORIGINAL effective ACEs
    # as explicit entries; never inherit the private directory's caller grant.
    $acl=New-Object Security.AccessControl.FileSecurity
    $acl.SetSecurityDescriptorSddlForm($Sddl,'Access,Owner,Group')
    $acl.SetAccessRuleProtection($true,$true)
    Set-OpsGridProfileAcl $Path $acl.GetSecurityDescriptorSddlForm('Access,Owner,Group')
    return (Get-Acl -LiteralPath $Path -ErrorAction Stop).Sddl
}

function New-OpsGridProfilePrivateDirectory([string]$Parent) {
    if (-not [IO.Directory]::Exists($Parent) -or -not (Test-OpsGridSafeDirectory $Parent)) { throw 'private profile parent is unsafe' }
    $path=Join-Path $Parent ('.opsgrid-profile-'+[guid]::NewGuid().ToString('N'))
    $acl=New-Object Security.AccessControl.DirectorySecurity
    $caller=[Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetOwner($caller); $acl.SetAccessRuleProtection($true,$false)
    foreach($sid in @($caller,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')),(New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
    }
    # Empty directory first; private ACL BEFORE any config/identity bytes exist.
    $null=[IO.Directory]::CreateDirectory($path)
    Set-OpsGridProfileAcl $path $acl.GetSecurityDescriptorSddlForm('Access,Owner,Group') -Directory
    return $path
}

function Test-OpsGridProfileLockAcl([string]$Path) {
    $acl=Get-Acl -LiteralPath $Path -ErrorAction Stop
    $caller=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $trusted=@('S-1-5-18','S-1-5-32-544',$caller)
    if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { return $false }
    $write=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach($rule in $acl.Access) {
        if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $write) -ne 0 -and $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { return $false }
    }
    return $true
}

function Acquire-OpsGridProfileLock {
    # Existing installed lock only. No creation, ACL repair, truncation or metadata.
    if (-not (Test-OpsGridSafeRegularFile $script:InstallLockFile) -or -not (Test-OpsGridSafeDirectory $script:InstallRoot) -or
        -not (Test-OpsGridProfileLockAcl $script:InstallRoot) -or -not (Test-OpsGridProfileLockAcl $script:InstallLockFile)) { throw 'profile lock is unsafe or unavailable' }
    $script:OpsGridLockStream=[IO.File]::Open($script:InstallLockFile,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
    if (-not (Test-OpsGridSafeRegularFile $script:InstallLockFile) -or -not (Test-OpsGridProfileLockAcl $script:InstallRoot)) { Release-OpsGridLock; throw 'profile lock ancestry changed' }
}

function Get-OpsGridProfileStartupMetadata($Service) {
    $name=[string]$Service.Name
    if ($name -notmatch '^[A-Za-z0-9_.-]+$') { throw 'service metadata path is unsafe' }
    $registry=Get-ItemProperty -LiteralPath ('HKLM:\SYSTEM\CurrentControlSet\Services\'+$name) -ErrorAction Stop
    $start=Get-OpsGridPropertyValue $registry 'Start'
    if ($null -eq $start -or [int]$start -notin @(2,3,4)) { throw 'service startup metadata is unsupported' }
    $cim=Get-CimInstance -ClassName Win32_Service -Filter ("Name='{0}'" -f $name) -ErrorAction Stop
    $delayed=Get-OpsGridPropertyValue $registry 'DelayedAutoStart'
    return [pscustomobject]@{Start=[int]$start;DelayedExists=($null -ne $delayed);DelayedAutoStart=$delayed;StartMode=[string]$cim.StartMode;StartName=[string]$cim.StartName;PathName=[string]$cim.PathName}
}

function New-OpsGridProfileSnapshot($Service,[string]$ConfigPath) {
    if (-not (Test-OpsGridSafeRegularFile $ConfigPath) -or -not (Test-OpsGridSafeRegularFile $script:AgentCredentialFile)) { throw 'profile snapshot paths are unsafe' }
    $parent=[IO.Path]::GetDirectoryName($ConfigPath)
    if(-not (Test-OpsGridProfileLockAcl $parent)) { throw 'profile config parent security is unsafe' }
    $status=[string](Get-Service -Name $Service.Name -ErrorAction Stop).Status
    if($status -notin @('Running','Stopped','Paused')) { throw 'service is in a transitional state' }
    $snapshot=[pscustomobject]@{
        Service=$Service;ConfigPath=$ConfigPath;Parent=$parent;OriginalStatus=$status
        ConfigBytes=[IO.File]::ReadAllBytes($ConfigPath);ConfigAcl=(Get-Acl -LiteralPath $ConfigPath -ErrorAction Stop).Sddl
        ParentAcl=(Get-Acl -LiteralPath $parent -ErrorAction Stop).Sddl;RootAcl=(Get-Acl -LiteralPath $script:InstallRoot -ErrorAction Stop).Sddl
        CredentialBytes=[IO.File]::ReadAllBytes($script:AgentCredentialFile);CredentialAcl=(Get-Acl -LiteralPath $script:AgentCredentialFile -ErrorAction Stop).Sddl
        Startup=(Get-OpsGridProfileStartupMetadata $Service | ConvertTo-Json -Compress)
        Directory=$null;ConfigSnapshot=$null;OwnedConfigAcl=$null;ExpectedTargetBytes=$null
    }
    $snapshot.Directory=New-OpsGridProfilePrivateDirectory $parent
    $snapshot.ConfigSnapshot=Join-Path $snapshot.Directory 'original.config'
    try {
        [IO.File]::WriteAllBytes($snapshot.ConfigSnapshot,$snapshot.ConfigBytes)
        # Durable exact config ACL receipt precedes every config ACL/byte mutation.
        # No credential bytes or token enter this private recovery metadata.
        $startup = $snapshot.Startup | ConvertFrom-Json
        $metadata=[ordered]@{
            SchemaVersion=1; ServiceName=[string]$Service.Name; OriginalStatus=$snapshot.OriginalStatus
            ConfigPath=$snapshot.ConfigPath; ConfigAcl=$snapshot.ConfigAcl; ParentPath=$snapshot.Parent; ParentAcl=$snapshot.ParentAcl
            InstallRoot=$script:InstallRoot; RootAcl=$snapshot.RootAcl
            CredentialPath=$script:AgentCredentialFile; CredentialAcl=$snapshot.CredentialAcl
            Startup=[ordered]@{Start=$startup.Start;DelayedExists=$startup.DelayedExists;DelayedAutoStart=$startup.DelayedAutoStart;StartMode=$startup.StartMode;StartName=$startup.StartName}
        } | ConvertTo-Json -Depth 3 -Compress
        [IO.File]::WriteAllText((Join-Path $snapshot.Directory 'original.config.acl.json'),$metadata)
    }
    catch {
        $directory=[IO.Path]::GetFullPath($snapshot.Directory)
        if([IO.Path]::GetDirectoryName($directory) -ceq $parent -and [IO.Path]::GetFileName($directory) -like '.opsgrid-profile-*' -and (Test-OpsGridSafeDirectory $directory)) {
            Remove-Item -LiteralPath $directory -Force -Recurse -ErrorAction Stop
        }
        throw
    }
    return $snapshot
}

function Test-OpsGridProfileBytes([string]$Path,[byte[]]$Bytes) {
    if(-not (Test-OpsGridSafeRegularFile $Path)) { return $false }
    $actual=[IO.File]::ReadAllBytes($Path)
    if($actual.Length -ne $Bytes.Length) { return $false }
    for($i=0;$i -lt $Bytes.Length;$i++) { if($actual[$i] -ne $Bytes[$i]) { return $false } }
    return $true
}

function Assert-OpsGridProfileInvariants($Snapshot,[switch]$IncludeConfig,[switch]$IncludeState,[switch]$AllowOwnedConfigAcl) {
    foreach($path in @($Snapshot.ConfigPath,$script:AgentCredentialFile,$script:InstallLockFile)) { if(-not (Test-OpsGridSafeRegularFile $path)) { throw 'profile file ancestry changed' } }
    $configAcl=(Get-Acl -LiteralPath $Snapshot.ConfigPath).Sddl
    # Only a commit-owned protected staging descriptor is an allowed transition.
    # Precommit/normal assertions remain exact; all other identity/security guards
    # remain strict even during recovery. Unknown external ACLs are never repaired.
    $configAclMatches=$configAcl -ceq $Snapshot.ConfigAcl
    if($AllowOwnedConfigAcl -and $null -ne $Snapshot.OwnedConfigAcl -and $configAcl -ceq $Snapshot.OwnedConfigAcl) { $configAclMatches=$true }
    if(-not $configAclMatches -or (Get-Acl -LiteralPath $Snapshot.Parent).Sddl -cne $Snapshot.ParentAcl -or
        (Get-Acl -LiteralPath $script:InstallRoot).Sddl -cne $Snapshot.RootAcl -or (Get-Acl -LiteralPath $script:AgentCredentialFile).Sddl -cne $Snapshot.CredentialAcl -or
        -not (Test-OpsGridProfileBytes $script:AgentCredentialFile $Snapshot.CredentialBytes) -or
        (Get-OpsGridProfileStartupMetadata $Snapshot.Service | ConvertTo-Json -Compress) -cne $Snapshot.Startup) { throw 'profile security or identity changed' }
    if($IncludeConfig -and -not (Test-OpsGridProfileBytes $Snapshot.ConfigPath $Snapshot.ConfigBytes)) { throw 'profile config changed' }
    if($IncludeState -and [string](Get-Service -Name $Snapshot.Service.Name -ErrorAction Stop).Status -cne $Snapshot.OriginalStatus) { throw 'profile service state changed' }
}

function Set-OpsGridProfileServiceState($Service,[string]$OriginalStatus) {
    $name=[string]$Service.Name; $current=[string](Get-Service -Name $name -ErrorAction Stop).Status
    switch($OriginalStatus) {
        'Stopped' { if($current -ne 'Stopped') { Stop-Service -Name $name -Force -ErrorAction Stop } }
        'Running' {
            if($current -eq 'Stopped') { Start-Service -Name $name -ErrorAction Stop }
            elseif($current -eq 'Paused') { Resume-Service -Name $name -ErrorAction Stop }
            elseif($current -ne 'Running') { throw 'service state is unsupported' }
        }
        'Paused' {
            if($current -eq 'Stopped') { Start-Service -Name $name -ErrorAction Stop; if(-not (Wait-OpsGridServiceState $name 'Running')) { throw 'profile service start failed' } }
            elseif($current -notin @('Running','Paused')) { throw 'service state is unsupported' }
            if([string](Get-Service -Name $name -ErrorAction Stop).Status -ne 'Paused') { Suspend-Service -Name $name -ErrorAction Stop }
        }
        default { throw 'profile original service state is unsupported' }
    }
    if(-not (Wait-OpsGridServiceState $name $OriginalStatus)) { throw 'profile service state restoration failed' }
}

function Restore-OpsGridProfileTransaction($Snapshot) {
    # Fail closed on external credential/startup/ancestry changes; never write AGT,
    # installation roots, WAL or registry metadata in config-only recovery.
    Assert-OpsGridProfileInvariants $Snapshot -AllowOwnedConfigAcl
    if(Test-OpsGridProfileBytes $Snapshot.ConfigPath $Snapshot.ConfigBytes) {
        # A failed pre-byte commit may leave only our protected destination ACL.
        Set-OpsGridProfileAcl $Snapshot.ConfigPath $Snapshot.ConfigAcl
        Assert-OpsGridProfileInvariants $Snapshot -IncludeConfig -IncludeState
        return
    }
    if($null -eq $Snapshot.ExpectedTargetBytes -or -not (Test-OpsGridProfileBytes $Snapshot.ConfigPath $Snapshot.ExpectedTargetBytes)) { throw 'profile recovery config ownership changed' }
    $name=[string]$Snapshot.Service.Name
    if([string](Get-Service -Name $name -ErrorAction Stop).Status -ne 'Stopped') {
        Stop-Service -Name $name -Force -ErrorAction Stop
        if(-not (Wait-OpsGridServiceState $name 'Stopped')) { throw 'profile recovery quiesce failed' }
    }
    $restore=Join-Path $Snapshot.Directory 'restore.config'
    [IO.File]::WriteAllBytes($restore,$Snapshot.ConfigBytes)
    $Snapshot.OwnedConfigAcl=Set-OpsGridProfileStagingAcl $restore $Snapshot.ConfigAcl
    Set-OpsGridProfileAcl $Snapshot.ConfigPath $Snapshot.OwnedConfigAcl
    Assert-OpsGridProfileInvariants $Snapshot -AllowOwnedConfigAcl
    if(-not (Test-OpsGridProfileBytes $Snapshot.ConfigPath $Snapshot.ConfigBytes) -and
        ($null -eq $Snapshot.ExpectedTargetBytes -or -not (Test-OpsGridProfileBytes $Snapshot.ConfigPath $Snapshot.ExpectedTargetBytes))) { throw 'profile recovery config ownership changed' }
    Invoke-OpsGridAtomicReplace $restore $Snapshot.ConfigPath
    Assert-OpsGridProfileInvariants $Snapshot -IncludeConfig -AllowOwnedConfigAcl
    Set-OpsGridProfileAcl $Snapshot.ConfigPath $Snapshot.ConfigAcl
    Assert-OpsGridProfileInvariants $Snapshot -IncludeConfig
    Set-OpsGridProfileServiceState $Snapshot.Service $Snapshot.OriginalStatus
    Assert-OpsGridProfileInvariants $Snapshot -IncludeConfig -IncludeState
}

function Invoke-OpsGridApplyProfile([string]$ProfileName) {
    $snapshot=$null; $mutated=$false; $commitAttempted=$false; $keepSnapshot=$false; $locked=$false; $failureCode=10
    $originalEnvironmentPath=[string]$env:PATH
    $script:OpsGridExitCode=0; $script:OpsGridFailureCode=0; $script:OpsGridFailureMessage=''
    try {
        $paths=Get-OpsGridProfileTemplatePaths $ProfileName
        if($ProfileName -cne 'windows-baseline-v1' -or -not (Test-OpsGridSafeRegularFile $paths.Target) -or -not (Test-OpsGridSafeRegularFile $paths.Original)) {
            Fail-OpsGrid 10 'profile target is not reviewed; no changes made'
        }
        Test-OpsGridPreflight; $null=Get-WindowsPlatform
        $failureCode=20; Acquire-OpsGridProfileLock; $locked=$true
        $service=Get-AlloyService
        if($null -eq $service) { throw 'installed Alloy service is required' }
        $config=Get-AlloyConfigPath $service
        $managed=Get-OpsGridManagedWindowsConfig $config $script:AgentCredentialFile $paths.Original $paths.Target
        $snapshot=New-OpsGridProfileSnapshot $service $config
        # Discovery and snapshot must describe the same config, not a race winner.
        if((ConvertTo-OpsGridCanonicalConfig ([Text.Encoding]::UTF8.GetString($snapshot.ConfigBytes).TrimStart([char]0xFEFF))) -cne $managed.Canonical) { throw 'profile recognition drift' }
        $validator=Get-OpsGridAlloyValidationExecutable $service
        $failureCode=40
        $null=Invoke-AlloyValidate $validator $config $snapshot.Directory
        Assert-OpsGridProfileInvariants $snapshot -IncludeConfig -IncludeState
        if($managed.Kind -eq 'Target') { Write-OpsGridLog 'profile already applied; no changes made'; return }
        $stage=Join-Path $snapshot.Directory 'staged.config'
        # Never reopen an adjacent asset after recognition/old validation: only
        # the pinned, whole reviewed target with the preserved identity is staged.
        $stagedBytes=$managed.TargetConfigBytes
        $snapshot.ExpectedTargetBytes=$stagedBytes
        [IO.File]::WriteAllBytes($stage,$stagedBytes)
        $snapshot.OwnedConfigAcl=Set-OpsGridProfileStagingAcl $stage $snapshot.ConfigAcl
        $null=Invoke-AlloyValidate $validator $stage $snapshot.Directory
        # Lock held, recheck ancestry, bytes, security, startup and identity after
        # validator execution and immediately before same-volume atomic commit.
        Assert-OpsGridProfileInvariants $snapshot -IncludeConfig -IncludeState
        if(-not (Test-OpsGridProfileBytes $stage $stagedBytes)) { throw 'staged profile drift' }
        $commitAttempted=$true; $failureCode=50
        # File.Replace preserves destination DACL protection, not source protection.
        # Protect the destination with its ORIGINAL effective permissions before
        # replacement, under the existing strict lock/precommit ownership guards.
        Set-OpsGridProfileAcl $config $snapshot.OwnedConfigAcl
        Assert-OpsGridProfileInvariants $snapshot -IncludeConfig -IncludeState -AllowOwnedConfigAcl
        Invoke-OpsGridAtomicReplace $stage $config
        $mutated=$true
        if(-not (Test-OpsGridProfileBytes $config $stagedBytes)) { throw 'profile replacement verification failed' }
        Assert-OpsGridProfileInvariants $snapshot -AllowOwnedConfigAcl
        # Only at the real destination can original inheritance be reconstructed.
        # Finalize exact ACL BEFORE security assertion or any service activation.
        Set-OpsGridProfileAcl $config $snapshot.ConfigAcl
        Assert-OpsGridProfileInvariants $snapshot
        switch($snapshot.OriginalStatus) {
            'Running' { Restart-Service -Name $service.Name -Force -ErrorAction Stop; if(-not (Wait-OpsGridServiceState $service.Name 'Running')) { throw 'profile restart failed' } }
            'Paused' {
                Resume-Service -Name $service.Name -ErrorAction Stop
                if(-not (Wait-OpsGridServiceState $service.Name 'Running')) { throw 'profile resume failed' }
                Restart-Service -Name $service.Name -Force -ErrorAction Stop
                if(-not (Wait-OpsGridServiceState $service.Name 'Running')) { throw 'profile restart failed' }
                Set-OpsGridProfileServiceState $service 'Paused'
            }
            'Stopped' { }
        }
        Assert-OpsGridProfileInvariants $snapshot -IncludeState
        if(-not (Test-OpsGridProfileBytes $config $stagedBytes)) {
            # External activation-time edits are not ours to overwrite. Retain
            # the private baseline and report nonzero operator recovery instead.
            $mutated=$false; $keepSnapshot=$true
            Write-OpsGridLog 'profile activation config changed; operator recovery required; retain private original.config snapshot; do not reenroll'
            throw 'profile activation config drift'
        }
        Write-OpsGridLog 'profile applied; original service state preserved; remote delivery not verified'
    }
    catch {
        # A native replacement failure can occur after commit; inspect bytes before
        # deciding whether recovery is required, not just the call's return value.
        if($commitAttempted -and $null -ne $snapshot -and -not $keepSnapshot) {
            # Destination ACL protection is itself a mutation, even if native
            # replacement throws before changing bytes. Detect only exact known
            # byte states; missing/reparse/unreadable/unknown destinations retain
            # recovery evidence without repair or exposing native exception text.
            try {
                if(-not (Test-OpsGridSafeRegularFile $snapshot.ConfigPath)) { throw 'unsafe commit destination' }
                $hasOriginal=Test-OpsGridProfileBytes $snapshot.ConfigPath $snapshot.ConfigBytes
                if(-not $hasOriginal -and -not (Test-OpsGridProfileBytes $snapshot.ConfigPath $stagedBytes)) { throw 'unknown commit destination' }
                if(-not $hasOriginal -or (Get-Acl -LiteralPath $snapshot.ConfigPath -ErrorAction Stop).Sddl -cne $snapshot.ConfigAcl) { $mutated=$true }
            }
            catch { $keepSnapshot=$true; $failureCode=50; Write-OpsGridLog 'profile commit state unknown; operator recovery required; retain private original.config snapshot; do not reenroll' }
        }
        if($mutated -and -not $keepSnapshot) {
            try { Restore-OpsGridProfileTransaction $snapshot }
            catch { $keepSnapshot=$true; $failureCode=50; Write-OpsGridLog 'profile rollback failed; operator recovery required; retain private original.config snapshot; do not reenroll' }
        }
        $script:OpsGridExitCode=$failureCode
        Write-OpsGridLog 'profile transaction refused or failed; no enrollment performed'
    }
    finally {
        if($null -ne $snapshot) {
            try {
                $directory=[IO.Path]::GetFullPath($snapshot.Directory)
                if([IO.Path]::GetDirectoryName($directory) -cne $snapshot.Parent -or [IO.Path]::GetFileName($directory) -notlike '.opsgrid-profile-*' -or -not (Test-OpsGridSafeDirectory $directory)) { throw 'unsafe profile cleanup' }
                if($keepSnapshot) {
                    # Retain only original evidence, never staged replacements or
                    # disposable restore/validator material in a recovery bundle.
                    foreach($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
                        if($item.Name -cnotin @('original.config','original.config.acl.json')) { Remove-Item -LiteralPath $item.FullName -Force -Recurse -ErrorAction Stop }
                    }
                }
                else { Remove-Item -LiteralPath $directory -Force -Recurse -ErrorAction Stop }
            }
            catch { $script:OpsGridExitCode=50; Write-OpsGridLog 'private profile cleanup failed; operator recovery required' }
            finally {
                if($null -ne $snapshot.CredentialBytes) { [Array]::Clear($snapshot.CredentialBytes,0,$snapshot.CredentialBytes.Length); $snapshot.CredentialBytes=$null }
            }
        }
        if($locked) { Release-OpsGridLock }
        $env:PATH=$originalEnvironmentPath
    }
}
