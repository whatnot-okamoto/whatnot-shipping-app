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

function Get-M1InspectLimits {
    # Three serial requests at 15 seconds each, plus 15 seconds for Node/loader/local work.
    # These are fixed operator limits, not parameters or environment overrides.
    return @{ RuntimeMs = 60000; StopMs = 5000; PollMs = 20; OutChars = 2048; ErrChars = 128 }
}

function Stop-M1InspectChild($Child, [int] $LimitMs) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    # Kill the owned process tree; an already exited process can throw here.
    try { $Child.Kill($true) } catch { }
    try {
        $remaining = [Math]::Max(0, $LimitMs - [int] $clock.ElapsedMilliseconds)
        return $Child.WaitForExit($remaining)
    } catch { return $false }
    finally { $clock.Stop() }
}

function Invoke-M1InspectChild($Child) {
    $limits = Get-M1InspectLimits
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $mayBeRunning = $false; $streams = @(); $failure = 'M1_LAUNCHER_FAILED'
    try {
        # A throwing Start is ambiguous: attempt bounded termination as well.
        $mayBeRunning = $true
        if (-not $Child.Start()) { $mayBeRunning = $false; throw 'M1_LAUNCHER_FAILED' }
        $Child.StandardInput.Close()
        foreach ($spec in @(@($Child.StandardOutput, $limits.OutChars), @($Child.StandardError, $limits.ErrChars))) {
            $stream = @{ Reader = $spec[0]; Limit = $spec[1]; Buffer = [char[]]::new([Math]::Min(256, $spec[1] + 1));
                Text = [Text.StringBuilder]::new(); Task = $null; Eof = $false }
            $streams += $stream
            $stream.Task = $stream.Reader.ReadAsync($stream.Buffer, 0, $stream.Buffer.Length)
        }
        while ($true) {
            if ($clock.ElapsedMilliseconds -ge $limits.RuntimeMs) {
                $failure = 'M1_LAUNCHER_TIMEOUT'; throw 'M1_LAUNCHER_FAILED'
            }
            foreach ($stream in $streams) {
                if (-not $stream.Eof -and $stream.Task.IsCompleted) {
                    # GetResult only on completed tasks; no indefinite pipe read or wait.
                    $read = $stream.Task.GetAwaiter().GetResult()
                    if ($read -eq 0) { $stream.Eof = $true; continue }
                    if ($stream.Text.Length + $read -gt $stream.Limit) {
                        $failure = 'M1_LAUNCHER_OUTPUT_LIMIT'; throw 'M1_LAUNCHER_FAILED'
                    }
                    [void] $stream.Text.Append($stream.Buffer, 0, $read)
                    # At most one character beyond the remaining budget, solely to detect overflow.
                    $next = [Math]::Min($stream.Buffer.Length, $stream.Limit - $stream.Text.Length + 1)
                    $stream.Task = $stream.Reader.ReadAsync($stream.Buffer, 0, $next)
                }
            }
            $exited = $Child.WaitForExit(0)
            if ($exited -and $streams[0].Eof -and $streams[1].Eof) {
                $result = @{ Code = $Child.ExitCode; Out = $streams[0].Text.ToString(); Err = $streams[1].Text.ToString() }
                $mayBeRunning = $false
                return $result
            }
            Start-Sleep -Milliseconds $limits.PollMs
        }
    } catch {
        if ($mayBeRunning -and -not (Stop-M1InspectChild $Child $limits.StopMs)) {
            $failure = 'M1_LAUNCHER_STOP_UNCONFIRMED'
        }
        # Discard even the bounded partial output. Never inspect or print exceptions.
        return @{ Code = 1; Out = ''; Err = $failure }
    } finally {
        $clock.Stop()
        foreach ($stream in $streams) {
            try { $stream.Reader.Dispose() } catch { }
            [void] $stream.Text.Clear()
            [Array]::Clear($stream.Buffer, 0, $stream.Buffer.Length)
            $stream.Task = $null; $stream.Reader = $null
        }
        $streams = @()
        # The caller removes StartInfo inputs and disposes only after this bounded termination check.
        # STOP_UNCONFIRMED means local cleanup is NOT evidence that the child stopped.
    }
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
        'M1_MIGRATION_CONFLICT', 'M1_VALUE_LIMIT', 'M1_RAW_RESPONSE', 'M1_MIGRATION_FAILED',
        'M1_LAUNCHER_FAILED', 'M1_LAUNCHER_TIMEOUT', 'M1_LAUNCHER_OUTPUT_LIMIT', 'M1_LAUNCHER_STOP_UNCONFIRMED')
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
