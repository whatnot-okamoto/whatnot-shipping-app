param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$NODE_PATH = "C:\Program Files\nodejs\node.exe"
$PROCESS_WATCHDOG_MS = 180000
$POST_KILL_WAIT_MS = 10000
$CONFIRMATION_ARGUMENT = "--confirm-fixed-transport"

$fixedResults = @{
    "PASS_TRANSPORT_TLS" = 0
    "STOP_TRANSPORT_DNS" = 40
    "STOP_TRANSPORT_TCP" = 41
    "STOP_TRANSPORT_TLS" = 42
    "STOP_TRANSPORT_TIMEOUT" = 43
    "STOP_TRANSPORT_INDETERMINATE" = 44
}
$WRAPPER_INDETERMINATE_CLASSIFICATION = "STOP_TRANSPORT_WRAPPER_INDETERMINATE"
$WRAPPER_INDETERMINATE_EXIT_CODE = 45

$finalClassification = "STOP_RUNTIME_BOUNDARY"
$finalExitCode = 13
$processStarted = $false
$urlSecure = $null
$urlBstr = [IntPtr]::Zero
$urlPlain = $null
$startInfo = $null
$childProcess = $null
$stdoutTask = $null
$stderrTask = $null
$capturedStdout = $null
$capturedStderr = $null

function Test-FixedTransportUrl {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Url
    )

    if (
        [string]::IsNullOrWhiteSpace($Url) -or
        [char]::IsWhiteSpace($Url[0]) -or
        [char]::IsWhiteSpace($Url[$Url.Length - 1]) -or
        $Url.Contains("`r") -or
        $Url.Contains("`n") -or
        $Url.IndexOf(
            "UPSTASH_REDIS_REST_URL=",
            [System.StringComparison]::OrdinalIgnoreCase
        ) -ge 0
    ) {
        return $false
    }

    if ($Url.Length -ge 2) {
        $first = $Url[0]
        $last = $Url[$Url.Length - 1]
        if (
            ($first -eq '"' -and $last -eq '"') -or
            ($first -eq "'" -and $last -eq "'")
        ) {
            return $false
        }
    }

    $parsedUrl = $null
    if (
        -not [System.Uri]::TryCreate(
            $Url,
            [System.UriKind]::Absolute,
            [ref]$parsedUrl
        ) -or
        $parsedUrl.Scheme -cne [System.Uri]::UriSchemeHttps -or
        -not [string]::IsNullOrEmpty($parsedUrl.UserInfo) -or
        -not [string]::IsNullOrEmpty($parsedUrl.Query) -or
        -not [string]::IsNullOrEmpty($parsedUrl.Fragment) -or
        $parsedUrl.Port -ne 443 -or
        [string]::IsNullOrEmpty($parsedUrl.DnsSafeHost)
    ) {
        return $false
    }

    return $true
}

try {
    if ($args.Count -ne 0) {
        throw [System.InvalidOperationException]::new("Fixed launcher arguments are not allowed.")
    }
    if (
        $PSVersionTable.PSEdition -ne "Core" -or
        $PSVersionTable.PSVersion.Major -lt 7 -or
        [System.Diagnostics.ProcessStartInfo].GetProperty("ArgumentList") -eq $null
    ) {
        throw [System.InvalidOperationException]::new("Fixed PowerShell runtime is unavailable.")
    }

    $repositoryRoot = [System.IO.Path]::GetFullPath(
        [System.IO.Path]::Combine($PSScriptRoot, "..")
    )
    $loaderPath = [System.IO.Path]::Combine(
        $repositoryRoot,
        "scripts",
        "upstash-transport-cli-loader.mjs"
    )
    $cliPath = [System.IO.Path]::Combine(
        $repositoryRoot,
        "scripts",
        "probe-upstash-transport.mjs"
    )

    if (
        -not [System.IO.File]::Exists($NODE_PATH) -or
        -not [System.IO.Directory]::Exists($repositoryRoot) -or
        -not [System.IO.File]::Exists($loaderPath) -or
        -not [System.IO.File]::Exists($cliPath)
    ) {
        throw [System.InvalidOperationException]::new("Fixed runtime boundary is unavailable.")
    }

    $urlSecure = Read-Host -Prompt "UPSTASH_REDIS_REST_URL (hidden)" -AsSecureString
    if ($urlSecure.Length -eq 0) {
        throw [System.InvalidOperationException]::new("A required value is empty.")
    }

    $urlBstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($urlSecure)
    $urlPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($urlBstr)
    if (-not (Test-FixedTransportUrl -Url $urlPlain)) {
        throw [System.InvalidOperationException]::new("Fixed input boundary rejected the supplied value.")
    }

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $NODE_PATH
    $startInfo.WorkingDirectory = $repositoryRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.Environment.Clear()
    $startInfo.Environment.Add("UPSTASH_REDIS_REST_URL", $urlPlain)

    $startInfo.ArgumentList.Add("--no-warnings")
    $startInfo.ArgumentList.Add("--experimental-loader")
    $startInfo.ArgumentList.Add("./scripts/upstash-transport-cli-loader.mjs")
    $startInfo.ArgumentList.Add("./scripts/probe-upstash-transport.mjs")
    $startInfo.ArgumentList.Add($CONFIRMATION_ARGUMENT)

    $childProcess = [System.Diagnostics.Process]::new()
    $childProcess.StartInfo = $startInfo
    if (-not $childProcess.Start()) {
        throw [System.InvalidOperationException]::new("Fixed child did not start.")
    }
    $processStarted = $true
    $finalClassification = $WRAPPER_INDETERMINATE_CLASSIFICATION
    $finalExitCode = $WRAPPER_INDETERMINATE_EXIT_CODE

    $stdoutTask = $childProcess.StandardOutput.ReadToEndAsync()
    $stderrTask = $childProcess.StandardError.ReadToEndAsync()
    $childProcess.StandardInput.Close()

    if (-not $childProcess.WaitForExit($PROCESS_WATCHDOG_MS)) {
        $childExitConfirmed = $false
        try {
            $childProcess.Kill()
        }
        catch {
            # Keep the fixed wrapper-indeterminate result.
        }
        try {
            $childExitConfirmed = $childProcess.WaitForExit($POST_KILL_WAIT_MS)
        }
        catch {
            # Keep the fixed wrapper-indeterminate result.
        }
        if (-not $childExitConfirmed) {
            throw [System.TimeoutException]::new("Fixed child termination was not confirmed.")
        }
        throw [System.TimeoutException]::new("Fixed child watchdog elapsed.")
    }

    $capturedStdout = $stdoutTask.GetAwaiter().GetResult()
    $capturedStderr = $stderrTask.GetAwaiter().GetResult()
    if ($capturedStderr.Length -ne 0) {
        throw [System.InvalidOperationException]::new("Fixed child wrote stderr.")
    }

    $candidate = $capturedStdout
    if (-not $candidate.EndsWith("`n") -or $candidate.Contains("`r")) {
        throw [System.InvalidOperationException]::new("Fixed child output was malformed.")
    }
    $candidate = $candidate.Substring(0, $candidate.Length - 1)
    if (
        $candidate.Contains("`n") -or
        -not ($fixedResults.Keys -ccontains $candidate)
    ) {
        throw [System.InvalidOperationException]::new("Fixed child output was unknown.")
    }
    if ($childProcess.ExitCode -ne $fixedResults[$candidate]) {
        throw [System.InvalidOperationException]::new("Fixed child exit code did not match.")
    }

    $finalClassification = $candidate
    $finalExitCode = $fixedResults[$candidate]
}
catch {
    if ($processStarted) {
        try {
            if ($childProcess -ne $null -and -not $childProcess.HasExited) {
                $childProcess.Kill()
                $null = $childProcess.WaitForExit($POST_KILL_WAIT_MS)
            }
        }
        catch {
            # Keep the fixed wrapper-indeterminate result.
        }
        $finalClassification = $WRAPPER_INDETERMINATE_CLASSIFICATION
        $finalExitCode = $WRAPPER_INDETERMINATE_EXIT_CODE
    }
    else {
        $finalClassification = "STOP_RUNTIME_BOUNDARY"
        $finalExitCode = 13
    }
}
finally {
    if ($startInfo -ne $null) {
        try { $startInfo.Environment.Clear() } catch {}
    }
    if ($urlBstr -ne [IntPtr]::Zero) {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($urlBstr)
        $urlBstr = [IntPtr]::Zero
    }
    if ($urlSecure -ne $null) {
        try { $urlSecure.Dispose() } catch {}
    }
    if ($childProcess -ne $null) {
        try { $childProcess.StandardInput.Dispose() } catch {}
        try { $childProcess.StandardOutput.Dispose() } catch {}
        try { $childProcess.StandardError.Dispose() } catch {}
        try { $childProcess.Dispose() } catch {}
    }

    $urlPlain = $null
    $capturedStdout = $null
    $capturedStderr = $null
    $stdoutTask = $null
    $stderrTask = $null
    $childProcess = $null
    $startInfo = $null
    $urlSecure = $null
}

[Console]::Out.WriteLine($finalClassification)
exit $finalExitCode
