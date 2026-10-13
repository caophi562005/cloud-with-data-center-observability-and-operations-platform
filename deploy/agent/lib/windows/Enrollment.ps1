# Internal installer declarations; dot-sourced by the guarded entrypoint.
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
    $dispatched = $false
    try {
        $uri = Test-ApiBaseUrl -Value $BaseUrl
        $payload = @{ token = $Token }
        if (-not [string]::IsNullOrWhiteSpace($Os)) { $payload.os = $Os }
        $requestBody = $payload | ConvertTo-Json -Compress
        $endpoint = $uri.AbsoluteUri.TrimEnd('/') + '/api/v1/agent-enrollment'
        # Enrollment consumes a one-time token. Transport/HTTP failure cannot
        # prove the server did not commit; dispatch exactly once, never retry.
        $dispatched = $true
        $script:OpsGridEnrollmentDispatched = $true
        $response = Invoke-RestMethod -Method Post -Uri $endpoint -ContentType 'application/json' -Body $requestBody -TimeoutSec 30 -MaximumRedirection 0 -ErrorAction Stop
        if (-not (Test-EnrollmentResponse $response)) { Fail-OpsGrid 30 'enrollment outcome unknown; split state possible; operator recovery required; do not retry enrollment' }
        $script:OpsGridEnrollmentSucceeded = $true
        return $response
    }
    catch {
        if ($script:OpsGridFailureCode -eq 30 -and $_.Exception.Message -eq $script:OpsGridFailureMarker) { throw }
        if ($dispatched) { Fail-OpsGrid 30 'enrollment outcome unknown; split state possible; operator recovery required; do not retry enrollment' }
        Fail-OpsGrid 30 'enrollment failed before dispatch'
    }
    finally {
        $requestBody = $null
        $Token = $null
        $Os = $null
        $BaseUrl = $null
    }
}
