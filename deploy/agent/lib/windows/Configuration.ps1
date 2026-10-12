# Internal installer declarations; dot-sourced by the guarded entrypoint.
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
    if ([System.IO.File]::Exists($Destination)) { [System.IO.File]::Replace($Source, $Destination, [System.Management.Automation.Language.NullString]::Value, $true) }
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

function Invoke-AlloyValidate($AlloyPath, $ConfigPath, $PrivateOutputDirectory = $null) {
    $stdoutPath = $null
    $stderrPath = $null
    try {
        if ([string]::IsNullOrWhiteSpace([string]$AlloyPath) -or -not (Test-AlloyOfficialPath ([string]$AlloyPath))) { Fail-OpsGrid 40 'Alloy validator is unavailable' }
        if ([string]::IsNullOrWhiteSpace([string]$ConfigPath) -or -not [System.IO.File]::Exists([string]$ConfigPath)) { Fail-OpsGrid 40 'staged Alloy config is unavailable' }
        if ($null -eq $PrivateOutputDirectory) {
            $outputDirectory = New-OpsGridTempDirectory
            $stdoutPath = Register-OpsGridTempPath (Join-Path $outputDirectory 'validate.stdout')
            $stderrPath = Register-OpsGridTempPath (Join-Path $outputDirectory 'validate.stderr')
        }
        else {
            # Profile owns the already-private directory and its cleanup. Never
            # invoke fresh ACL repair merely to capture validator output.
            if (-not [IO.Directory]::Exists($PrivateOutputDirectory) -or -not (Test-OpsGridSafeDirectory $PrivateOutputDirectory)) { throw 'private validator directory is unsafe' }
            $id=[guid]::NewGuid().ToString('N')
            $stdoutPath=Join-Path $PrivateOutputDirectory ($id+'.stdout')
            $stderrPath=Join-Path $PrivateOutputDirectory ($id+'.stderr')
        }
        $quotedConfigPath = '"{0}"' -f ([string]$ConfigPath)
        $process = Start-Process -FilePath ([string]$AlloyPath) -ArgumentList @('validate', $quotedConfigPath) -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -ErrorAction Stop
        if ($null -eq $process -or [int]$process.ExitCode -ne 0) { Fail-OpsGrid 40 'Alloy config validation failed' }
        return $true
    }
    catch {
        if ($script:OpsGridFailureCode -eq 40 -and $_.Exception.Message -eq $script:OpsGridFailureMarker) { throw }
        Fail-OpsGrid 40 'Alloy config validation failed'
    }
    finally {
        # Validator transcripts may contain secrets. Profile rollback can retain
        # its private snapshot directory; transcripts must never be retained.
        foreach ($transcriptPath in @($stdoutPath, $stderrPath)) {
            if (-not [string]::IsNullOrWhiteSpace($transcriptPath) -and [IO.File]::Exists($transcriptPath)) {
                Remove-Item -LiteralPath $transcriptPath -Force -ErrorAction Stop
            }
        }
    }
}
