# Keep raw arguments so malformed/unknown parameters are reported through the
# stable OpsGrid contract rather than PowerShell's unprefixed binder errors.
param()

# Dot-sourcing must not execute initialization or clobber caller variables.
if ($MyInvocation.InvocationName -eq '.') {
    return
}

$EnrollmentToken = ''
$ApiBaseUrl = 'https://api.opsgrid.hacmieu.com'
$Help = $false

$positionalIndex = 0
$seenEnrollmentToken = $false
$seenApiBaseUrl = $false
$rawArgumentList = @($args)
for ($argumentIndex = 0; $argumentIndex -lt $rawArgumentList.Count; $argumentIndex++) {
    $rawArgument = [string]$rawArgumentList[$argumentIndex]
    switch -Regex ($rawArgument) {
        '^(?i)-Help$' {
            if ($Help) { Write-Output '[opsgrid-agent] duplicate argument'; exit 10 }
            $Help = $true
            continue
        }
        '^(?i)-EnrollmentToken$' {
            if ($seenEnrollmentToken -or $argumentIndex + 1 -ge $rawArgumentList.Count -or [string]$rawArgumentList[$argumentIndex + 1] -match '^-' ) {
                Write-Output '[opsgrid-agent] invalid EnrollmentToken argument'
                exit 10
            }
            $EnrollmentToken = [string]$rawArgumentList[++$argumentIndex]
            $seenEnrollmentToken = $true
            continue
        }
        '^(?i)-ApiBaseUrl$' {
            if ($seenApiBaseUrl -or $argumentIndex + 1 -ge $rawArgumentList.Count -or [string]$rawArgumentList[$argumentIndex + 1] -match '^-' ) {
                Write-Output '[opsgrid-agent] invalid ApiBaseUrl argument'
                exit 10
            }
            $ApiBaseUrl = [string]$rawArgumentList[++$argumentIndex]
            $seenApiBaseUrl = $true
            continue
        }
        default {
            if ($rawArgument -match '^-' ) {
                Write-Output '[opsgrid-agent] unknown argument'
                exit 10
            }
            if ($positionalIndex -eq 0 -and -not $seenEnrollmentToken) {
                $EnrollmentToken = $rawArgument
                $seenEnrollmentToken = $true
            }
            elseif ($positionalIndex -eq 1 -and -not $seenApiBaseUrl) {
                $ApiBaseUrl = $rawArgument
                $seenApiBaseUrl = $true
            }
            else {
                Write-Output '[opsgrid-agent] too many positional arguments'
                exit 10
            }
            $positionalIndex++
        }
    }
}

if ($seenEnrollmentToken -and $null -ne $EnrollmentToken -and ([string]$EnrollmentToken).Trim().Length -eq 0) {
    Write-Output '[opsgrid-agent] empty EnrollmentToken argument'
    exit 10
}

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Task 5 established the Windows preflight, locking, and safe Alloy discovery
# contract. Task 6 extends that contract with official installation, enrollment,
# protected credential/config persistence, rollback, and service health control.
$script:ApiBaseUrlDefault = 'https://api.opsgrid.hacmieu.com'
$script:GatewayUrlDefault = 'https://opsgrid-ingest.bravecliff-c4215c1b.southeastasia.azurecontainerapps.io/api/v1/write'
$script:CredentialFilePlaceholder = '__CREDENTIAL_FILE__'
$script:OutputPrefix = '[opsgrid-agent]'

$script:AgentCredentialFile = 'C:\ProgramData\OpsGrid\agent.credential'
$script:AlloyConfigDirectory = 'C:\ProgramData\OpsGrid\Alloy\'
$script:InstallLockFile = 'C:\ProgramData\OpsGrid\install.lock'
$script:InstallRoot = 'C:\ProgramData\OpsGrid'

$script:OpsGridLockStream = $null
$script:OpsGridFailureCode = 0
$script:OpsGridFailureMessage = ''
$script:OpsGridFailureMarker = '__OPSGRID_FAILURE__'
$script:OpsGridStage = 'preflight'
$script:OpsGridExitCode = 0
$script:AlloyInstallerUrl = 'https://github.com/grafana/alloy/releases/latest/download/alloy-installer-windows-amd64.exe'
$script:AlloyInstallDirectory = 'C:\Program Files\GrafanaLabs\Alloy'
$script:AlloyExecutablePath = 'C:\Program Files\GrafanaLabs\Alloy\alloy.exe'
$script:AlloyFreshConfigPath = 'C:\ProgramData\OpsGrid\Alloy\config.alloy'
$script:AlloyCredentialConfigPath = 'C:/ProgramData/OpsGrid/agent.credential'
$script:OpsGridTempPaths = New-Object System.Collections.Generic.List[string]
$script:OpsGridTransactionState = $null
$script:AlloyCommonDataParentPath = $null
$script:AlloyCommonDataParentExistedBeforeRun = $true
$script:AlloyCommonDataParentIdentity = $null
$script:AlloyUserArtifactRunStartedUtc = [DateTime]::UtcNow
$script:AlloyUserArtifactIdentities = @{}

function ConvertTo-OpsGridSafeText {
    param(
        [AllowNull()]
        [string]$Value,
        [int]$MaximumLength = 1024
    )

    if ($null -eq $Value) {
        return ''
    }

    $safeValue = [regex]::Replace($Value, '[\x00-\x1F\x7F]', ' ').Trim()
    if ($MaximumLength -gt 0 -and $safeValue.Length -gt $MaximumLength) {
        return $safeValue.Substring(0, $MaximumLength)
    }

    return $safeValue
}

function Write-OpsGridLog([string]$Message) {
    $safeMessage = ConvertTo-OpsGridSafeText -Value $Message -MaximumLength 1024
    if ([string]::IsNullOrWhiteSpace($safeMessage)) {
        $safeMessage = 'operation failed'
    }

    Write-Output ('{0} {1}' -f $script:OutputPrefix, $safeMessage)
}

function Fail-OpsGrid([int]$Code, [string]$Message) {
    $validCodes = @(10, 20, 30, 40, 50)
    if ($validCodes -notcontains $Code) {
        $Code = 10
    }

    $script:OpsGridFailureCode = $Code
    $script:OpsGridFailureMessage = ConvertTo-OpsGridSafeText -Value $Message -MaximumLength 256
    throw $script:OpsGridFailureMarker
}

function Show-Usage {
    Write-OpsGridLog 'Usage: install.ps1 [-EnrollmentToken TOKEN] [-ApiBaseUrl URL] [-Help]'
    Write-OpsGridLog '  -EnrollmentToken TOKEN  Enrollment token input (prompted when omitted)'
    Write-OpsGridLog '  -ApiBaseUrl URL         API base URL (default: https://api.cloudops.example.com)'
    Write-OpsGridLog '  -Help                   Show this help text'
}

function Test-ApiBaseUrl([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) {
        Fail-OpsGrid 10 'invalid API base URL'
    }

    if ($Value -ne $Value.Trim() -or $Value -match '[\x00-\x1F\x7F]') {
        Fail-OpsGrid 10 'invalid API base URL'
    }

    # Reject an explicit empty port before Uri normalizes `host:/` to the
    # default port. Cover both DNS/IPv4 and bracketed IPv6 authorities.
    if ($Value -match '^[^:/?#]+://(?:[^/?#]*@)?(?:\[[^\]]+\]|[^/?#:\s]+):(?=[/?#]|$)') {
        Fail-OpsGrid 10 'invalid API base URL port'
    }

    $uri = $null
    $isAbsolute = $false
    try {
        $isAbsolute = [System.Uri]::TryCreate(
            $Value,
            [System.UriKind]::Absolute,
            [ref]$uri
        )
    }
    catch {
        Fail-OpsGrid 10 'invalid API base URL'
    }

    if (-not $isAbsolute -or $null -eq $uri -or [string]::IsNullOrWhiteSpace($uri.Host)) {
        Fail-OpsGrid 10 'invalid API base URL'
    }

    # Do not permit credentials, including the empty-user-info form https://@host.
    if (-not [string]::IsNullOrEmpty($uri.UserInfo) -or $Value -match '^[^:/?#]+://[^/?#]*@') {
        Fail-OpsGrid 10 'API base URL credentials are not allowed'
    }

    if ($Value.IndexOf('#') -ge 0 -or -not [string]::IsNullOrEmpty($uri.Fragment)) {
        Fail-OpsGrid 10 'API base URL fragments are not allowed'
    }

    # API base URLs are origins only. Uri.AbsolutePath is '/' when no path was
    # supplied, so retain that representation but reject every other path. A
    # query delimiter is rejected even when its value is empty.
    if (($uri.AbsolutePath -ne '/') -or
        $Value -match '/$' -or
        $Value.IndexOf('?') -ge 0 -or
        -not [string]::IsNullOrEmpty($uri.Query)) {
        Fail-OpsGrid 10 'API base URL must be an origin without a path or query'
    }

    # Uri.Port is -1 when the scheme's default port is used. Explicit ports must
    # be in the TCP range and zero is never valid.
    if ($uri.Port -ne -1 -and ($uri.Port -lt 1 -or $uri.Port -gt 65535)) {
        Fail-OpsGrid 10 'invalid API base URL port'
    }

    $scheme = $uri.Scheme.ToLowerInvariant()
    if ($scheme -eq 'https') {
        return $uri
    }

    $hostName = $uri.Host.Trim('[', ']').ToLowerInvariant()
    if ($hostName -ne 'localhost') {
        try {
            $hostName = [System.Net.IPAddress]::Parse($hostName).ToString().ToLowerInvariant()
        }
        catch {
            # Non-IP host names are compared literally below.
        }
    }
    $isLoopbackHttp = $scheme -eq 'http' -and @('localhost', '127.0.0.1', '::1') -contains $hostName
    if (-not $isLoopbackHttp) {
        Fail-OpsGrid 10 'API base URL must use HTTPS; HTTP is limited to loopback'
    }

    return $uri
}

function Test-OpsGridWindows {
    return [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
}

function Set-OpsGridSafePath {
    $safeDirectories = New-Object System.Collections.Generic.List[string]
    $systemDirectory = [System.Environment]::SystemDirectory
    $windowsPowerShellDirectory = Join-Path -Path $systemDirectory -ChildPath 'WindowsPowerShell\v1.0'
    $candidates = @(
        $systemDirectory,
        (Join-Path -Path $systemDirectory -ChildPath 'Wbem'),
        $windowsPowerShellDirectory,
        $PSHOME,
        (Join-Path -Path $PSHOME -ChildPath 'Modules')
    )

    foreach ($candidate in $candidates) {
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and
            [System.IO.Directory]::Exists($candidate) -and
            -not $safeDirectories.Contains($candidate)) {
            $null = $safeDirectories.Add($candidate)
        }
    }

    if ($safeDirectories.Count -eq 0) {
        Fail-OpsGrid 10 'safe system PATH is unavailable'
    }

    # Do not trust a caller-controlled PATH for required commands or icacls.
    $env:PATH = [string]::Join(';', [string[]]$safeDirectories.ToArray())
}

function Test-OpsGridPreflight {
    $script:OpsGridStage = 'preflight'

    if (-not (Test-OpsGridWindows)) {
        Fail-OpsGrid 10 'Windows is required'
    }

    Set-OpsGridSafePath

    try {
        $psVersion = [version]$PSVersionTable.PSVersion
        if ($psVersion -lt [version]'5.1') {
            Fail-OpsGrid 10 'PowerShell 5.1 or newer is required'
        }

        $parserMethod = [System.Management.Automation.Language.Parser].GetMethod(
            'ParseFile',
            [System.Reflection.BindingFlags]::Public -bor [System.Reflection.BindingFlags]::Static
        )
        if ($null -eq $parserMethod) {
            Fail-OpsGrid 10 'PowerShell parser runtime is unavailable'
        }

        $windowsIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $windowsPrincipal = New-Object System.Security.Principal.WindowsPrincipal($windowsIdentity)
        $isAdministrator = $windowsPrincipal.IsInRole(
            [System.Security.Principal.WindowsBuiltInRole]::Administrator
        )
    }
    catch {
        if ($script:OpsGridFailureCode -eq 10 -and $_.Exception.Message -eq $script:OpsGridFailureMarker) {
            throw
        }

        Fail-OpsGrid 10 'Administrator or PowerShell runtime preflight failed'
    }

    if (-not $isAdministrator) {
        Fail-OpsGrid 10 'Administrator privileges are required'
    }

    $requiredCommands = @(
        'Invoke-WebRequest',
        'Invoke-RestMethod',
        'ConvertFrom-Json',
        'Get-CimInstance',
        'Get-AuthenticodeSignature',
        'icacls',
        'Get-Service',
        'Start-Service',
        'Stop-Service',
        'Restart-Service',
        'Resume-Service',
        'Suspend-Service',
        'Set-Service',
        'Start-Process'
    )

    foreach ($commandName in $requiredCommands) {
        $command = Get-Command -Name $commandName -ErrorAction SilentlyContinue
        if ($null -eq $command) {
            Fail-OpsGrid 10 ('required command unavailable: {0}' -f $commandName)
        }
    }
}

function Read-EnrollmentToken() {
    $secureToken = $null
    $temporaryBstr = [System.IntPtr]::Zero
    $tokenValue = $null

    try {
        $secureToken = Read-Host -Prompt ('{0} Enrollment token' -f $script:OutputPrefix) -AsSecureString
        if ($null -eq $secureToken) {
            Fail-OpsGrid 10 'enrollment token is required'
        }

        $temporaryBstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
        $tokenValue = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($temporaryBstr)
        if ([string]::IsNullOrWhiteSpace($tokenValue)) {
            Fail-OpsGrid 10 'enrollment token is required'
        }

        return $tokenValue
    }
    finally {
        if ($temporaryBstr -ne [System.IntPtr]::Zero) {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($temporaryBstr)
            $temporaryBstr = [System.IntPtr]::Zero
        }

        if ($null -ne $secureToken) {
            $secureToken.Dispose()
            $secureToken = $null
        }

        $tokenValue = $null
    }
}

function Get-WindowsPlatform() {
    try {
        $processors = @(Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop)
        if ($processors.Count -eq 0) {
            Fail-OpsGrid 10 'unsupported platform: processor architecture is unavailable'
        }

        $architectures = @(
            $processors | ForEach-Object {
                if ($null -eq $_.Architecture) {
                    -1
                }
                else {
                    [int]$_.Architecture
                }
            }
        )
        if ($architectures.Count -eq 0 -or @($architectures | Where-Object { $_ -ne 9 }).Count -gt 0) {
            Fail-OpsGrid 10 'unsupported platform: x64 Windows is required'
        }

        $operatingSystems = @(Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop)
        if ($operatingSystems.Count -eq 0) {
            Fail-OpsGrid 10 'Windows operating-system metadata is unavailable'
        }

        $operatingSystem = $operatingSystems[0]
        $caption = ConvertTo-OpsGridSafeText -Value ([string]$operatingSystem.Caption) -MaximumLength 128
        $version = ConvertTo-OpsGridSafeText -Value ([string]$operatingSystem.Version) -MaximumLength 128
        $osMetadata = ConvertTo-OpsGridSafeText -Value (('{0} {1}' -f $caption, $version)) -MaximumLength 128
        if ([string]::IsNullOrWhiteSpace($osMetadata)) {
            Fail-OpsGrid 10 'Windows operating-system metadata is unavailable'
        }

        return [pscustomobject]@{
            Architecture = 9
            Caption      = $caption
            Version      = $version
            Os           = $osMetadata
        }
    }
    catch {
        if ($script:OpsGridFailureCode -eq 10 -and $_.Exception.Message -eq $script:OpsGridFailureMarker) {
            throw
        }

        Fail-OpsGrid 10 'Windows platform detection failed'
    }
}

function Set-OpsGridDirectoryAcl([string]$Path, $ServiceIdentity = $null) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [System.IO.Directory]::Exists($Path)) {
        throw 'directory is unavailable'
    }

    $directoryInfo = New-Object System.IO.DirectoryInfo($Path)
    if (($directoryInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'directory is a reparse point'
    }

    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)

    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
    $readExecute = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute
    $systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
    $administratorsSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')

    $acl.SetOwner($administratorsSid)
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        $systemSid,
        $fullControl,
        $inheritance,
        $propagation,
        $allow
    ))
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        $administratorsSid,
        $fullControl,
        $inheritance,
        $propagation,
        $allow
    ))

    if ($null -ne $ServiceIdentity -and $null -ne $ServiceIdentity.Sid) {
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
            $ServiceIdentity.Sid,
            $readExecute,
            $inheritance,
            $propagation,
            $allow
        ))
    }

    [System.IO.Directory]::SetAccessControl($Path, $acl)
}

function Set-OpsGridFileAcl([string]$Path, $ServiceIdentity = $null) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [System.IO.File]::Exists($Path)) {
        throw 'file is unavailable'
    }

    $fileInfo = New-Object System.IO.FileInfo($Path)
    if (($fileInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'file is a reparse point'
    }

    $acl = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)

    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
    $read = [System.Security.AccessControl.FileSystemRights]::Read
    $systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
    $administratorsSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')

    $acl.SetOwner($administratorsSid)
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        $systemSid,
        $fullControl,
        $allow
    ))
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        $administratorsSid,
        $fullControl,
        $allow
    ))
    if ($null -ne $ServiceIdentity -and $null -ne $ServiceIdentity.Sid) {
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
            $ServiceIdentity.Sid,
            $read,
            $allow
        ))
    }

    [System.IO.File]::SetAccessControl($Path, $acl)
}

function Clear-OpsGridStaleLockMetadata($Stream) {
    if ($null -eq $Stream) {
        return
    }

    # A stale lock file is not removed. Once FileShare.None has been acquired,
    # replacing old PID/timestamp metadata is safe and cannot touch an active
    # installer's lock holder.
    if ($Stream.Length -gt 0) {
        $Stream.SetLength(0)
    }
}

function Acquire-OpsGridLock() {
    $lockRoot = $script:InstallRoot
    $lockFile = $script:InstallLockFile
    $lockStream = $null
    $probeStream = $null

    try {
        if ([System.IO.Directory]::Exists($lockRoot)) {
            $rootInfo = New-Object System.IO.DirectoryInfo($lockRoot)
            if (($rootInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                Fail-OpsGrid 20 'OpsGrid lock directory is a reparse point'
            }
        }
        else {
            [System.IO.Directory]::CreateDirectory($lockRoot) | Out-Null
        }

        # Apply a fresh DACL and Administrators owner on every invocation; this
        # also repairs an existing directory without touching service state.
        Set-OpsGridDirectoryAcl -Path $lockRoot

        if ([System.IO.File]::Exists($lockFile)) {
            $lockInfo = New-Object System.IO.FileInfo($lockFile)
            if (($lockInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                Fail-OpsGrid 20 'OpsGrid lock file is a reparse point'
            }
        }

        # Ensure the file exists before applying its restrictive DACL. A later
        # FileShare.None open is the authoritative concurrency boundary.
        $probeStream = [System.IO.File]::Open(
            $lockFile,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::ReadWrite
        )
        $probeStream.Dispose()
        $probeStream = $null
        Set-OpsGridFileAcl -Path $lockFile

        $lockStream = [System.IO.File]::Open(
            $lockFile,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )

        Clear-OpsGridStaleLockMetadata -Stream $lockStream
        $metadata = 'pid={0};startedUtc={1:u}' -f $PID, (Get-Date).ToUniversalTime()
        $metadataBytes = [System.Text.Encoding]::UTF8.GetBytes($metadata)
        $lockStream.Write($metadataBytes, 0, $metadataBytes.Length)
        $lockStream.Flush()

        $script:OpsGridLockStream = $lockStream
        $lockStream = $null
        return $script:OpsGridLockStream
    }
    catch {
        if ($null -ne $probeStream) {
            try { $probeStream.Dispose() } catch { }
            $probeStream = $null
        }
        if ($null -ne $lockStream) {
            try { $lockStream.Dispose() } catch { }
            $lockStream = $null
        }
        if ($null -ne $script:OpsGridLockStream) {
            try { $script:OpsGridLockStream.Dispose() } catch { }
            $script:OpsGridLockStream = $null
        }

        if ($script:OpsGridFailureCode -eq 20 -and $_.Exception.Message -eq $script:OpsGridFailureMarker) {
            throw
        }

        # Never remove a lock path after a sharing/ACL failure: another process
        # may own it, and the persistent file itself is safe stale state.
        Fail-OpsGrid 20 'could not acquire the OpsGrid installation lock'
    }
}

function Release-OpsGridLock {
    $stream = $script:OpsGridLockStream
    $script:OpsGridLockStream = $null
    if ($null -ne $stream) {
        try {
            $stream.Dispose()
        }
        catch {
            # Cleanup must not replace the original stable exit code.
        }
    }
}

function Get-AlloyExecutablePath([string]$PathName) {
    if ([string]::IsNullOrWhiteSpace($PathName)) {
        return $null
    }

    $quotedMatch = [regex]::Match(
        $PathName,
        '^\s*"(?<path>[^"\r\n]+?\\(?:alloy|alloy-service-windows-amd64)\.exe)"(?:\s|$)',
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
    if ($quotedMatch.Success) {
        return $quotedMatch.Groups['path'].Value
    }

    $unquotedMatch = [regex]::Match(
        $PathName,
        '^\s*(?<path>[A-Za-z]:\\[^"\r\n]*?\\(?:alloy|alloy-service-windows-amd64)\.exe)(?:\s|$)',
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
    if ($unquotedMatch.Success) {
        return $unquotedMatch.Groups['path'].Value
    }

    return $null
}

function Test-OpsGridSafeRegularFile([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [System.IO.File]::Exists($Path)) {
        return $false
    }
    try {
        $fileInfo = New-Object System.IO.FileInfo($Path)
        if (($fileInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
        $current = $fileInfo.Directory
        while ($null -ne $current) {
            if (($current.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
            $parent = $current.Parent
            if ($null -eq $parent -or [string]::Equals($parent.FullName, $current.FullName, [System.StringComparison]::OrdinalIgnoreCase)) { break }
            $current = $parent
        }
        return $true
    }
    catch { return $false }
}

function Test-AlloyOfficialPath([string]$ExecutablePath) {
    if ([string]::IsNullOrWhiteSpace($ExecutablePath)) {
        return $false
    }

    $normalizedPath = ($ExecutablePath -replace '/', '\').Trim()
    $fileName = [System.IO.Path]::GetFileName($normalizedPath)
    if (-not [System.IO.Path]::IsPathRooted($normalizedPath) -or
        (-not [string]::Equals($fileName, 'alloy.exe', [System.StringComparison]::OrdinalIgnoreCase) -and
         -not [string]::Equals($fileName, 'alloy-service-windows-amd64.exe', [System.StringComparison]::OrdinalIgnoreCase))) {
        return $false
    }

    # Keep this pattern in lockstep with Get-AlloyKnownBinaryPaths: only the
    # explicitly approved Grafana installation layouts are official binaries.
    if ($normalizedPath -notmatch '(?i)^[A-Za-z]:\\Program Files\\(?:Grafana Labs\\Alloy|GrafanaLabs\\Alloy|Grafana Alloy)\\(?:alloy|alloy-service-windows-amd64)\.exe$' -or
        -not (Test-OpsGridSafeRegularFile -Path $normalizedPath)) {
        return $false
    }
    try {
        $signature = Get-AuthenticodeSignature -FilePath $normalizedPath -ErrorAction Stop
        if ($null -eq $signature -or [string]$signature.Status -ne 'Valid') { return $false }
        if ($null -eq $signature.SignerCertificate -or [string]$signature.SignerCertificate.Subject -notmatch '(?i)Grafana') { return $false }
    }
    catch { return $false }
    return $true
}

function Get-AlloyKnownBinaryPaths {
    $paths = @(
        'C:\Program Files\Grafana Labs\Alloy\alloy.exe',
        'C:\Program Files\GrafanaLabs\Alloy\alloy.exe',
        'C:\Program Files\Grafana Alloy\alloy.exe',
        'C:\Program Files\Grafana Labs\Alloy\alloy-service-windows-amd64.exe',
        'C:\Program Files\GrafanaLabs\Alloy\alloy-service-windows-amd64.exe',
        'C:\Program Files\Grafana Alloy\alloy-service-windows-amd64.exe'
    )
    $programFiles = [System.Environment]::GetEnvironmentVariable('ProgramW6432')
    if ([string]::IsNullOrWhiteSpace($programFiles)) {
        $programFiles = [System.Environment]::GetEnvironmentVariable('ProgramFiles')
    }
    if (-not [string]::IsNullOrWhiteSpace($programFiles)) {
        $paths += (Join-Path -Path $programFiles -ChildPath 'Grafana Labs\Alloy\alloy.exe')
        $paths += (Join-Path -Path $programFiles -ChildPath 'GrafanaLabs\Alloy\alloy.exe')
        $paths += (Join-Path -Path $programFiles -ChildPath 'Grafana Alloy\alloy.exe')
        $paths += (Join-Path -Path $programFiles -ChildPath 'Grafana Labs\Alloy\alloy-service-windows-amd64.exe')
        $paths += (Join-Path -Path $programFiles -ChildPath 'GrafanaLabs\Alloy\alloy-service-windows-amd64.exe')
        $paths += (Join-Path -Path $programFiles -ChildPath 'Grafana Alloy\alloy-service-windows-amd64.exe')
    }

    return @($paths | Select-Object -Unique)
}

function Get-AlloyService() {
    $cimServices = $null
    $serviceMetadata = $null

    try {
        $cimServices = @(Get-CimInstance -ClassName Win32_Service -ErrorAction Stop)
        $serviceMetadata = @(Get-Service -ErrorAction Stop)
    }
    catch {
        Fail-OpsGrid 20 'unable to inspect Windows services'
    }

    $officialCandidates = @()
    $binaryCandidates = New-Object System.Collections.Generic.List[string]

    foreach ($knownPath in (Get-AlloyKnownBinaryPaths)) {
        if (Test-AlloyOfficialPath -ExecutablePath $knownPath) {
            $null = $binaryCandidates.Add($knownPath)
        }
    }

    foreach ($cimService in $cimServices) {
        $serviceName = [string]$cimService.Name
        $displayName = [string]$cimService.DisplayName
        $pathName = [string]$cimService.PathName
        $executablePath = Get-AlloyExecutablePath -PathName $pathName
        $executableName = [System.IO.Path]::GetFileName(($executablePath -replace '/', '\'))
         $isAlloyExecutable = -not [string]::IsNullOrWhiteSpace($executablePath) -and
            [string]::Equals(
                [System.IO.Path]::GetFileName(($executablePath -replace '/', '\')),
                'alloy.exe',
                [System.StringComparison]::OrdinalIgnoreCase
            )

        if ($executableName -ieq 'alloy-service-windows-amd64.exe') { $isAlloyExecutable = $true }
         if ($isAlloyExecutable -and (Test-OpsGridSafeRegularFile -Path $executablePath)) {
            if (-not $binaryCandidates.Contains($executablePath)) {
                $null = $binaryCandidates.Add($executablePath)
            }
        }

        $nameLooksOfficial =
            [string]::Equals($serviceName, 'alloy', [System.StringComparison]::OrdinalIgnoreCase) -or
            [string]::Equals($serviceName, 'grafana-alloy', [System.StringComparison]::OrdinalIgnoreCase) -or
            $displayName -match '(?i)^(?:Grafana(?: Labs)? Alloy|Alloy)$'
        if (-not $nameLooksOfficial) {
            continue
        }

        $metadataMatch = @(
            $serviceMetadata | Where-Object {
                [string]::Equals([string]$_.Name, $serviceName, [System.StringComparison]::OrdinalIgnoreCase)
            }
        )
        if ($metadataMatch.Count -ne 1) {
            Fail-OpsGrid 20 'official Alloy service metadata is not unique'
        }

        $officialBinaryPath = $isAlloyExecutable -and (Test-AlloyOfficialPath -ExecutablePath $executablePath)
        $binaryExists = $isAlloyExecutable -and (Test-OpsGridSafeRegularFile -Path $executablePath)
        $officialCandidates += [pscustomobject]@{
            Name               = $serviceName
            DisplayName        = $displayName
            PathName           = $pathName
            StartName          = [string]$cimService.StartName
            State              = [string]$cimService.State
            CimService         = $cimService
            Service            = $metadataMatch[0]
            ExecutablePath     = $executablePath
            BinaryExists       = $binaryExists
            OfficialBinaryPath = if ($officialBinaryPath) { $executablePath } else { $null }
        }
    }

    if ($officialCandidates.Count -gt 1) {
        Fail-OpsGrid 20 'multiple official Alloy services were found'
    }

    $officialCandidate = $null
    if ($officialCandidates.Count -eq 1) {
        $officialCandidate = $officialCandidates[0]
    }

    if ($null -ne $officialCandidate) {
        $reusable = $officialCandidate.BinaryExists -and $officialCandidate.OfficialBinaryPath
        if (-not $reusable) {
            Fail-OpsGrid 20 'partial Alloy state: official service exists without a reusable binary'
        }

        $officialCandidate | Add-Member -NotePropertyName Classification -NotePropertyValue 'Reusable'
        $officialCandidate | Add-Member -NotePropertyName Reusable -NotePropertyValue $true
        return $officialCandidate
    }

    if ($binaryCandidates.Count -gt 0) {
        Fail-OpsGrid 20 'partial Alloy state: Alloy binary exists without an official service'
    }

    return $null
}

function Get-AlloyKnownConfigPaths {
    $paths = New-Object System.Collections.Generic.List[string]
    $pathCandidates = @(
        # The first layout is Grafana's documented Windows default. The other
        # explicit layouts stay aligned with the approved binary allow-list.
        'C:\Program Files\GrafanaLabs\Alloy\config.alloy',
        'C:\Program Files\Grafana Labs\Alloy\config.alloy',
        'C:\Program Files\Grafana Alloy\config.alloy',
        'C:\ProgramData\GrafanaLabs\Alloy\config.alloy',
        'C:\ProgramData\Grafana Labs\Alloy\config.alloy',
        'C:\ProgramData\Grafana Alloy\config.alloy',
        (Join-Path -Path $script:AlloyConfigDirectory -ChildPath 'config.alloy')
    )

    $programFiles = [System.Environment]::GetEnvironmentVariable('ProgramW6432')
    if ([string]::IsNullOrWhiteSpace($programFiles)) {
        $programFiles = [System.Environment]::GetEnvironmentVariable('ProgramFiles')
    }
    if (-not [string]::IsNullOrWhiteSpace($programFiles)) {
        $pathCandidates += (Join-Path -Path $programFiles -ChildPath 'GrafanaLabs\Alloy\config.alloy')
        $pathCandidates += (Join-Path -Path $programFiles -ChildPath 'Grafana Labs\Alloy\config.alloy')
        $pathCandidates += (Join-Path -Path $programFiles -ChildPath 'Grafana Alloy\config.alloy')
    }

    foreach ($candidate in $pathCandidates) {
        if (-not [string]::IsNullOrWhiteSpace([string]$candidate)) {
            $null = $paths.Add((([string]$candidate) -replace '/', '\'))
        }
    }

    return @($paths | Select-Object -Unique)
}

function Test-AlloyConfigPath([string]$ConfigPath) {
    if ([string]::IsNullOrWhiteSpace($ConfigPath) -or $ConfigPath -ne $ConfigPath.Trim()) {
        return $false
    }

    if ($ConfigPath -match '[\x00-\x1F\x7F''"`$;|&<>^!*\?\[\]\(\)%]') {
        return $false
    }

    $normalizedPath = $ConfigPath -replace '/', '\'
    if (-not [System.IO.Path]::IsPathRooted($normalizedPath) -or
        $normalizedPath -notmatch '^[A-Za-z]:\\' -or
        $normalizedPath -match '^\\\\' -or
        $normalizedPath -match '\\{2,}' -or
        $normalizedPath -match '(?i)(?:^|\\)\.{1,2}(?:\\|$)' -or
        $normalizedPath.Substring(2) -match ':') {
        return $false
    }

    $canonicalPath = $null
    try {
        $canonicalPath = [System.IO.Path]::GetFullPath($normalizedPath)
    }
    catch {
        return $false
    }
    if (-not [string]::Equals(
            $canonicalPath,
            $normalizedPath,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        return $false
    }

    # Reuse a safely discovered custom config filename under an approved Alloy
    # root; do not require the basename to be one of our fresh-install names.
    $approvedRoot = $false
    foreach ($knownPath in @(Get-AlloyKnownConfigPaths)) {
        $root = [System.IO.Path]::GetDirectoryName(([string]$knownPath -replace '/', '\'))
        if (-not [string]::IsNullOrWhiteSpace($root)) {
            $root = $root.TrimEnd('\') + '\'
            if ($normalizedPath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
                $approvedRoot = $true
                break
            }
        }
    }
    if (-not $approvedRoot) {
        return $false
    }

    try {
        # A config may be absent for a reusable service because Task 6 may
        # create it, but an existing target must be a regular non-reparse file.
        $targetIsFile = [System.IO.File]::Exists($normalizedPath)
        $targetIsDirectory = [System.IO.Directory]::Exists($normalizedPath)
        if ($targetIsDirectory) {
            return $false
        }
        if ($targetIsFile) {
            $fileInfo = New-Object System.IO.FileInfo($normalizedPath)
            if (-not $fileInfo.Exists -or
                ($fileInfo.Attributes -band [System.IO.FileAttributes]::Directory) -ne 0 -or
                ($fileInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                return $false
            }
        }

        # Check every existing parent so an approved lexical path cannot be
        # redirected through a junction/symlink before Task 6 writes it.
        $directoryName = [System.IO.Path]::GetDirectoryName($normalizedPath)
        $currentDirectory = New-Object System.IO.DirectoryInfo($directoryName)
        while ($null -ne $currentDirectory) {
            $currentDirectoryPath = [string]$currentDirectory.FullName
            if ([System.IO.File]::Exists($currentDirectoryPath)) {
                return $false
            }
            if ([System.IO.Directory]::Exists($currentDirectoryPath)) {
                $directoryInfo = New-Object System.IO.DirectoryInfo($currentDirectoryPath)
                if (($directoryInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                    return $false
                }
            }

            $parentDirectory = $currentDirectory.Parent
            if ($null -eq $parentDirectory -or
                [string]::Equals(
                    [string]$parentDirectory.FullName,
                    $currentDirectoryPath,
                    [System.StringComparison]::OrdinalIgnoreCase
                )) {
                break
            }
            $currentDirectory = $parentDirectory
        }
    }
    catch {
        return $false
    }

    return $true
}

function Get-OpsGridPropertyValue($Object, [string]$Name) {
    if ($null -eq $Object -or [string]::IsNullOrWhiteSpace($Name)) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Get-OpsGridCommandLineTokens([string]$CommandLine) {
    $tokens = New-Object System.Collections.Generic.List[string]
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return @() }
    foreach ($match in [regex]::Matches($CommandLine, '(?:"(?<quoted>[^"\r\n]*)"|(?<bare>[^\s]+))')) {
        if ($match.Groups['quoted'].Success) { $null = $tokens.Add($match.Groups['quoted'].Value) }
        else { $null = $tokens.Add($match.Groups['bare'].Value) }
    }
    return @($tokens.ToArray())
}

function Get-OpsGridConfigArguments([string[]]$Arguments) {
    $candidates = New-Object System.Collections.Generic.List[string]
    $unsafe = $false
    if ($null -eq $Arguments) { return [pscustomobject]@{ Candidates = @(); Unsafe = $false } }
    for ($index = 0; $index -lt $Arguments.Count; $index++) {
        $argument = [string]$Arguments[$index]
        if ([string]::IsNullOrWhiteSpace($argument)) { continue }
        $inline = [regex]::Match($argument, '(?i)^-{1,2}config(?:\.file)?=(?<path>.+)$')
        if ($inline.Success) { $null = $candidates.Add($inline.Groups['path'].Value); continue }
        if ($argument -match '(?i)^-{1,2}config(?:\.file)?$') {
            if ($index + 1 -ge $Arguments.Count -or [string]::IsNullOrWhiteSpace([string]$Arguments[$index + 1])) { $unsafe = $true; continue }
            $null = $candidates.Add([string]$Arguments[$index + 1]); $index++; continue
        }
        if ([string]::Equals($argument, 'run', [System.StringComparison]::OrdinalIgnoreCase)) {
            if ($index + 1 -ge $Arguments.Count -or [string]::IsNullOrWhiteSpace([string]$Arguments[$index + 1]) -or [string]$Arguments[$index + 1] -match '^(?:--|-)$') { $unsafe = $true; continue }
            $null = $candidates.Add([string]$Arguments[$index + 1]); $index++
        }
    }
    return [pscustomobject]@{ Candidates = @($candidates.ToArray()); Unsafe = $unsafe }
}

# Extend the Task 5 parser with Alloy's documented run positional argument
# and HKLM registry Arguments metadata. Every candidate still passes
# the existing lexical and reparse-point checks in Test-AlloyConfigPath.
function Get-AlloyConfigPath($Service) {
    if ($null -eq $Service) { return $null }
    $candidatePaths = New-Object System.Collections.Generic.List[string]
    $unsafe = $false
    $pathName = [string](Get-OpsGridPropertyValue $Service 'PathName')
    if (-not [string]::IsNullOrWhiteSpace($pathName)) {
        $parsed = Get-OpsGridConfigArguments @(Get-OpsGridCommandLineTokens $pathName)
        $unsafe = [bool]$parsed.Unsafe
        foreach ($path in @($parsed.Candidates)) { if (-not [string]::IsNullOrWhiteSpace([string]$path)) { $null = $candidatePaths.Add([string]$path) } }
    }
    $registryArguments = Get-OpsGridPropertyValue $Service 'RegistryArguments'
    if ($null -eq $registryArguments) { $registryArguments = Get-OpsGridPropertyValue $Service 'Arguments' }
    if ($null -eq $registryArguments) {
        try {
            $registryKey = Get-ItemProperty -LiteralPath 'HKLM:\Software\GrafanaLabs\Alloy' -Name 'Arguments' -ErrorAction Stop
            $registryArguments = Get-OpsGridPropertyValue $registryKey 'Arguments'
        } catch { $registryArguments = $null }
    }
    if ($null -ne $registryArguments) {
        $values = @($registryArguments)
        $tokens = New-Object System.Collections.Generic.List[string]
        if ($values.Count -gt 1) { foreach ($value in $values) { $null = $tokens.Add([string]$value) } }
        elseif ($values.Count -eq 1) { foreach ($token in @(Get-OpsGridCommandLineTokens ([string]$values[0]))) { $null = $tokens.Add([string]$token) } }
        $parsedRegistry = Get-OpsGridConfigArguments @($tokens.ToArray())
        $unsafe = $unsafe -or [bool]$parsedRegistry.Unsafe
        foreach ($path in @($parsedRegistry.Candidates)) { if (-not [string]::IsNullOrWhiteSpace([string]$path)) { $null = $candidatePaths.Add([string]$path) } }
    }
    if ($unsafe) { return $null }
    $unique = New-Object System.Collections.Generic.List[string]
    foreach ($candidate in @($candidatePaths.ToArray())) {
        $normalized = ([string]$candidate).Trim().Trim('"') -replace '/', '\'
        if ([string]::IsNullOrWhiteSpace($normalized)) { return $null }
        if (-not $unique.Contains($normalized)) { $unique.Add($normalized) }
    }
    if ($unique.Count -ne 1) { return $null }
    $configPath = [string]$unique[0]
    if (-not (Test-AlloyConfigPath $configPath)) { return $null }
    foreach ($known in @(Get-AlloyKnownConfigPaths)) {
        if ([string]::Equals([string]$known, $configPath, [System.StringComparison]::OrdinalIgnoreCase)) { return [string]$known }
    }
    return $configPath
}

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

function Remove-OpsGridTempPaths {
    $failed = $false
    foreach ($path in @($script:OpsGridTempPaths | Sort-Object Length -Descending)) {
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

function Test-OpsGridSafeDirectory([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    try {
        $current = New-Object System.IO.DirectoryInfo($Path)
        while ($null -ne $current) {
            if ((Test-Path -LiteralPath $current.FullName) -and -not [System.IO.Directory]::Exists($current.FullName)) { return $false }
            if ([System.IO.Directory]::Exists($current.FullName) -and (($current.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) { return $false }
            $parent = $current.Parent
            if ($null -eq $parent -or [string]::Equals($parent.FullName, $current.FullName, [System.StringComparison]::OrdinalIgnoreCase)) { break }
            $current = $parent
        }
        return $true
    }
    catch { return $false }
}

function Get-OpsGridAlloyRegistryPaths {
    return @(
        'HKLM:\Software\GrafanaLabs\Alloy',
        'HKLM:\Software\WOW6432Node\GrafanaLabs\Alloy',
        'HKLM:\SYSTEM\CurrentControlSet\Services\EventLog\Application\Alloy',
        'HKLM:\SYSTEM\CurrentControlSet\Services\EventLog\Application\Grafana Alloy'
    )
}

function Get-OpsGridAlloyUninstallPaths {
    $paths = New-Object System.Collections.Generic.List[string]
    foreach ($root in @('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        foreach ($key in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
            try {
                $displayName = [string](Get-ItemProperty -LiteralPath $key.PSPath -Name DisplayName -ErrorAction Stop).DisplayName
                if ($displayName -match '(?i)^Grafana(?: Labs)? Alloy$') { $paths.Add([string]$key.PSPath) }
            } catch { }
        }
    }
    return @($paths)
}

function Test-OpsGridNoPreexistingAlloyRegistryState {
    foreach ($path in @(Get-OpsGridAlloyRegistryPaths)) { if (Test-Path -LiteralPath $path) { return $false } }
    return (@(Get-OpsGridAlloyUninstallPaths).Count -eq 0)
}

function Remove-OpsGridFreshAlloyRegistryState {
    $failed = $false
    foreach ($path in @(Get-OpsGridAlloyRegistryPaths) + @(Get-OpsGridAlloyUninstallPaths)) {
        try {
            if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop }
            if (Test-Path -LiteralPath $path) { $failed = $true }
        } catch { $failed = $true }
    }
    return (-not $failed)
}

function Get-OpsGridAlloyUserArtifactPaths {
    # The official NSIS installer uses SetShellVarContext all, so its data is
    # below the common application-data root and its shortcut is below the
    # common Programs root, not the invoking user's profile.
    $appData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
    $programs = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonPrograms)
    if ([string]::IsNullOrWhiteSpace($appData) -or [string]::IsNullOrWhiteSpace($programs)) { throw 'Alloy common artifact paths are unavailable' }
    if ($null -eq $script:AlloyCommonDataParentPath) {
        $script:AlloyCommonDataParentPath = Join-Path $appData 'GrafanaLabs\Alloy'
        $script:AlloyCommonDataParentExistedBeforeRun = [System.IO.Directory]::Exists($script:AlloyCommonDataParentPath)
    }
    return @(
        # NSIS writes its per-machine data below this Alloy data directory;
        # treat it as one fresh artifact so no installer-created child survives.
        (Join-Path $appData 'GrafanaLabs\Alloy\data'),
        (Join-Path $programs 'Alloy')
    )
}

function Test-OpsGridNoPreexistingAlloyUserArtifacts {
    $paths = @(Get-OpsGridAlloyUserArtifactPaths)
    $script:AlloyUserArtifactIdentities = @{}
    $script:AlloyCommonDataParentIdentity = $null
    foreach ($path in $paths) {
        if (-not (Test-OpsGridSafeDirectory -Path $path)) { return $false }
        if (Test-Path -LiteralPath $path) { return $false }
        $script:AlloyUserArtifactIdentities[[string]$path] = $null
    }
    return $true
}

function Capture-OpsGridFreshAlloyUserArtifacts {
    try {
        $paths = @(Get-OpsGridAlloyUserArtifactPaths)
        foreach ($path in $paths) {
            $key = [string]$path
            if (-not $script:AlloyUserArtifactIdentities.ContainsKey($key)) { return $false }
            if (-not (Test-OpsGridSafeDirectory -Path $path)) { return $false }
            if (-not (Test-Path -LiteralPath $path)) {
                if ($null -ne $script:AlloyUserArtifactIdentities[$key]) { return $false }
                continue
            }
            $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
            if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
            $createdUtc = [DateTime]$item.CreationTimeUtc
            if ($createdUtc -lt $script:AlloyUserArtifactRunStartedUtc) { return $false }
            $identity = [Int64]$createdUtc.Ticks
            if ($null -ne $script:AlloyUserArtifactIdentities[$key] -and [Int64]$script:AlloyUserArtifactIdentities[$key] -ne $identity) { return $false }
            $script:AlloyUserArtifactIdentities[$key] = $identity
        }
        if (-not $script:AlloyCommonDataParentExistedBeforeRun) {
            if (-not [System.IO.Directory]::Exists($script:AlloyCommonDataParentPath)) {
                if ($null -ne $script:AlloyCommonDataParentIdentity) { return $false }
            }
            else {
                if (-not (Test-OpsGridSafeDirectory -Path $script:AlloyCommonDataParentPath)) { return $false }
                $parentItem = Get-Item -LiteralPath $script:AlloyCommonDataParentPath -Force -ErrorAction Stop
                if (-not $parentItem.PSIsContainer -or ($parentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
                $parentCreatedUtc = [DateTime]$parentItem.CreationTimeUtc
                if ($parentCreatedUtc -lt $script:AlloyUserArtifactRunStartedUtc) { return $false }
                $parentIdentity = [Int64]$parentCreatedUtc.Ticks
                if ($null -ne $script:AlloyCommonDataParentIdentity -and [Int64]$script:AlloyCommonDataParentIdentity -ne $parentIdentity) { return $false }
                $script:AlloyCommonDataParentIdentity = $parentIdentity
            }
        }
        return $true
    }
    catch { return $false }
}

function Remove-OpsGridFreshAlloyUserArtifacts {
    $failed = $false
    try { $paths = @(Get-OpsGridAlloyUserArtifactPaths) } catch { return $false }
    foreach ($path in $paths) {
        try {
            $key = [string]$path
            if (-not $script:AlloyUserArtifactIdentities.ContainsKey($key)) { throw 'fresh Alloy user artifact identity is unavailable' }
            if (-not (Test-Path -LiteralPath $path)) {
                if ($null -ne $script:AlloyUserArtifactIdentities[$key]) { throw 'fresh Alloy user artifact disappeared unexpectedly' }
                continue
            }
            if ($null -eq $script:AlloyUserArtifactIdentities[$key]) { throw 'fresh Alloy user artifact was not observed as installer-created' }
            if (-not (Test-OpsGridSafeDirectory -Path $path)) { throw 'fresh Alloy user artifact path is unsafe' }
            $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
            if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'fresh Alloy user artifact is not the recorded directory' }
            if ([Int64]$item.CreationTimeUtc.Ticks -ne [Int64]$script:AlloyUserArtifactIdentities[$key]) { throw 'fresh Alloy user artifact identity changed' }
            Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
            if (Test-Path -LiteralPath $path) { throw 'fresh Alloy user artifact cleanup failed' }
        } catch { $failed = $true }
    }
    if (-not $failed -and -not $script:AlloyCommonDataParentExistedBeforeRun -and -not [string]::IsNullOrWhiteSpace($script:AlloyCommonDataParentPath)) {
        try {
            if (-not [System.IO.Directory]::Exists($script:AlloyCommonDataParentPath)) {
                if ($null -ne $script:AlloyCommonDataParentIdentity) { throw 'fresh Alloy parent disappeared unexpectedly' }
                return (-not $failed)
            }
            if ($null -eq $script:AlloyCommonDataParentIdentity) { throw 'fresh Alloy parent identity is unavailable' }
            $parent = Get-Item -LiteralPath $script:AlloyCommonDataParentPath -Force -ErrorAction Stop
            if (-not $parent.PSIsContainer -or ($parent.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'fresh Alloy parent is not the recorded directory' }
            if ([Int64]$parent.CreationTimeUtc.Ticks -ne [Int64]$script:AlloyCommonDataParentIdentity) { throw 'fresh Alloy parent identity changed' }
            if (@(Get-ChildItem -LiteralPath $script:AlloyCommonDataParentPath -Force -ErrorAction Stop).Count -eq 0) {
                Remove-Item -LiteralPath $script:AlloyCommonDataParentPath -Force -ErrorAction Stop
            }
            if ([System.IO.Directory]::Exists($script:AlloyCommonDataParentPath)) { $failed = $true }
        } catch { $failed = $true }
    }
    return (-not $failed)
}

function Install-AlloyOfficial {
    $tempDirectory = $null
    $installerPath = $null
    try {
        $script:OpsGridStage = 'install'
        if (-not (Test-OpsGridSafeDirectory -Path $script:AlloyInstallDirectory)) { Fail-OpsGrid 20 'Alloy install directory is a reparse point or unsafe' }
        if (-not (Test-OpsGridSafeDirectory -Path $script:AlloyConfigDirectory)) { Fail-OpsGrid 20 'Alloy config directory is a reparse point or unsafe' }
        $null = New-Item -ItemType Directory -Path $script:AlloyConfigDirectory -Force -ErrorAction Stop
        Set-OpsGridDirectoryAcl -Path $script:InstallRoot
        Set-OpsGridDirectoryAcl -Path $script:AlloyConfigDirectory
        $tempDirectory = New-OpsGridTempDirectory
        $installerPath = Join-Path $tempDirectory 'alloy-installer-windows-amd64.exe'
        Register-OpsGridTempPath $installerPath
        Invoke-WebRequest -Uri $script:AlloyInstallerUrl -OutFile $installerPath -UseBasicParsing -ErrorAction Stop | Out-Null
        if (-not [System.IO.File]::Exists($installerPath)) { Fail-OpsGrid 20 'Alloy installer download failed' }
        Set-OpsGridFileAcl -Path $installerPath
        $signature = Get-AuthenticodeSignature -FilePath $installerPath -ErrorAction Stop
        if ($null -eq $signature -or [string]$signature.Status -ne 'Valid' -or
            $null -eq $signature.SignerCertificate -or
            [string]$signature.SignerCertificate.Subject -notmatch '(?i)Grafana') {
            Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
            Fail-OpsGrid 20 'Alloy installer signature is not valid'
        }
        $arguments = @('/S', ('/CONFIG={0}' -f $script:AlloyFreshConfigPath))
        $process = Start-Process -FilePath $installerPath -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop
        if ($null -eq $process -or [int]$process.ExitCode -ne 0) { Fail-OpsGrid 20 'Alloy silent installation failed' }
        $script:OpsGridInstalledByRun = $true
    }
    catch {
        if ($script:OpsGridFailureCode -eq 20 -and $_.Exception.Message -eq $script:OpsGridFailureMarker) { throw }
        Fail-OpsGrid 20 'Alloy installation failed'
    }
    finally {
        if ($null -ne $installerPath) { try { Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue } catch { } }
    }
}

function Get-OpsGridHttpStatusCode($Exception) {
    if ($null -eq $Exception) { return $null }
    try {
        $response = $Exception.Response
        if ($null -eq $response) { return $null }
        $status = $response.StatusCode
        if ($status -is [int]) { return [int]$status }
        if ($null -ne $status -and $null -ne $status.value__) { return [int]$status.value__ }
        if ($null -eq $status) { return $null }
        return [int]$status
    } catch { return $null }
}

function Test-OpsGridRetryableException($Exception) {
    $current = $Exception
    while ($null -ne $current) {
        if ($current -is [System.TimeoutException] -or $current -is [System.Net.WebException]) { return $true }
        if ([string]$current.GetType().FullName -eq 'System.Net.Http.HttpRequestException') { return $true }
        $current = $current.InnerException
    }
    return $false
}

function Test-EnrollmentResponse($Response) {
    if ($null -eq $Response) { return $false }
    $status = Get-OpsGridPropertyValue $Response 'status'
    $agentId = Get-OpsGridPropertyValue $Response 'agentId'
    $organizationId = Get-OpsGridPropertyValue $Response 'organizationId'
    $vmId = Get-OpsGridPropertyValue $Response 'vmId'
    $credential = [string](Get-OpsGridPropertyValue $Response 'credential')
    if ([string]$status -cne 'ACTIVE' -or [string]::IsNullOrWhiteSpace([string]$agentId) -or [string]::IsNullOrWhiteSpace([string]$organizationId) -or [string]::IsNullOrWhiteSpace([string]$vmId)) { return $false }
    if ([string]::IsNullOrWhiteSpace($credential) -or $credential -notmatch '^AGT_[A-Za-z0-9_-]+$' -or $credential -match '[\r\n]') { return $false }
    return $true
}

function Invoke-Enrollment([string]$Token, [string]$Os, [string]$BaseUrl) {
    $requestBody = $null
    try {
        $uri = Test-ApiBaseUrl -Value $BaseUrl
        $payload = @{ token = $Token }
        if (-not [string]::IsNullOrWhiteSpace($Os)) { $payload.os = $Os }
        $requestBody = $payload | ConvertTo-Json -Compress
        $endpoint = $uri.AbsoluteUri.TrimEnd('/') + '/api/v1/agent-enrollment'
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            try {
                $response = Invoke-RestMethod -Method Post -Uri $endpoint -ContentType 'application/json' -Body $requestBody -TimeoutSec 30 -MaximumRedirection 0 -ErrorAction Stop
                if (-not (Test-EnrollmentResponse $response)) { Fail-OpsGrid 30 'enrollment response was invalid' }
                return $response
            }
            catch {
                if ($script:OpsGridFailureCode -eq 30 -and $_.Exception.Message -eq $script:OpsGridFailureMarker) { throw }
                $httpStatus = Get-OpsGridHttpStatusCode $_.Exception
                $retryableStatus = ($httpStatus -eq 429 -or ($httpStatus -ge 500 -and $httpStatus -le 599))
                $retryableNetwork = ($null -eq $httpStatus -and (Test-OpsGridRetryableException $_.Exception))
                if (($retryableStatus -or $retryableNetwork) -and $attempt -lt 3) { Start-Sleep -Seconds ([Math]::Min($attempt, 2)); continue }
                Fail-OpsGrid 30 'enrollment failed'
            }
        }
    }
    catch {
        if ($script:OpsGridFailureCode -eq 30 -and $_.Exception.Message -eq $script:OpsGridFailureMarker) { throw }
        Fail-OpsGrid 30 'enrollment failed'
    }
    finally {
        $requestBody = $null
        $Token = $null
        $Os = $null
        $BaseUrl = $null
    }
}

function Get-AlloyServiceIdentity($Service) {
    $startName = [string](Get-OpsGridPropertyValue $Service 'StartName')
    if ([string]::IsNullOrWhiteSpace($startName)) { $startName = [string](Get-OpsGridPropertyValue (Get-OpsGridPropertyValue $Service 'CimService') 'StartName') }
    if ([string]::IsNullOrWhiteSpace($startName)) { Fail-OpsGrid 20 'Alloy service identity is unavailable' }
    $trimmed = $startName.Trim()
    $sid = $null
    switch -Regex ($trimmed) {
        '(?i)^(?:LocalSystem|SYSTEM|NT AUTHORITY\\SYSTEM)$' { $sid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18'); break }
        '(?i)^(?:LocalService|NT AUTHORITY\\LocalService)$' { $sid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-19'); break }
        '(?i)^(?:NetworkService|NT AUTHORITY\\NetworkService)$' { $sid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-20'); break }
        default {
            try {
                $account = New-Object System.Security.Principal.NTAccount($trimmed)
                $sid = $account.Translate([System.Security.Principal.SecurityIdentifier])
            } catch { Fail-OpsGrid 20 'Alloy service identity cannot be resolved' }
        }
    }
    return [pscustomobject]@{ Name = $trimmed; Sid = $sid }
}

function Write-OpsGridUtf8NoBom([string]$Path, [string]$Content) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'output path is required' }
    $parent = [System.IO.Path]::GetDirectoryName($Path)
    if ([string]::IsNullOrWhiteSpace($parent) -or -not [System.IO.Directory]::Exists($parent)) { throw 'output directory is unavailable' }
    $info = New-Object System.IO.FileInfo($parent)
    if (($info.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'output directory is a reparse point' }
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, [string]$Content, $encoding)
}

function Invoke-OpsGridAtomicReplace([string]$Source, [string]$Destination) {
    if ([System.IO.File]::Exists($Destination)) { [System.IO.File]::Replace($Source, $Destination, $null, $true) }
    else { [System.IO.File]::Move($Source, $Destination) }
}

function Test-OpsGridCredentialPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [string]::Equals(($Path -replace '/', '\\'), ($script:AgentCredentialFile -replace '/', '\\'), [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
    $normalized = ($Path -replace '/', '\\')
    $parent = New-Object System.IO.DirectoryInfo([System.IO.Path]::GetDirectoryName($normalized))
    while ($null -ne $parent) {
        if ([System.IO.Directory]::Exists($parent.FullName)) {
            if (($parent.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
        }
        $next = $parent.Parent
        if ($null -eq $next -or [string]::Equals([string]$next.FullName, [string]$parent.FullName, [System.StringComparison]::OrdinalIgnoreCase)) { break }
        $parent = $next
    }
    if ([System.IO.Directory]::Exists($normalized)) { return $false }
    if ([System.IO.File]::Exists($normalized)) {
        $fileInfo = New-Object System.IO.FileInfo($normalized)
        if (($fileInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
    }
    return $true
}

function Set-OpsGridCredential([string]$Credential, [string]$Path, $ServiceIdentity) {
    if ([string]::IsNullOrWhiteSpace($Credential) -or $Credential -notmatch '^AGT_[A-Za-z0-9_-]+$' -or $Credential -match '[\r\n]') { Fail-OpsGrid 40 'enrollment credential is invalid' }
    if (-not (Test-OpsGridCredentialPath -Path $Path)) { Fail-OpsGrid 40 'credential path is not approved' }
    try {
        if (-not [System.IO.Directory]::Exists($script:InstallRoot)) { [System.IO.Directory]::CreateDirectory($script:InstallRoot) | Out-Null }
        Set-OpsGridDirectoryAcl -Path $script:InstallRoot -ServiceIdentity $ServiceIdentity
        $tempPath = Join-Path $script:InstallRoot ('.agent.credential.' + [guid]::NewGuid().ToString('N') + '.tmp')
        Register-OpsGridTempPath $tempPath
        Write-OpsGridUtf8NoBom $tempPath $Credential
        Set-OpsGridFileAcl -Path $tempPath -ServiceIdentity $ServiceIdentity
        Invoke-OpsGridAtomicReplace -Source $tempPath -Destination $Path
        Set-OpsGridFileAcl -Path $Path -ServiceIdentity $ServiceIdentity
    }
    catch {
        if ($script:OpsGridFailureCode -eq 40 -and $_.Exception.Message -eq $script:OpsGridFailureMarker) { throw }
        Fail-OpsGrid 40 'credential ACL or replacement failed'
    }
}

function Render-AlloyConfig([string]$TemplatePath, [string]$CredentialPath, [string]$OutputPath) {
    try {
        if ([string]::IsNullOrWhiteSpace($TemplatePath) -or -not [System.IO.File]::Exists($TemplatePath)) { Fail-OpsGrid 40 'Alloy template is unavailable' }
        $text = [System.IO.File]::ReadAllText($TemplatePath)
        $placeholder = $script:CredentialFilePlaceholder
        $count = 0; $offset = 0
        while (($position = $text.IndexOf($placeholder, $offset, [System.StringComparison]::Ordinal)) -ge 0) { $count++; $offset = $position + $placeholder.Length }
        if ($count -ne 1) { Fail-OpsGrid 40 'Alloy template placeholder is invalid' }
        if ([string]::IsNullOrWhiteSpace($OutputPath) -or [string]::IsNullOrWhiteSpace($CredentialPath)) { Fail-OpsGrid 40 'Alloy config path is invalid' }
        $safeCredentialPath = ($CredentialPath -replace '\\', '/')
        if (-not [string]::Equals($safeCredentialPath, $script:AlloyCredentialConfigPath, [System.StringComparison]::OrdinalIgnoreCase)) { Fail-OpsGrid 40 'credential path is not approved' }
        Write-OpsGridUtf8NoBom -Path $OutputPath -Content ($text.Replace($placeholder, $safeCredentialPath))
        return $OutputPath
    }
    catch {
        if ($script:OpsGridFailureCode -eq 40 -and $_.Exception.Message -eq $script:OpsGridFailureMarker) { throw }
        Fail-OpsGrid 40 'Alloy config rendering failed'
    }
}

function Invoke-AlloyValidate($AlloyPath, $ConfigPath) {
    try {
        if ([string]::IsNullOrWhiteSpace([string]$AlloyPath) -or -not (Test-AlloyOfficialPath ([string]$AlloyPath))) { Fail-OpsGrid 40 'Alloy validator is unavailable' }
        if ([string]::IsNullOrWhiteSpace([string]$ConfigPath) -or -not [System.IO.File]::Exists([string]$ConfigPath)) { Fail-OpsGrid 40 'staged Alloy config is unavailable' }
        $outputDirectory = New-OpsGridTempDirectory
        $stdoutPath = Register-OpsGridTempPath (Join-Path $outputDirectory 'validate.stdout')
        $stderrPath = Register-OpsGridTempPath (Join-Path $outputDirectory 'validate.stderr')
        $quotedConfigPath = '"{0}"' -f ([string]$ConfigPath)
        $process = Start-Process -FilePath ([string]$AlloyPath) -ArgumentList @('validate', $quotedConfigPath) -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -ErrorAction Stop
        if ($null -eq $process -or [int]$process.ExitCode -ne 0) { Fail-OpsGrid 40 'Alloy config validation failed' }
        return $true
    }
    catch {
        if ($script:OpsGridFailureCode -eq 40 -and $_.Exception.Message -eq $script:OpsGridFailureMarker) { throw }
        Fail-OpsGrid 40 'Alloy config validation failed'
    }
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
    return [pscustomobject]@{
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

function Start-OpsGridAlloyAndWait($Service) {
    try {
        $current = Get-Service -Name ([string]$Service.Name) -ErrorAction Stop
        switch ([string]$current.Status) {
            'Running' { Restart-Service -Name ([string]$Service.Name) -Force -ErrorAction Stop }
            'Paused' { Resume-Service -Name ([string]$Service.Name) -ErrorAction Stop }
            default { Start-Service -Name ([string]$Service.Name) -ErrorAction Stop }
        }
        $deadline = [DateTime]::UtcNow.AddSeconds(60)
        while ($true) {
            $health = Get-Service -Name ([string]$Service.Name) -ErrorAction Stop
            if ([string]$health.Status -eq 'Running') { return $true }
            if ([DateTime]::UtcNow -ge $deadline) { return $false }
            Start-Sleep -Milliseconds 250
        }
    } catch { return $false }
}

function Invoke-OpsGrid {
    $tokenForRun = $null
    $credential = $null
    $originalPath = [string]$env:PATH
    $service = $null
    $configPath = $null
    $serviceIdentity = $null
    $validationExecutable = $null
    $existingService = $false
    $transaction = $null
    $rollbackTransaction = $null
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

    try {
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
        $serviceIdentity = Get-AlloyServiceIdentity -Service $service

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
        $stagedConfig = Join-Path ([System.IO.Path]::GetDirectoryName($configPath)) ('.opsgrid-config.' + [guid]::NewGuid().ToString('N') + '.tmp')
        Register-OpsGridTempPath $stagedConfig
        $templatePath = Join-Path $PSScriptRoot 'alloy\windows.config.alloy.template'
        $null = Render-AlloyConfig -TemplatePath $templatePath -CredentialPath $script:AlloyCredentialConfigPath -OutputPath $stagedConfig
        $script:OpsGridStage = 'validate'
        $validationExecutable = [string]$service.ExecutablePath
        if ([string]::Equals([System.IO.Path]::GetFileName($validationExecutable), 'alloy-service-windows-amd64.exe', [System.StringComparison]::OrdinalIgnoreCase)) {
            $validationExecutable = Join-Path ([System.IO.Path]::GetDirectoryName($validationExecutable)) 'alloy.exe'
        }
        if (-not (Test-OpsGridSafeRegularFile -Path $validationExecutable)) { Fail-OpsGrid 20 'Alloy validation executable is unsafe or unavailable' }
        $null = Invoke-AlloyValidate -AlloyPath $validationExecutable -ConfigPath $stagedConfig
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
            catch { $rollbackFailed = $true }
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
        $script:OpsGridExitCode = $failureCode
    }
    finally {
        Release-OpsGridLock
        if (-not (Remove-OpsGridTempPaths)) {
            Write-OpsGridLog 'temporary secret cleanup failed'
            if ([int]$script:OpsGridExitCode -eq 0) { $script:OpsGridExitCode = 50 }
        }
        if ($null -ne $rollbackTransaction -and -not (Remove-OpsGridFreshInstallRoot -Snapshot $rollbackTransaction)) {
            Write-OpsGridLog 'fresh OpsGrid installation root cleanup failed'
            if ([int]$script:OpsGridExitCode -eq 0) { $script:OpsGridExitCode = 50 }
        }
        if ($partialInstallRootCleanupPending -and -not (Remove-OpsGridFreshInstallRoot -Snapshot ([pscustomobject]@{ InstallRootExistedBeforeRun = $false }))) {
            Write-OpsGridLog 'fresh OpsGrid installation root cleanup failed'
            if ([int]$script:OpsGridExitCode -eq 0) { $script:OpsGridExitCode = 50 }
        }
        $env:PATH = $originalPath
        $tokenForRun = $null
        $credential = $null
        $script:EnrollmentToken = $null
        $EnrollmentToken = $null
        Clear-Variable -Name tokenForRun -ErrorAction SilentlyContinue
    }
}

# Normal invocation runs only after the early dot-source guard and executes the
# complete preflight, enrollment, transaction, and service-health flow.
if ($MyInvocation.InvocationName -ne '.') {
    Invoke-OpsGrid
    exit $script:OpsGridExitCode
}
