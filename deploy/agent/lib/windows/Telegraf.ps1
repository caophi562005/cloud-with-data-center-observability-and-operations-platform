# Native one-shot bootstrap; no helper service, loop, or token-bearing service argv.
$script:OpsGridReleaseCollector = 'telegraf'
$script:NativeBuildID = 'opsgrid-custom-6ab4b57bbaede19d'
$script:NativeReleaseUrl = 'https://github.com/caophi562005/cloud-with-data-center-observability-and-operations-platform/releases/download/' + $script:NativeBuildID

function Get-OpsGridNativeArguments([string[]]$Arguments) {
    $result = @{ ApiBaseUrl='https://api.opsgrid.hacmieu.com'; GatewayUrl='https://ingest.opsgrid.hacmieu.com/api/v1/write'; Token=$null; ReEnroll=$false; Help=$false }
    $seen = @{}
    for ($i=0; $i -lt $Arguments.Count; $i++) {
        $name = [string]$Arguments[$i]
        if ($name -match '^(?i)-(Help|ReEnroll)$') {
            $key = $matches[1]; if ($seen.ContainsKey($key)) { throw 'duplicate native argument' }
            $seen[$key]=$true; $result[$key]=$true; continue
        }
        if ($name -notmatch '^(?i)-(EnrollmentToken|ApiBaseUrl|GatewayUrl)$' -or $i+1 -ge $Arguments.Count) { throw 'invalid native argument' }
        $key = $matches[1]; if ($seen.ContainsKey($key)) { throw 'duplicate native argument' }
        $seen[$key]=$true; $value=[string]$Arguments[++$i]
        if ([string]::IsNullOrWhiteSpace($value) -or $value -match '[\x00-\x1f\x7f]') { throw 'invalid native argument' }
        if ($key -ieq 'EnrollmentToken') { $result.Token=$value } else { $result[$key]=$value }
    }
    foreach ($key in @('ApiBaseUrl','GatewayUrl')) {
        $value=[string]$result[$key]; $uri=$null
        if ($value -ne $value.Trim() -or $value -match '[\x00-\x20\x7f\\?#]' -or $value -match '^https://[^/]*@' -or
            -not [Uri]::TryCreate($value,[UriKind]::Absolute,[ref]$uri) -or $uri.Scheme -cne 'https' -or
            [string]::IsNullOrWhiteSpace($uri.Host) -or $uri.Port -lt 1 -or $uri.Port -gt 65535 -or $uri.UserInfo) { throw 'invalid HTTPS pin' }
        if ($key -eq 'ApiBaseUrl' -and ($uri.AbsolutePath -ne '/' -or $value.EndsWith('/'))) { throw 'API must be an HTTPS origin' }
        if ($key -eq 'GatewayUrl' -and $uri.AbsolutePath -cne '/api/v1/write') { throw 'write URL must end in /api/v1/write' }
    }
    return [pscustomobject]$result
}

function Test-OpsGridNativeOwnedPath([string]$Path, [switch]$Directory) {
    if ($Directory) { if (-not (Test-OpsGridSafeDirectory $Path)) { throw 'unsafe managed directory' } }
    else {
        if (-not (Test-OpsGridSafeRegularFile $Path)) { throw 'unsafe managed file' }
        $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if ($item.PSObject.Properties['LinkType'] -and $item.LinkType) { throw 'linked managed file' }
    }
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $acl=Get-Acl -LiteralPath $Path -ErrorAction Stop
    $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if (@('S-1-5-18','S-1-5-32-544') -notcontains $owner) { throw 'managed path must be owned by SYSTEM or Administrators' }
    $writes=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
            @('S-1-5-18','S-1-5-32-544') -notcontains $rule.IdentityReference.Value -and ($rule.FileSystemRights -band $writes)) { throw 'managed path allows untrusted writes' }
    }
}

function Get-OpsGridNativeAsset([string]$Name,[string]$Destination) {
    # HTTPS origin and HTTPS-only redirects. Do not weaken certificate validation.
    $handler=New-Object Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect=$false
    $client=New-Object Net.Http.HttpClient($handler)
    $client.Timeout=[TimeSpan]::FromMinutes(3)
    try {
        $url=[Uri]($script:NativeReleaseUrl+'/'+$Name)
        for ($redirect=0; $redirect -le 5; $redirect++) {
            if ($url.Scheme -cne 'https' -or $url.UserInfo) { throw 'unsafe release redirect' }
            $response=$client.GetAsync($url).GetAwaiter().GetResult()
            try {
                if ([int]$response.StatusCode -in @(301,302,303,307,308)) {
                    $url=[Uri]::new($url,$response.Headers.Location); continue
                }
                $null=$response.EnsureSuccessStatusCode()
                [IO.File]::WriteAllBytes($Destination,$response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult())
                if ((Get-Item -LiteralPath $Destination).Length -le 0) { throw 'empty release asset' }
                return
            } finally { $response.Dispose() }
        }
        throw 'too many release redirects'
    } finally { $client.Dispose(); $handler.Dispose() }
}

function Test-OpsGridNativeService($Service,[string]$Binary,[string]$State) {
    # Native installService persists these flags plus --service-name. No --config.
    $expected='"'+$Binary+'" --opsgrid-managed --state-dir '+$State+' --service-name opsgrid-agent'
    $unquoted=$Binary+' --opsgrid-managed --state-dir '+$State+' --service-name opsgrid-agent'
    if ($Service.StartName -ne 'LocalSystem' -or ($Service.PathName -cne $expected -and $Service.PathName -cne $unquoted)) { throw 'unrecognized existing native service registration' }
}

function Invoke-OpsGridTelegraf([string[]]$Arguments) {
    $bootstrapToken=[Environment]::GetEnvironmentVariable('OPSGRID_ENROLLMENT_TOKEN','Process')
    [Environment]::SetEnvironmentVariable('OPSGRID_ENROLLMENT_TOKEN',$null,'Process')
    $temp=$null; $lock=$null; $token=$null; $native=$null; $alloy=$null
    $oldActive=$false; $nativeActive=$false; $nativeStartMode=$null; $alloyStartMode=$null
    $mutated=$false; $committed=$false; $dispatched=$false; $binaryExisted=$false; $createdService=$false
    $acls=New-Object System.Collections.Generic.List[object]
    $state='C:\ProgramData\OpsGrid'; $binDir=Join-Path $state 'native'; $binary=Join-Path $binDir 'opsgrid-agent.exe'
    $code=10
    try {
        $parsed=Get-OpsGridNativeArguments $Arguments
        if ($parsed.Help) {
            Write-OpsGridLog 'Usage: install.ps1 [-EnrollmentToken ENR_CODE] [-ApiBaseUrl HTTPS_ORIGIN] [-GatewayUrl HTTPS_WRITE_URL] [-ReEnroll]'
            Write-OpsGridLog 'Prefer temporary OPSGRID_ENROLLMENT_TOKEN or protected prompt. Explicit token arguments may remain in initial process argv/history; native/service argv contain no token.'
            $script:NativeExitCode=0; return
        }
        $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
        $principal=New-Object Security.Principal.WindowsPrincipal($identity)
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or
            -not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -notin @('AMD64','x86')) { throw 'Windows AMD64 and Administrator required' }
        Add-Type -AssemblyName System.Net.Http
        [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
        $temp=Join-Path ([IO.Path]::GetTempPath()) ('opsgrid-native-'+[guid]::NewGuid().ToString('N'))
        if (-not (Test-OpsGridSafeDirectory $temp)) { throw 'unsafe temporary parent' }
        $null=[IO.Directory]::CreateDirectory($temp); Set-OpsGridDirectoryAcl $temp
        # Fetch the fixed trusted HTTPS manifest before executing any custom binary.
        $code=20
        Get-OpsGridNativeAsset 'release-manifest.json' (Join-Path $temp 'release-manifest.json')
        $manifest=[IO.File]::ReadAllText((Join-Path $temp 'release-manifest.json')) | ConvertFrom-Json
        if ($manifest.schemaVersion -ne 1 -or $manifest.collector -cne 'telegraf' -or $manifest.buildID -cne $script:NativeBuildID) { throw 'wrong native release' }
        $entries=@($manifest.native | Where-Object { $_.target -ceq 'windows-amd64' })
        if ($entries.Count -ne 1) { throw 'native target missing or duplicate' }
        $entry=$entries[0]; $expectedHash='f9136038fccb20680e99e6fc3cd804ed18ec63d97a7bc28ab384595a23596a9c'
        if ($entry.binary -cne 'opsgrid-agent-windows-amd64.exe' -or $entry.sha256 -cne $expectedHash -or $entry.provenance.customLifecycleImplemented -ne $true) { throw 'wrong native artifact' }
        $names=@('opsgrid-agent-windows-amd64.exe','windows-amd64.build-identity.json','windows-amd64.LICENSE.telegraf','windows-amd64.metrics-contract.json','LICENSE_OF_DEPENDENCIES.telegraf.md')
        if ($entry.dependenciesLicense -cne $names[4]) { throw 'wrong dependency notice name' }
        if ($entry.buildIdentity -cne $names[1] -or $entry.license -cne $names[2] -or $entry.metricsContract -cne $names[3]) { throw 'wrong native metadata names' }
        foreach ($name in $names) {
            $asset=@($manifest.assets | Where-Object { $_.name -ceq $name })
            if ($asset.Count -ne 1 -or $asset[0].sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'invalid asset hash' }
            $destination=Join-Path $temp $name
            Get-OpsGridNativeAsset $name $destination
            if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -cne $asset[0].sha256) { throw 'release hash mismatch' }
        }
        if ((Get-FileHash -LiteralPath (Join-Path $temp $names[0]) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedHash) { throw 'native hash mismatch' }
        Test-OpsGridNativeOwnedPath $state -Directory
        if ([IO.Directory]::Exists($state)) {
            $acls.Add([pscustomobject]@{Path=$state; Sddl=(Get-Acl -LiteralPath $state).Sddl; Directory=$true})
            foreach ($file in @(Get-ChildItem -LiteralPath $state -Force)) {
                if ($file.Name -eq 'native') { Test-OpsGridNativeOwnedPath $file.FullName -Directory; continue }
                # Preserve only the known installer-owned legacy config directory; never take over its descendants.
                if ($file.Name -eq 'Alloy') { Test-OpsGridNativeOwnedPath $file.FullName -Directory; continue }
                if (@('agent.credential','identity.json','config-state.json','current.toml','candidate.toml','previous.toml','runtime.lock','install.lock') -notcontains $file.Name) { throw 'unknown managed state entry; operator review required' }
                Test-OpsGridNativeOwnedPath $file.FullName
                $acls.Add([pscustomobject]@{Path=$file.FullName; Sddl=(Get-Acl -LiteralPath $file.FullName).Sddl; Directory=$false})
            }
        }
        # Acquire the existing authoritative installer file lock before service/ACL mutation.
        if (-not [IO.Directory]::Exists($state)) { $null=[IO.Directory]::CreateDirectory($state); Set-OpsGridDirectoryAcl $state }
        $lockPath=Join-Path $state 'install.lock'
        if (-not [IO.File]::Exists($lockPath)) {
            $probe=[IO.File]::Open($lockPath,'CreateNew','ReadWrite','None'); $probe.Dispose(); Set-OpsGridFileAcl $lockPath
        }
        Test-OpsGridNativeOwnedPath $lockPath
        $lock=[IO.File]::Open($lockPath,'Open','ReadWrite','None')
        Test-OpsGridNativeOwnedPath $binDir -Directory
        if ([IO.Directory]::Exists($binDir)) {
            foreach ($file in @(Get-ChildItem -LiteralPath $binDir -Force)) {
                if (@('opsgrid-agent.exe','windows-amd64.build-identity.json','windows-amd64.LICENSE.telegraf','windows-amd64.metrics-contract.json','LICENSE_OF_DEPENDENCIES.telegraf.md') -notcontains $file.Name) { throw 'unknown native binary directory entry' }
                Test-OpsGridNativeOwnedPath $file.FullName
            }
        }
        if (Test-Path -LiteralPath $binary) {
            Test-OpsGridNativeOwnedPath $binary
            if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedHash) { throw 'unrecognized existing native binary' }
            [IO.File]::Copy($binary,(Join-Path $temp 'native.previous')); $binaryExisted=$true
        }
        $native=Get-CimInstance Win32_Service -Filter "Name='opsgrid-agent'" -ErrorAction Stop
        $alloy=Get-CimInstance Win32_Service -Filter "Name='Alloy'" -ErrorAction Stop
        if ($native) { Test-OpsGridNativeService $native $binary $state; $nativeActive=($native.State -eq 'Running'); $nativeStartMode=$native.StartMode }
        if ($alloy) { $oldActive=($alloy.State -eq 'Running'); $alloyStartMode=$alloy.StartMode }
        $code=40
        $mutated=$true
        if ($alloy -and $alloy.State -ne 'Stopped') { Stop-Service -Name Alloy -ErrorAction Stop; (Get-Service Alloy).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(120)) }
        if ($native -and $native.State -ne 'Stopped') { Stop-Service -Name opsgrid-agent -ErrorAction Stop; (Get-Service opsgrid-agent).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(120)) }
        $null=[IO.Directory]::CreateDirectory($state); Set-OpsGridDirectoryAcl $state
        Set-OpsGridFileAcl $lockPath
        foreach ($item in $acls) { if (-not $item.Directory -and $item.Path -ne $lockPath) { Set-OpsGridFileAcl $item.Path } }
        $null=[IO.Directory]::CreateDirectory($binDir); Set-OpsGridDirectoryAcl $binDir
        $staged=Join-Path $binDir ('.native-'+[guid]::NewGuid().ToString('N')+'.tmp')
        [IO.File]::Copy((Join-Path $temp $names[0]),$staged); Set-OpsGridFileAcl $staged
        Invoke-OpsGridAtomicReplace $staged $binary; Set-OpsGridFileAcl $binary
        foreach ($name in $names[1..4]) {
            $destination=Join-Path $binDir $name
            if (Test-Path -LiteralPath $destination) { Test-OpsGridNativeOwnedPath $destination }
            [IO.File]::Copy((Join-Path $temp $name),$destination,$true); Set-OpsGridFileAcl $destination
        }
        $code=50
        if (-not $native) {
            & $binary --opsgrid-managed --state-dir $state --service-name opsgrid-agent service install --display-name 'OpsGrid native Telegraf collector'
            if ($LASTEXITCODE -ne 0) { throw 'native service registration failed' }
            $createdService=$true
        }
        Test-OpsGridNativeService (Get-CimInstance Win32_Service -Filter "Name='opsgrid-agent'") $binary $state
        # Register and check files/service before consuming the one-use code.
        $enroll=@('opsgrid-enroll','--api-url',$parsed.ApiBaseUrl,'--metrics-url',$parsed.GatewayUrl,'--state-dir',$state,'--token-stdin')
        if ($parsed.ReEnroll) { $enroll+='--re-enroll' }
        $code=30
        if (-not $parsed.ReEnroll -and [IO.File]::Exists((Join-Path $state 'identity.json'))) {
            # Empty stdin: native early-return validates/reuses identity without control enrollment.
            $token=''
        } else {
            $token=$parsed.Token
            if ([string]::IsNullOrEmpty($token)) { $token=$bootstrapToken }
            [Environment]::SetEnvironmentVariable('OPSGRID_ENROLLMENT_TOKEN',$null,'Process')
            if ([string]::IsNullOrEmpty($token) -and -not [Console]::IsInputRedirected) {
                $secure=Read-Host '[opsgrid-agent] One-use enrollment code' -AsSecureString
                $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
                try { $token=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr); $secure.Dispose() }
            }
            if ($token -cnotmatch '^ENR_[A-Za-z0-9_-]+$' -or $token.Length -gt 256) { throw 'bounded ENR code required' }
        }
        $psi=New-Object Diagnostics.ProcessStartInfo
        $psi.FileName=$binary; $psi.UseShellExecute=$false; $psi.RedirectStandardInput=$true
        # Each non-secret argument is quoted; pins reject quotes and controls below.
        foreach ($value in $enroll) { if ($value.Contains('"') -or $value.Contains("`r") -or $value.Contains("`n")) { throw 'invalid native argument' } }
        $psi.Arguments=($enroll | ForEach-Object { '"'+$_+'"' }) -join ' '
        $process=New-Object Diagnostics.Process; $process.StartInfo=$psi
        if ($token) { $dispatched=$true }
        try {
            if (-not $process.Start()) { throw 'native enrollment did not start' }
            if ($token) { $process.StandardInput.Write($token) }
            $process.StandardInput.Close(); $process.WaitForExit()
            if ($process.ExitCode -ne 0) { throw 'native enrollment/reuse failed' }
        } finally { $process.Dispose(); $token=$null; $parsed=$null }
        $code=50
        Set-Service -Name opsgrid-agent -StartupType Automatic -ErrorAction Stop
        Start-Service -Name opsgrid-agent -ErrorAction Stop
        (Get-Service opsgrid-agent).WaitForStatus('Running',[TimeSpan]::FromSeconds(120))
        if ($alloy) { Set-Service -Name Alloy -StartupType Disabled -ErrorAction Stop }
        $committed=$true
        Write-OpsGridLog 'Native service startup confirmed; bootstrap exits. Service Running is not metrics delivery/applied revision proof.'
        $script:NativeExitCode=0; return
    } catch {
        Write-OpsGridLog ('Native bootstrap failed at stage '+$code+'; no secret/error payload is logged.')
        if ($mutated -and -not $committed) {
            try {
                $current=Get-Service opsgrid-agent -ErrorAction SilentlyContinue
                if ($current -and $current.Status -ne 'Stopped') { Stop-Service opsgrid-agent -ErrorAction Stop; $current.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(120)) }
                if ($binaryExisted) { [IO.File]::Copy((Join-Path $temp 'native.previous'),$binary,$true); Set-OpsGridFileAcl $binary }
                if ($current) { Set-Service opsgrid-agent -StartupType Disabled -ErrorAction Stop }
                if (-not $dispatched) {
                    if ($lock) { $lock.Dispose(); $lock=$null }
                    for ($i=$acls.Count-1; $i -ge 0; $i--) { $item=$acls[$i]; Set-OpsGridAclFromSddl -Path $item.Path -Sddl $item.Sddl -Directory:$item.Directory }
                    if ($native) { Set-Service opsgrid-agent -StartupType $(if ($nativeStartMode -eq 'Auto') {'Automatic'} elseif ($nativeStartMode -eq 'Disabled') {'Disabled'} else {'Manual'}); if ($nativeActive) { Start-Service opsgrid-agent -ErrorAction Stop } }
                    if ($alloy) { Set-Service Alloy -StartupType $(if ($alloyStartMode -eq 'Auto') {'Automatic'} elseif ($alloyStartMode -eq 'Disabled') {'Disabled'} else {'Manual'}); if ($oldActive) { Start-Service Alloy -ErrorAction Stop } }
                } else {
                    if ($alloy) { Set-Service Alloy -StartupType Disabled -ErrorAction Stop }
                    Write-OpsGridLog 'Enrollment may have committed remotely; protected credential/identity retained and collectors stopped/disabled. Operator recovery required; do not blindly retry a consumed code.'
                }
            } catch { Write-OpsGridLog 'Local activation rollback incomplete; operator recovery required.' }
        }
        $script:NativeExitCode=$code; return
    } finally {
        if ($lock) { $lock.Dispose() }
        [Environment]::SetEnvironmentVariable('OPSGRID_ENROLLMENT_TOKEN',$null,'Process')
        $token=$null; $Arguments=$null
        if ($temp -and [IO.Directory]::Exists($temp)) {
            try {
                if (-not (Test-OpsGridSafeDirectory $temp)) { throw 'unsafe cleanup path' }
                foreach ($file in @(Get-ChildItem -LiteralPath $temp -Force)) { if (-not (Test-OpsGridSafeRegularFile $file.FullName)) { throw 'unsafe cleanup file' } }
                Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction Stop
            } catch { Write-OpsGridLog 'Private bootstrap temporary cleanup failed.' }
        }
    }
}
