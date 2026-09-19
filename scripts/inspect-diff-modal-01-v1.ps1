# Interactive operator entry point; real execution requires separate approval.
# PowerShell 7+, no arguments, no pipeline or redirected console streams.
# Never dot-source this script to supply credentials. No dotenv or credential fallback.
$script:M1InspectDirectory = $PSScriptRoot

function Test-M1InteractiveConsole {
    return -not ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected -or [Console]::IsErrorRedirected)
}

function Read-M1HiddenValue([string] $Label, [int] $Limit) {
    $secret = [Security.SecureString]::new()
    try {
        [Console]::Write($Label + ': ')
        while ($true) {
            $key = [Console]::ReadKey($true)
            if ($key.Key -eq [ConsoleKey]::Enter) { break }
            if ($key.Key -eq [ConsoleKey]::Escape -or
                (($key.Modifiers -band [ConsoleModifiers]::Control) -and $key.Key -eq [ConsoleKey]::C)) {
                throw 'M1_LAUNCHER_FAILED'
            }
            if ($key.Key -eq [ConsoleKey]::Backspace) {
                if ($secret.Length -gt 0) { $secret.RemoveAt($secret.Length - 1) }
            } elseif ([char]::IsControl($key.KeyChar) -or $secret.Length -ge $Limit) {
                throw 'M1_LAUNCHER_FAILED'
            } else { $secret.AppendChar($key.KeyChar) }
        }
        [Console]::WriteLine()
        if ($secret.Length -eq 0) { throw 'M1_LAUNCHER_FAILED' }
        $secret.MakeReadOnly()
        return $secret
    } catch {
        $secret.Dispose()
        throw 'M1_LAUNCHER_FAILED'
    }
}

function Convert-M1HiddenValue([Security.SecureString] $Value) {
    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    }
}

function New-M1InspectChild {
    $node = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $node.Source
    $info.WorkingDirectory = Split-Path -Parent $script:M1InspectDirectory
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($argument in @('--no-warnings', '--experimental-strip-types', '--experimental-loader',
        './scripts/typescript-test-loader.mjs', './scripts/migrate-diff-modal-01-v1.mjs', 'inspect',
        '--url-env', 'M1_PRODUCTION_REDIS_URL', '--token-env', 'M1_PRODUCTION_REDIS_TOKEN')) {
        $info.ArgumentList.Add($argument)
    }
    # Inherit the usual environment implicitly, without enumerating or logging it.
    # Never use inherited values of the two input entries as a fallback.
    [void] $info.Environment.Remove('M1_PRODUCTION_REDIS_URL')
    [void] $info.Environment.Remove('M1_PRODUCTION_REDIS_TOKEN')
    $child = [Diagnostics.Process]::new()
    $child.StartInfo = $info
    return $child
}

function Invoke-M1InspectChild($Child) {
    if (-not $Child.Start()) { throw 'M1_LAUNCHER_FAILED' }
    # The child owns its environment copy from this point; remove the launcher copy promptly.
    [void] $Child.StartInfo.Environment.Remove('M1_PRODUCTION_REDIS_URL')
    [void] $Child.StartInfo.Environment.Remove('M1_PRODUCTION_REDIS_TOKEN')
    $Child.StandardInput.Close()
    $stdout = $Child.StandardOutput.ReadToEndAsync()
    $stderr = $Child.StandardError.ReadToEndAsync()
    $Child.WaitForExit()
    return @{ Code = $Child.ExitCode; Out = $stdout.GetAwaiter().GetResult(); Err = $stderr.GetAwaiter().GetResult() }
}

function Write-M1InspectResult($Result) {
    # Do not forward raw Node startup errors or unexpected child output.
    if ($Result.Code -eq 0 -and [string]::IsNullOrWhiteSpace($Result.Err) -and
        $Result.Out.Length -le 2048) {
        $value = ConvertFrom-Json -InputObject $Result.Out -AsHashtable -ErrorAction Stop
        $fields = @('status', 'version', 'source_bytes', 'source_fingerprint', 'migration_id')
        if ($value -isnot [Collections.IDictionary] -or $value.Count -ne 5) { throw 'M1_LAUNCHER_FAILED' }
        foreach ($field in $fields) { if (-not $value.Contains($field)) { throw 'M1_LAUNCHER_FAILED' } }
        if ($value.status -isnot [string] -or $value.status -cnotin @('legacy', 'preserved', 'prepared', 'adopted') -or
            $value.version -isnot [string] -or $value.version -cne 'diff-modal-01:v1' -or
            ($value.source_bytes -isnot [int] -and $value.source_bytes -isnot [long]) -or
            $value.source_bytes -lt 0 -or $value.source_bytes -gt 262144 -or
            $value.source_fingerprint -isnot [string] -or $value.source_fingerprint -cnotmatch '\A[a-f0-9]{64}\z') {
            throw 'M1_LAUNCHER_FAILED'
        }
        if ($value.status -ceq 'legacy') {
            if ($null -ne $value.migration_id) { throw 'M1_LAUNCHER_FAILED' }
        } elseif ($value.migration_id -isnot [string] -or
            $value.migration_id -cnotmatch '\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z') {
            throw 'M1_LAUNCHER_FAILED'
        }
        # Reconstruct only the five permitted scalars.
        $safe = [ordered]@{}
        foreach ($field in $fields) { $safe[$field] = $value[$field] }
        [Console]::Out.WriteLine(($safe | ConvertTo-Json -Compress))
        return 0
    }
    $codes = @('M1_CLI_COMMAND', 'M1_CLI_ARGUMENT', 'M1_CLI_EXPLICIT_TARGET_REQUIRED', 'M1_CLI_TARGET',
        'M1_CLI_CREDENTIAL_REQUIRED', 'M1_CLI_PREFLIGHT_REQUIRED', 'M1_CLI_LEASE_BUSY', 'M1_CLI_OUTPUT_INVALID',
        'M1_MIGRATION_RECORD_MISMATCH', 'M1_MIGRATION_ADOPTION_MISMATCH', 'M1_MIGRATION_SOURCE_MISSING',
        'M1_MIGRATION_SOURCE_CHANGED', 'M1_MIGRATION_SOURCE_SCHEMA', 'M1_MIGRATION_RECORD_LIMIT',
        'M1_MIGRATION_CONFLICT', 'M1_VALUE_LIMIT', 'M1_RAW_RESPONSE', 'M1_MIGRATION_FAILED')
    if ($Result.Code -eq 1 -and $Result.Out.Length -eq 0 -and
        $Result.Err.Length -le 128 -and $Result.Err.TrimEnd("`r", "`n") -cin $codes) {
        [Console]::Error.WriteLine($Result.Err.TrimEnd("`r", "`n"))
        return 1
    }
    throw 'M1_LAUNCHER_FAILED'
}

function Invoke-M1InspectLauncher {
    $child = $null; $urlSecret = $null; $tokenSecret = $null
    $endpoint = $null; $token = $null; $result = $null
    try {
        if ($PSVersionTable.PSVersion.Major -lt 7 -or -not (Test-M1InteractiveConsole)) { throw 'M1_LAUNCHER_FAILED' }
        $child = New-M1InspectChild
        $urlSecret = Read-M1HiddenValue 'Production REST URL (hidden)' 4096
        $tokenSecret = Read-M1HiddenValue 'Production REST token (hidden)' 8192
        $endpoint = Convert-M1HiddenValue $urlSecret
        $token = Convert-M1HiddenValue $tokenSecret
        $uri = $null
        if ([string]::IsNullOrWhiteSpace($endpoint) -or $endpoint -match '[\x00-\x20\x7f]' -or
            -not [Uri]::TryCreate($endpoint, [UriKind]::Absolute, [ref] $uri) -or
            $uri.Scheme -cne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or
            [string]::IsNullOrWhiteSpace($token) -or $token -match '[\r\n\x00]') { throw 'M1_LAUNCHER_FAILED' }
        $child.StartInfo.Environment['M1_PRODUCTION_REDIS_URL'] = $endpoint
        $child.StartInfo.Environment['M1_PRODUCTION_REDIS_TOKEN'] = $token
        $endpoint = $null; $token = $null; $uri = $null
        $urlSecret.Dispose(); $urlSecret = $null
        $tokenSecret.Dispose(); $tokenSecret = $null
        $result = Invoke-M1InspectChild $child
        return (Write-M1InspectResult $result)
    } catch {
        # Never inspect the exception message, invocation info, arguments or environment.
        [Console]::Error.WriteLine('M1_LAUNCHER_FAILED')
        return 1
    } finally {
        if ($null -ne $child) {
            [void] $child.StartInfo.Environment.Remove('M1_PRODUCTION_REDIS_URL')
            [void] $child.StartInfo.Environment.Remove('M1_PRODUCTION_REDIS_TOKEN')
            $child.Dispose()
        }
        if ($null -ne $urlSecret) { $urlSecret.Dispose() }
        if ($null -ne $tokenSecret) { $tokenSecret.Dispose() }
        $child = $null; $urlSecret = $null; $tokenSecret = $null
        $endpoint = $null; $token = $null; $uri = $null; $result = $null
        # References cleared; immutable managed strings / physical memory erasure is NOT guaranteed.
    }
}

# No parameter binding: even unexpected arguments must not be echoed by PowerShell's binder.
# Pipeline input is never consumed. Also reject dot-sourcing and all console redirection.
if ($args.Count -ne 0 -or $MyInvocation.ExpectingInput -or $MyInvocation.InvocationName -eq '.') {
    [Console]::Error.WriteLine('M1_LAUNCHER_ARGUMENT')
    exit 1
}
exit (Invoke-M1InspectLauncher)
