# Internal installer declarations; dot-sourced by the guarded entrypoint.
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
