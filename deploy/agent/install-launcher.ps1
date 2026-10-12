$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest

$script:OutputPrefix = '[opsgrid-agent]'
$script:ReleaseBaseUrl = 'https://github.com/caophi562005/cloud-with-data-center-observability-and-operations-platform/releases/latest/download'
$script:TempRoot = $null
$script:ExitCode = 0

function Write-LauncherLog([string]$Message) {
    Write-Output ('{0} {1}' -f $script:OutputPrefix, $Message)
}

function Write-LauncherUsage {
    Write-LauncherLog 'Usage: install-launcher.ps1 -Token TOKEN [-ApiBaseUrl URL]'
    Write-LauncherLog '  -Token TOKEN  Enrollment token input (not echoed)'
    Write-LauncherLog '  -ApiBaseUrl URL  API origin (default: https://api.opsgrid.hacmieu.com)'
    Write-LauncherLog '  -Help         Show this help text'
}

function Get-LauncherArguments([string[]]$Arguments) {
    $token = $null; $showHelp = $false; $baseUrl = 'https://api.opsgrid.hacmieu.com'
    $seen = @{}
    try {
        for ($index = 0; $index -lt $Arguments.Count; $index++) {
            $argument = [string]$Arguments[$index]
            if ($argument -match '[\x00-\x1F\x7F]') { throw [ArgumentException]::new('invalid launcher arguments') }
            if ($argument -match '^(?i)-(Help|h)$') {
                if ($seen.ContainsKey('Help')) { throw [ArgumentException]::new('duplicate launcher argument') }
                $seen.Help = $true; $showHelp = $true; continue
            }
            if ($argument -notmatch '^(?i)-(Token|ApiBaseUrl)(?:=(.*))?$') { throw [ArgumentException]::new('invalid launcher arguments') }
            $name = $matches[1]; $hasEquals = $argument.Contains('='); $value = $matches[2]
            if ($seen.ContainsKey($name)) { throw [ArgumentException]::new('duplicate launcher argument') }
            if (-not $hasEquals) {
                if ($index + 1 -ge $Arguments.Count -or [string]$Arguments[$index + 1] -match '^-') { throw [ArgumentException]::new('missing launcher argument') }
                $value = [string]$Arguments[++$index]
            }
            if ([string]::IsNullOrWhiteSpace($value) -or $value -match '[\x00-\x1F\x7F]') { throw [ArgumentException]::new('invalid launcher argument') }
            $seen[$name] = $true
            if ($name -ieq 'Token') { $token = $value } else { $baseUrl = $value }
        }
        $null = Test-LauncherApiBaseUrl $baseUrl
        if ($showHelp) { return [pscustomobject]@{ Help=$true; Token=$null; ApiBaseUrl=$baseUrl } }
        if (-not $seen.ContainsKey('Token')) { $token = [Environment]::GetEnvironmentVariable('OPSGRID_ENROLLMENT_TOKEN', 'Process') }
        if ([string]::IsNullOrWhiteSpace($token) -or $token -match '[\x00-\x1F\x7F]') { throw [ArgumentException]::new('enrollment token is required') }
        return [pscustomobject]@{ Help=$false; Token=$token; ApiBaseUrl=$baseUrl }
    }
    finally { [Environment]::SetEnvironmentVariable('OPSGRID_ENROLLMENT_TOKEN', $null, 'Process') }
}

function Test-LauncherApiBaseUrl([string]$Value) {
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

function New-LauncherTempRoot {
    $base = [IO.Path]::GetTempPath()
    $path = Join-Path $base ('opsgrid-agent-launcher-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $path -Force | Out-Null
    return $path
}

function Download-LauncherAsset([string]$AssetName, [string]$Destination) {
    $temporary = '{0}.tmp' -f $Destination
    try {
        Invoke-WebRequest -UseBasicParsing -Uri ('{0}/{1}' -f $script:ReleaseBaseUrl, $AssetName) `
            -OutFile $temporary -ErrorAction Stop
        if (-not (Test-Path -LiteralPath $temporary -PathType Leaf)) { throw 'asset was not written' }
        if ((Get-Item -LiteralPath $temporary -Force).Length -le 0) { throw 'asset was empty' }
        Move-Item -LiteralPath $temporary -Destination $Destination -Force -ErrorAction Stop
    }
    catch {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        throw 'release asset download failed'
    }
}

function Test-LauncherAssets {
    $installer = Join-Path $script:TempRoot 'install.ps1'
    $template = Join-Path $script:TempRoot 'alloy\windows.config.alloy.template'
    $installerText = [IO.File]::ReadAllText($installer)
    $templateText = [IO.File]::ReadAllText($template)
    # Structural truncation checks only: these do not attest a paired release.
    # Live use still requires independent review of the exact installer/template hashes.
    $tokens = $null; $parseErrors = $null
    $installerAst = [Management.Automation.Language.Parser]::ParseInput($installerText, [ref]$tokens, [ref]$parseErrors)
    $functions = @($installerAst.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false) | ForEach-Object { $_.Name })
    if ($parseErrors.Count -gt 0 -or -not $installerText.Contains('EnrollmentToken') -or
        @('Get-OpsGridArguments','Invoke-Enrollment','Invoke-OpsGrid','Test-EnrollmentResponse' | Where-Object { $functions -notcontains $_ }).Count -gt 0 -or
        $null -eq $installerAst.EndBlock -or $installerAst.EndBlock.Statements.Count -eq 0) { throw 'downloaded Windows installer is invalid' }
    $tail = $installerAst.EndBlock.Statements[-1]
    if ($tail -isnot [Management.Automation.Language.IfStatementAst] -or
        $null -eq $tail.Find({ param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Invoke-OpsGrid' }, $true) -or
        $null -eq $tail.Find({ param($node) $node -is [Management.Automation.Language.ExitStatementAst] }, $true)) { throw 'downloaded Windows installer is incomplete' }
    if (-not $templateText.Contains('__CREDENTIAL_FILE__') -or
        $templateText -notmatch 'prometheus\.exporter\.windows\s+"host"' -or
        $templateText -notmatch 'prometheus\.scrape\s+"host"' -or
        $templateText -notmatch 'prometheus\.remote_write\s+"ingestion"' -or
        $templateText -notmatch 'credentials\s*=\s*local\.file\.agent_credential\.content') { throw 'downloaded Windows Alloy template is invalid' }
    $structure = [regex]::Replace($templateText, '(?m)//[^\r\n]*|"(?:\\.|[^"\\])*"', '')
    $depth = 0
    foreach ($character in $structure.ToCharArray()) {
        if ($character -eq '{') { $depth++ }
        if ($character -eq '}') { $depth--; if ($depth -lt 0) { throw 'downloaded Windows Alloy template is incomplete' } }
    }
    if ($depth -ne 0 -or $templateText.TrimEnd() -notmatch '}$') { throw 'downloaded Windows Alloy template is incomplete' }
}

function Remove-LauncherTempRoot {
    if ([string]::IsNullOrWhiteSpace([string]$script:TempRoot)) { return $true }
    try {
        if (-not [IO.Directory]::Exists($script:TempRoot)) { return $true }
        $root = Get-Item -LiteralPath $script:TempRoot -Force -ErrorAction Stop
        if (($root.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'launcher temp root is a reparse point' }
        foreach ($item in @(Get-ChildItem -LiteralPath $script:TempRoot -Force -Recurse -ErrorAction Stop)) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'launcher temp tree contains a reparse point' }
        }
        Remove-Item -LiteralPath $script:TempRoot -Recurse -Force -ErrorAction Stop
        return (-not [IO.Directory]::Exists($script:TempRoot))
    }
    catch {
        return $false
    }
}

function Invoke-Launcher([string[]]$Arguments) {
    $parsed = $null; $childArguments = $null
    $script:TempRoot = $null; $script:ExitCode = 0
    $argumentsValidated = $false
    try {
        $parsed = Get-LauncherArguments -Arguments $Arguments
        $argumentsValidated = $true
        if ($parsed.Help) { Write-LauncherUsage; return }
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $script:TempRoot = New-LauncherTempRoot
        $alloyDirectory = Join-Path $script:TempRoot 'alloy'
        New-Item -ItemType Directory -Path $alloyDirectory -Force | Out-Null
        Download-LauncherAsset 'install.ps1' (Join-Path $script:TempRoot 'install.ps1')
        Download-LauncherAsset 'windows.config.alloy.template' (Join-Path $alloyDirectory 'windows.config.alloy.template')
        Test-LauncherAssets
        $installer = Join-Path $script:TempRoot 'install.ps1'
        # Literal native argv; never interpolate a command or evaluate token text.
        $childArguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$installer,
            '-EnrollmentToken',([string]$parsed.Token),'-ApiBaseUrl',([string]$parsed.ApiBaseUrl))
        & powershell.exe @childArguments
        $script:ExitCode = $LASTEXITCODE
    }
    catch {
        if (-not $argumentsValidated -and $_.Exception -is [ArgumentException]) {
            Write-LauncherLog 'invalid launcher arguments or missing enrollment token'
            $script:ExitCode = 10
        }
        else { Write-LauncherLog 'launcher failed'; $script:ExitCode = 20 }
    }
    finally {
        if (-not (Remove-LauncherTempRoot)) {
            Write-LauncherLog 'launcher temporary cleanup failed'
            if ($script:ExitCode -eq 0) { $script:ExitCode = 50 }
        }
        [Environment]::SetEnvironmentVariable('OPSGRID_ENROLLMENT_TOKEN', $null, 'Process')
        $parsed = $null; $childArguments = $null; $Arguments = $null
    }
}

Invoke-Launcher -Arguments @($args)
exit $script:ExitCode
