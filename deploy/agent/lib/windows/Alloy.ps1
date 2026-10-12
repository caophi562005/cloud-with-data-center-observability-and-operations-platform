# Internal installer declarations; dot-sourced by the guarded entrypoint.
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

function Test-AlloyOfficialPath([string]$ExecutablePath) {
    if ([string]::IsNullOrWhiteSpace($ExecutablePath)) {
        return $false
    }

    $normalizedPath = ($ExecutablePath -replace '/', '\').Trim()
    $fileName = [System.IO.Path]::GetFileName($normalizedPath)
    if (-not [System.IO.Path]::IsPathRooted($normalizedPath) -or
        (-not [string]::Equals($fileName, 'alloy.exe', [System.StringComparison]::OrdinalIgnoreCase) -and
         -not [string]::Equals($fileName, 'alloy-windows-amd64.exe', [System.StringComparison]::OrdinalIgnoreCase) -and
         -not [string]::Equals($fileName, 'alloy-service-windows-amd64.exe', [System.StringComparison]::OrdinalIgnoreCase))) {
        return $false
    }

    # Keep this pattern in lockstep with Get-AlloyKnownBinaryPaths: only the
    # explicitly approved Grafana installation layouts are official binaries.
    if ($normalizedPath -notmatch '(?i)^[A-Za-z]:\\Program Files\\(?:Grafana Labs\\Alloy|GrafanaLabs\\Alloy|Grafana Alloy)\\(?:alloy|alloy-windows-amd64|alloy-service-windows-amd64)\.exe$' -or
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

function Get-OpsGridAlloyValidationExecutable($Service) {
    $executable=[string]$Service.ExecutablePath
    if (-not (Test-AlloyOfficialPath $executable)) { Fail-OpsGrid 20 'Alloy service executable is unsafe or unavailable' }
    if ([IO.Path]::GetFileName($executable) -ieq 'alloy-service-windows-amd64.exe') {
        # Official NSIS payload plus legacy exact name only. Never execute the
        # service wrapper as a CLI or search outside this signed installed layout.
        $directory=[IO.Path]::GetDirectoryName($executable)
        $candidates=@(foreach($name in @('alloy-windows-amd64.exe','alloy.exe')) {
            $path=Join-Path $directory $name
            if(Test-OpsGridSafeRegularFile $path) { $path }
        })
        if($candidates.Count -ne 1) { Fail-OpsGrid 20 'Alloy validation executable is unsafe, missing or ambiguous' }
        $executable=$candidates[0]
    }
    if (-not (Test-AlloyOfficialPath $executable)) { Fail-OpsGrid 20 'Alloy validation executable is unsafe or unavailable' }
    return $executable
}

function Get-AlloyKnownBinaryPaths {
    $paths = @(
        'C:\Program Files\Grafana Labs\Alloy\alloy-windows-amd64.exe',
        'C:\Program Files\GrafanaLabs\Alloy\alloy-windows-amd64.exe',
        'C:\Program Files\Grafana Alloy\alloy-windows-amd64.exe',
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
        $paths += (Join-Path -Path $programFiles -ChildPath 'Grafana Labs\Alloy\alloy-windows-amd64.exe')
        $paths += (Join-Path -Path $programFiles -ChildPath 'GrafanaLabs\Alloy\alloy-windows-amd64.exe')
        $paths += (Join-Path -Path $programFiles -ChildPath 'Grafana Alloy\alloy-windows-amd64.exe')
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

        if ($executableName -in @('alloy-service-windows-amd64.exe','alloy-windows-amd64.exe')) { $isAlloyExecutable = $true }
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

# Profile mode never shares the enrollment transaction or its ACL-repairing lock.
