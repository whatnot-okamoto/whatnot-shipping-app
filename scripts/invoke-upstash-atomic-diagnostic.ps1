param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$NODE_PATH = "C:\Program Files\nodejs\node.exe"
$PROCESS_WATCHDOG_MS = 180000
$POST_KILL_WAIT_MS = 10000
$CONFIRMATION_ARGUMENT = "--confirm-fixed-diagnostic"

$fixedResults = @{
    "PASS_ATOMIC_CONTRACT" = 0
    "STOP_DIAGNOSTIC_KEYS_PRESENT" = 10
    "STOP_CONTRACT_MISMATCH" = 11
    "STOP_ATOMIC_INDETERMINATE" = 12
    "STOP_RUNTIME_BOUNDARY" = 13
}

$finalClassification = "STOP_RUNTIME_BOUNDARY"
$finalExitCode = 13
$processStarted = $false
$urlSecure = $null
$tokenSecure = $null
$urlBstr = [IntPtr]::Zero
$tokenBstr = [IntPtr]::Zero
$urlPlain = $null
$tokenPlain = $null
$startInfo = $null
$childProcess = $null
$stdoutTask = $null
$stderrTask = $null
$capturedStdout = $null
$capturedStderr = $null

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
        "upstash-atomic-cli-loader.mjs"
    )
    $cliPath = [System.IO.Path]::Combine(
        $repositoryRoot,
        "scripts",
        "diagnose-upstash-atomic.mjs"
    )
    $commonPath = [System.IO.Path]::Combine(
        $repositoryRoot,
        "scripts",
        "upstash-atomic-launcher-common.ps1"
    )

    if (
        -not [System.IO.File]::Exists($NODE_PATH) -or
        -not [System.IO.Directory]::Exists($repositoryRoot) -or
        -not [System.IO.File]::Exists($loaderPath) -or
        -not [System.IO.File]::Exists($cliPath) -or
        -not [System.IO.File]::Exists($commonPath)
    ) {
        throw [System.InvalidOperationException]::new("Fixed runtime boundary is unavailable.")
    }
    . $commonPath

    $urlSecure = Read-Host -Prompt "UPSTASH_REDIS_REST_URL (hidden)" -AsSecureString
    if ($urlSecure.Length -eq 0) {
        throw [System.InvalidOperationException]::new("A required value is empty.")
    }
    $tokenSecure = Read-Host -Prompt "UPSTASH_REDIS_REST_TOKEN (hidden)" -AsSecureString
    if ($tokenSecure.Length -eq 0) {
        throw [System.InvalidOperationException]::new("A required value is empty.")
    }

    $urlBstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($urlSecure)
    $urlPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($urlBstr)
    $tokenBstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($tokenSecure)
    $tokenPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenBstr)
    if (-not (Test-FixedUpstashLauncherInput -Url $urlPlain -Token $tokenPlain)) {
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
    $startInfo.Environment.Add("APP_ENVIRONMENT", "development")
    $startInfo.Environment.Add("BASE_DATA_MODE", "readonly")
    $startInfo.Environment.Add("APP_STORE_MODE", "upstash")
    $startInfo.Environment.Add("VERCEL_ENV", "preview")
    $startInfo.Environment.Add("VERCEL_GIT_COMMIT_REF", "codex/development")
    $startInfo.Environment.Add("UPSTASH_REDIS_REST_URL", $urlPlain)
    $startInfo.Environment.Add("UPSTASH_REDIS_REST_TOKEN", $tokenPlain)

    $startInfo.ArgumentList.Add("--no-warnings")
    $startInfo.ArgumentList.Add("--experimental-strip-types")
    $startInfo.ArgumentList.Add("--experimental-loader")
    $startInfo.ArgumentList.Add("./scripts/upstash-atomic-cli-loader.mjs")
    $startInfo.ArgumentList.Add("./scripts/diagnose-upstash-atomic.mjs")
    $startInfo.ArgumentList.Add($CONFIRMATION_ARGUMENT)

    $childProcess = [System.Diagnostics.Process]::new()
    $childProcess.StartInfo = $startInfo
    if (-not $childProcess.Start()) {
        throw [System.InvalidOperationException]::new("Fixed child did not start.")
    }
    $processStarted = $true
    $finalClassification = "STOP_ATOMIC_INDETERMINATE"
    $finalExitCode = 12

    $stdoutTask = $childProcess.StandardOutput.ReadToEndAsync()
    $stderrTask = $childProcess.StandardError.ReadToEndAsync()
    $childProcess.StandardInput.Close()

    if (-not $childProcess.WaitForExit($PROCESS_WATCHDOG_MS)) {
        $childExitConfirmed = $false
        try {
            $childProcess.Kill()
        }
        catch {
            # Preserve the fixed indeterminate result without exposing details.
        }
        try {
            $childExitConfirmed = $childProcess.WaitForExit($POST_KILL_WAIT_MS)
        }
        catch {
            # Preserve the fixed indeterminate result without exposing details.
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
            # Preserve the fixed indeterminate result without exposing details.
        }
        $finalClassification = "STOP_ATOMIC_INDETERMINATE"
        $finalExitCode = 12
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
    if ($tokenBstr -ne [IntPtr]::Zero) {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenBstr)
        $tokenBstr = [IntPtr]::Zero
    }
    if ($urlSecure -ne $null) {
        try { $urlSecure.Dispose() } catch {}
    }
    if ($tokenSecure -ne $null) {
        try { $tokenSecure.Dispose() } catch {}
    }
    if ($childProcess -ne $null) {
        try { $childProcess.StandardInput.Dispose() } catch {}
        try { $childProcess.StandardOutput.Dispose() } catch {}
        try { $childProcess.StandardError.Dispose() } catch {}
        try { $childProcess.Dispose() } catch {}
    }

    $urlPlain = $null
    $tokenPlain = $null
    $capturedStdout = $null
    $capturedStderr = $null
    $stdoutTask = $null
    $stderrTask = $null
    $childProcess = $null
    $startInfo = $null
    $urlSecure = $null
    $tokenSecure = $null
}

[Console]::Out.WriteLine($finalClassification)
exit $finalExitCode
