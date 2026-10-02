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
    Write-LauncherLog 'Usage: install-launcher.ps1 -Token TOKEN'
    Write-LauncherLog '  -Token TOKEN  Enrollment token input (not echoed)'
    Write-LauncherLog '  -Help         Show this help text'
}

function Get-LauncherArguments([string[]]$Arguments) {
    $token = $null
    $showHelp = $false
    for ($index = 0; $index -lt $Arguments.Count; $index++) {
        $argument = [string]$Arguments[$index]
        if ([string]::Equals($argument, '-Help', [System.StringComparison]::OrdinalIgnoreCase) -or
            [string]::Equals($argument, '-h', [System.StringComparison]::OrdinalIgnoreCase)) {
            $showHelp = $true
            continue
        }
        if ([string]::Equals($argument, '-Token', [System.StringComparison]::OrdinalIgnoreCase)) {
            if (($index + 1) -ge $Arguments.Count) { throw [System.ArgumentException]::new('invalid launcher arguments') }
            $index++
            $token = [string]$Arguments[$index]
            continue
        }
        if ($argument.StartsWith('-Token=', [System.StringComparison]::OrdinalIgnoreCase)) {
            $token = $argument.Substring(7)
            continue
        }
        throw [System.ArgumentException]::new('invalid launcher arguments')
    }
    if ($showHelp) {
        return [pscustomobject]@{ Help = $true; Token = $null }
    }
    if ([string]::IsNullOrWhiteSpace($token)) {
        $environmentToken = [Environment]::GetEnvironmentVariable('OPSGRID_ENROLLMENT_TOKEN', 'Process')
        if (-not [string]::IsNullOrWhiteSpace($environmentToken)) {
            $token = [string]$environmentToken
            [Environment]::SetEnvironmentVariable('OPSGRID_ENROLLMENT_TOKEN', $null, 'Process')
        }
    }
    if ([string]::IsNullOrWhiteSpace($token)) { throw [System.ArgumentException]::new('enrollment token is required') }
    return [pscustomobject]@{ Help = $false; Token = $token }
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
    if (-not $installerText.Contains('EnrollmentToken')) { throw 'downloaded Windows installer is invalid' }
    if (-not $templateText.Contains('__CREDENTIAL_FILE__')) { throw 'downloaded Windows Alloy template is invalid' }
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

try {
    $parsed = Get-LauncherArguments -Arguments $args
    if ($parsed.Help) {
        Write-LauncherUsage
        exit 0
    }

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $script:TempRoot = New-LauncherTempRoot
    $alloyDirectory = Join-Path $script:TempRoot 'alloy'
    New-Item -ItemType Directory -Path $alloyDirectory -Force | Out-Null

    Download-LauncherAsset 'install.ps1' (Join-Path $script:TempRoot 'install.ps1')
    Download-LauncherAsset 'windows.config.alloy.template' (Join-Path $alloyDirectory 'windows.config.alloy.template')
    Test-LauncherAssets

    $installer = Join-Path $script:TempRoot 'install.ps1'
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $installer -EnrollmentToken ([string]$parsed.Token)
    $script:ExitCode = $LASTEXITCODE
}
catch {
    if ($_.Exception -is [System.ArgumentException]) {
        Write-LauncherLog 'invalid launcher arguments or missing enrollment token'
        $script:ExitCode = 10
    }
    else {
        Write-LauncherLog 'launcher failed'
        $script:ExitCode = 20
    }
}
finally {
    if (-not (Remove-LauncherTempRoot)) {
        Write-LauncherLog 'launcher temporary cleanup failed'
        if ($script:ExitCode -eq 0) { $script:ExitCode = 50 }
    }
}

exit $script:ExitCode
