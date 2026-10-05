# Internal installer declarations; dot-sourced by the guarded entrypoint.
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
