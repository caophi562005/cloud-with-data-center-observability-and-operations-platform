# Internal installer declarations; dot-sourced by the guarded entrypoint.
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

function Get-OpsGridArguments([string[]]$Arguments) {
    $result = [pscustomobject]@{
        Help = $false; EnrollmentToken = ''; ApiBaseUrl = 'https://api.opsgrid.hacmieu.com'
        ApplyProfile = $null; ExplicitEnrollmentToken = $false; ExplicitApiBaseUrl = $false
    }
    $seen = @{}; $position = 0
    for ($index = 0; $index -lt $Arguments.Count; $index++) {
        $argument = [string]$Arguments[$index]
        if ($argument -match '[\x00-\x1F\x7F]') { throw [ArgumentException]::new('invalid installer arguments') }
        if ($argument -match '^(?i)-(Help|h)$') {
            if ($seen.ContainsKey('Help')) { throw [ArgumentException]::new('duplicate installer argument') }
            $seen.Help = $true; $result.Help = $true; continue
        }
        if ($argument -match '^(?i)-(EnrollmentToken|ApiBaseUrl|ApplyProfile)(?:=(.*))?$') {
            $name = $matches[1]; $hasEquals = $argument.Contains('='); $value = $matches[2]
            if ($seen.ContainsKey($name)) { throw [ArgumentException]::new('duplicate installer argument') }
            if (-not $hasEquals) {
                if ($index + 1 -ge $Arguments.Count -or [string]$Arguments[$index + 1] -match '^-') { throw [ArgumentException]::new('missing installer argument') }
                $value = [string]$Arguments[++$index]
            }
            if ([string]::IsNullOrWhiteSpace($value) -or $value -match '[\x00-\x1F\x7F]') { throw [ArgumentException]::new('invalid installer argument') }
            $seen[$name] = $true; $result.$name = $value
            if ($name -ieq 'EnrollmentToken') { $result.ExplicitEnrollmentToken = $true }
            if ($name -ieq 'ApiBaseUrl') { $result.ExplicitApiBaseUrl = $true }
            continue
        }
        if ($argument.StartsWith('-') -or [string]::IsNullOrWhiteSpace($argument)) { throw [ArgumentException]::new('invalid installer arguments') }
        if ($position -eq 0 -and -not $result.ExplicitEnrollmentToken) {
            $result.EnrollmentToken = $argument; $result.ExplicitEnrollmentToken = $true; $seen.EnrollmentToken = $true
        }
        elseif ($position -eq 1 -and -not $result.ExplicitApiBaseUrl) {
            $result.ApiBaseUrl = $argument; $result.ExplicitApiBaseUrl = $true; $seen.ApiBaseUrl = $true
        }
        else { throw [ArgumentException]::new('invalid positional arguments') }
        $position++
    }
    if ($null -ne $result.ApplyProfile -and ($result.ExplicitEnrollmentToken -or $result.ExplicitApiBaseUrl)) { throw [ArgumentException]::new('profile cannot include enrollment or API arguments') }
    $null = Get-OpsGridApiOrigin $result.ApiBaseUrl
    return $result
}

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
    Write-OpsGridLog '  -ApiBaseUrl URL         API base URL (default: https://api.opsgrid.hacmieu.com)'
    Write-OpsGridLog '  -Help                   Show this help text'
}

function Test-ApiBaseUrl([string]$Value) {
    try { return Get-OpsGridApiOrigin $Value }
    catch { Fail-OpsGrid 10 'invalid API base URL' }
}

function Get-OpsGridApiOrigin([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw [ArgumentException]::new('invalid API base URL')
    }

    if ($Value -ne $Value.Trim() -or $Value -match '[\x00-\x1F\x7F\\]' -or $Value -notmatch '^(?i)https?://[^/?#]+$') {
        throw [ArgumentException]::new('invalid API base URL')
    }

    # Reject an explicit empty port before Uri normalizes `host:/` to the
    # default port. Cover both DNS/IPv4 and bracketed IPv6 authorities.
    if ($Value -match '^[^:/?#]+://(?:[^/?#]*@)?(?:\[[^\]]+\]|[^/?#:\s]+):(?=[/?#]|$)') {
        throw [ArgumentException]::new('invalid API base URL port')
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
        throw [ArgumentException]::new('invalid API base URL')
    }

    if (-not $isAbsolute -or $null -eq $uri -or [string]::IsNullOrWhiteSpace($uri.Host)) {
        throw [ArgumentException]::new('invalid API base URL')
    }

    # Do not permit credentials, including the empty-user-info form https://@host.
    if (-not [string]::IsNullOrEmpty($uri.UserInfo) -or $Value -match '^[^:/?#]+://[^/?#]*@') {
        throw [ArgumentException]::new('API base URL credentials are not allowed')
    }

    if ($Value.IndexOf('#') -ge 0 -or -not [string]::IsNullOrEmpty($uri.Fragment)) {
        throw [ArgumentException]::new('API base URL fragments are not allowed')
    }

    # API base URLs are origins only. Uri.AbsolutePath is '/' when no path was
    # supplied, so retain that representation but reject every other path. A
    # query delimiter is rejected even when its value is empty.
    if (($uri.AbsolutePath -ne '/') -or
        $Value -match '/$' -or
        $Value.IndexOf('?') -ge 0 -or
        -not [string]::IsNullOrEmpty($uri.Query)) {
        throw [ArgumentException]::new('API base URL must be an origin without a path or query')
    }

    # Uri.Port is -1 when the scheme's default port is used. Explicit ports must
    # be in the TCP range and zero is never valid.
    if ($uri.Port -ne -1 -and ($uri.Port -lt 1 -or $uri.Port -gt 65535)) {
        throw [ArgumentException]::new('invalid API base URL port')
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
        throw [ArgumentException]::new('API base URL must use HTTPS; HTTP is limited to loopback')
    }

    return $uri
}

function Get-OpsGridPropertyValue($Object, [string]$Name) {
    if ($null -eq $Object -or [string]::IsNullOrWhiteSpace($Name)) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}
