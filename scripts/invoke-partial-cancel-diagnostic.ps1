param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$NODE_PATH = "C:\Program Files\nodejs\node.exe"
$TOKEN_MAX_CHARACTERS = 4096
$STDOUT_MAX_BYTES = 16384
$STDERR_MAX_BYTES = 256
$PROCESS_WATCHDOG_MS = 180000
$POST_KILL_WAIT_MS = 10000

$childExitCodes = @{
    "PASS_ENUM_COMPLETE" = 0
    "STOP_ENUM_INDETERMINATE" = 20
    "STOP_RUNTIME_BOUNDARY" = 21
    "STOP_INPUT" = 22
    "STOP_TIMEOUT" = 23
    "STOP_TRANSPORT" = 24
    "STOP_HTTP" = 25
    "STOP_RESPONSE_TOO_LARGE" = 26
    "STOP_RESPONSE_BODY" = 27
    "STOP_RESPONSE_SCHEMA" = 28
    "STOP_INTERNAL" = 29
}
$launcherExitCodes = @{
    "STOP_TOKEN_INPUT" = 30
    "STOP_TOKEN_TOO_LARGE" = 31
    "STOP_STDOUT_TOO_LARGE" = 32
    "STOP_STDERR_TOO_LARGE" = 33
    "STOP_OUTPUT_CONTRACT" = 34
    "STOP_CHILD_WATCHDOG" = 35
    "STOP_CHILD_EXIT_UNCONFIRMED" = 36
    "STOP_LAUNCHER_BOUNDARY" = 37
}

function Throw-FixedLauncherStop {
    param([Parameter(Mandatory = $true)][string]$Code)
    throw [System.InvalidOperationException]::new($Code)
}

function New-BoundedReadState {
    param([Parameter(Mandatory = $true)][System.IO.Stream]$Stream)
    $buffer = [byte[]]::new(1024)
    return @{
        Stream = $Stream
        Buffer = $buffer
        Memory = [System.IO.MemoryStream]::new()
        Task = $Stream.ReadAsync($buffer, 0, $buffer.Length)
        Complete = $false
        Overflow = $false
    }
}

function Update-BoundedReadState {
    param(
        [Parameter(Mandatory = $true)][hashtable]$State,
        [Parameter(Mandatory = $true)][int]$MaximumBytes
    )
    if ($State.Complete -or $State.Overflow -or -not $State.Task.IsCompleted) {
        return
    }
    $read = $State.Task.GetAwaiter().GetResult()
    if ($read -eq 0) {
        $State.Complete = $true
        return
    }
    if (($State.Memory.Length + $read) -gt $MaximumBytes) {
        $State.Overflow = $true
        return
    }
    $State.Memory.Write($State.Buffer, 0, $read)
    [Array]::Clear($State.Buffer, 0, $State.Buffer.Length)
    $State.Task = $State.Stream.ReadAsync($State.Buffer, 0, $State.Buffer.Length)
}

function Get-BoundedUtf8Text {
    param([Parameter(Mandatory = $true)][hashtable]$State)
    $bytes = $State.Memory.ToArray()
    try {
        $encoding = [System.Text.UTF8Encoding]::new($false, $true)
        return $encoding.GetString($bytes)
    }
    finally {
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}

function Stop-OwnedChildTree {
    param([System.Diagnostics.Process]$OwnedChild)
    if ($null -eq $OwnedChild) { return $true }
    try {
        if (-not $OwnedChild.HasExited) {
            $OwnedChild.Kill($true)
        }
    }
    catch {
        # Do not look up or kill by PID. The owned Process object is the only target.
    }
    try {
        if ($OwnedChild.HasExited) { return $true }
        return $OwnedChild.WaitForExit($POST_KILL_WAIT_MS)
    }
    catch {
        return $false
    }
}

function Assert-ExactKeys {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string[]]$ExpectedKeys
    )
    if ($null -eq $Value) { Throw-FixedLauncherStop "STOP_OUTPUT_CONTRACT" }
    $actualKeys = @($Value.PSObject.Properties.Name)
    if ($actualKeys.Count -ne $ExpectedKeys.Count) {
        Throw-FixedLauncherStop "STOP_OUTPUT_CONTRACT"
    }
    for ($index = 0; $index -lt $ExpectedKeys.Count; $index += 1) {
        if ($actualKeys[$index] -cne $ExpectedKeys[$index]) {
            Throw-FixedLauncherStop "STOP_OUTPUT_CONTRACT"
        }
    }
}

function Assert-FixedEnum {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string[]]$Allowed
    )
    if ($Value -isnot [string] -or -not ($Allowed -ccontains $Value)) {
        Throw-FixedLauncherStop "STOP_OUTPUT_CONTRACT"
    }
}

function Validate-DiagnosticJson {
    param([Parameter(Mandatory = $true)][string]$Text)
    if (-not $Text.EndsWith("`n") -or $Text.Contains("`r")) {
        Throw-FixedLauncherStop "STOP_OUTPUT_CONTRACT"
    }
    $json = $Text.Substring(0, $Text.Length - 1)
    if ($json.Length -eq 0 -or $json.Contains("`n")) {
        Throw-FixedLauncherStop "STOP_OUTPUT_CONTRACT"
    }
    try {
        $value = $json | ConvertFrom-Json -Depth 20
    }
    catch {
        Throw-FixedLauncherStop "STOP_OUTPUT_CONTRACT"
    }

    $topKeys = @(
        "schemaVersion", "outcome", "topLevelCancelled", "knownItemStatuses",
        "unknownItemStatus", "cancellationCandidate", "cancellationConsistency",
        "cancelledItemsRemainInOrderItems", "amountPathPresence",
        "amountPathAgreement", "taxRateComposition", "shippingLineItemScope",
        "adjustmentPresence", "formulaRelations"
    )
    Assert-ExactKeys $value $topKeys
    Assert-FixedEnum $value.schemaVersion @("partial-cancel-diagnostic/v2")
    Assert-FixedEnum $value.outcome @("pass_enum_complete", "stop_indeterminate")
    Assert-FixedEnum $value.topLevelCancelled @("null", "value", "missing")

    Assert-ExactKeys $value.knownItemStatuses @("ordered", "cancelled", "dispatched")
    foreach ($statusKey in @("ordered", "cancelled", "dispatched")) {
        Assert-FixedEnum $value.knownItemStatuses.$statusKey @("present", "absent")
    }
    Assert-FixedEnum $value.unknownItemStatus @("absent", "present")
    Assert-FixedEnum $value.cancellationCandidate @(
        "normal", "partial_cancel", "full_cancel", "indeterminate"
    )
    Assert-FixedEnum $value.cancellationConsistency @(
        "consistent", "conflict", "indeterminate"
    )
    Assert-FixedEnum $value.cancelledItemsRemainInOrderItems @(
        "yes", "no", "indeterminate"
    )

    Assert-ExactKeys $value.amountPathPresence @("active", "cancelled")
    $amountKeys = @(
        "item_total_field", "item_plus_option_total", "price_plus_options_reconstructed"
    )
    foreach ($group in @("active", "cancelled")) {
        Assert-ExactKeys $value.amountPathPresence.$group $amountKeys
        foreach ($amountKey in $amountKeys) {
            Assert-FixedEnum $value.amountPathPresence.$group.$amountKey @(
                "all_present", "partially_present", "not_present", "invalid"
            )
        }
    }

    Assert-ExactKeys $value.amountPathAgreement @("active", "cancelled")
    foreach ($group in @("active", "cancelled")) {
        Assert-FixedEnum $value.amountPathAgreement.$group @(
            "all_available_paths_agree", "available_paths_conflict",
            "single_path_only", "no_complete_path"
        )
    }

    Assert-ExactKeys $value.taxRateComposition @("active", "cancelled")
    foreach ($group in @("active", "cancelled")) {
        Assert-FixedEnum $value.taxRateComposition.$group @(
            "none", "rate_8_only", "rate_10_only", "mixed_8_10",
            "unknown_rate_present", "indeterminate"
        )
    }
    Assert-FixedEnum $value.shippingLineItemScope @(
        "no_shipping_lines", "active_items_only", "cancelled_items_only",
        "active_and_cancelled_items", "unresolvable_or_invalid"
    )

    Assert-ExactKeys $value.adjustmentPresence @(
        "discount", "coinDiscount", "adjustment", "codFee"
    )
    foreach ($adjustmentKey in @("discount", "coinDiscount", "adjustment", "codFee")) {
        Assert-FixedEnum $value.adjustmentPresence.$adjustmentKey @(
            "absent", "present", "invalid"
        )
    }

    $shippingKeys = @(
        "without_shipping", "order_shipping_fee", "all_shipping_lines",
        "active_shipping_lines_only", "active_item_shipping_fee"
    )
    $formulaKeys = @()
    foreach ($amountKey in $amountKeys) {
        foreach ($shippingKey in $shippingKeys) {
            $formulaKeys += "${amountKey}__${shippingKey}"
        }
    }
    Assert-ExactKeys $value.formulaRelations $formulaKeys
    foreach ($formulaKey in $formulaKeys) {
        Assert-FixedEnum $value.formulaRelations.$formulaKey @(
            "matches", "does_not_match", "unavailable", "invalid"
        )
    }

    if ($value.outcome -ceq "pass_enum_complete") {
        $activeStatusPresent =
            $value.knownItemStatuses.ordered -ceq "present" -or
            $value.knownItemStatuses.dispatched -ceq "present"
        $cancelledStatusPresent =
            $value.knownItemStatuses.cancelled -ceq "present"
        $activePathValues = @($amountKeys | ForEach-Object {
            $value.amountPathPresence.active.$_
        })
        $cancelledPathValues = @($amountKeys | ForEach-Object {
            $value.amountPathPresence.cancelled.$_
        })
        $formulaValues = @($formulaKeys | ForEach-Object {
            $value.formulaRelations.$_
        })
        $baseSuccessValid =
            $value.unknownItemStatus -ceq "absent" -and
            $value.cancellationConsistency -ceq "consistent" -and
            $value.topLevelCancelled -ceq "null" -and
            $value.cancelledItemsRemainInOrderItems -cne "indeterminate" -and
            $value.shippingLineItemScope -cne "unresolvable_or_invalid" -and
            -not (@($value.adjustmentPresence.PSObject.Properties.Value) -ccontains "invalid") -and
            -not (@($value.adjustmentPresence.PSObject.Properties.Value) -ccontains "absent") -and
            -not (@($value.taxRateComposition.PSObject.Properties.Value) -ccontains "indeterminate") -and
            -not (@($value.taxRateComposition.PSObject.Properties.Value) -ccontains "unknown_rate_present") -and
            $activeStatusPresent -and
            ($activePathValues -ccontains "all_present") -and
            -not ($activePathValues -ccontains "partially_present") -and
            -not ($activePathValues -ccontains "invalid") -and
            $value.amountPathAgreement.active -cne "available_paths_conflict" -and
            ($formulaValues -ccontains "matches")
        $candidateSuccessValid =
            ($value.cancellationCandidate -ceq "normal" -and
                -not $cancelledStatusPresent -and
                $value.cancelledItemsRemainInOrderItems -ceq "no" -and
                $value.taxRateComposition.cancelled -ceq "none") -or
            ($value.cancellationCandidate -ceq "partial_cancel" -and
                $cancelledStatusPresent -and
                $value.cancelledItemsRemainInOrderItems -ceq "yes" -and
                ($cancelledPathValues -ccontains "all_present") -and
                -not ($cancelledPathValues -ccontains "partially_present") -and
                -not ($cancelledPathValues -ccontains "invalid") -and
                $value.amountPathAgreement.cancelled -cne "available_paths_conflict" -and
                $value.taxRateComposition.cancelled -cne "none")
        if (-not $baseSuccessValid -or -not $candidateSuccessValid) {
            Throw-FixedLauncherStop "STOP_OUTPUT_CONTRACT"
        }
    }

    $normalized = $value | ConvertTo-Json -Compress -Depth 20
    if ($normalized -cne $json) {
        Throw-FixedLauncherStop "STOP_OUTPUT_CONTRACT"
    }
    return @{ Json = $normalized; Outcome = [string]$value.outcome }
}

$finalStdout = $null
$finalStderr = "STOP_LAUNCHER_BOUNDARY"
$finalExitCode = $launcherExitCodes.STOP_LAUNCHER_BOUNDARY
$processStarted = $false
$tokenSecure = $null
$tokenBstr = [IntPtr]::Zero
$tokenPlain = $null
$startInfo = $null
$childProcess = $null
$stdoutState = $null
$stderrState = $null

try {
    if ($args.Count -ne 0) { Throw-FixedLauncherStop "STOP_LAUNCHER_BOUNDARY" }
    if (
        $PSVersionTable.PSEdition -ne "Core" -or
        $PSVersionTable.PSVersion.Major -lt 7 -or
        [System.Diagnostics.ProcessStartInfo].GetProperty("ArgumentList") -eq $null
    ) {
        Throw-FixedLauncherStop "STOP_LAUNCHER_BOUNDARY"
    }

    $repositoryRoot = [System.IO.Path]::GetFullPath(
        [System.IO.Path]::Combine($PSScriptRoot, "..")
    )
    $scriptPath = [System.IO.Path]::Combine(
        $repositoryRoot, "scripts", "diagnose-partial-cancel.mjs"
    )
    if (
        -not [System.IO.File]::Exists($NODE_PATH) -or
        -not [System.IO.Directory]::Exists($repositoryRoot) -or
        -not [System.IO.File]::Exists($scriptPath)
    ) {
        Throw-FixedLauncherStop "STOP_LAUNCHER_BOUNDARY"
    }

    $tokenSecure = Read-Host -Prompt "BASE read_orders-only access token (hidden)" -AsSecureString
    if ($tokenSecure.Length -eq 0) { Throw-FixedLauncherStop "STOP_TOKEN_INPUT" }
    if ($tokenSecure.Length -gt $TOKEN_MAX_CHARACTERS) {
        Throw-FixedLauncherStop "STOP_TOKEN_TOO_LARGE"
    }
    $tokenBstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($tokenSecure)
    $tokenPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenBstr)

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $NODE_PATH
    $startInfo.WorkingDirectory = $repositoryRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $false
    $startInfo.RedirectStandardInput = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.Environment.Clear()
    $startInfo.Environment.Add("APP_ENVIRONMENT", "development")
    $startInfo.Environment.Add("BASE_DATA_MODE", "readonly")
    $startInfo.Environment.Add("BASE_READONLY_ACCESS_TOKEN", $tokenPlain)
    $startInfo.ArgumentList.Add("--no-warnings")
    $startInfo.ArgumentList.Add("--experimental-strip-types")
    $startInfo.ArgumentList.Add("--experimental-specifier-resolution=node")
    $startInfo.ArgumentList.Add($scriptPath)

    $childProcess = [System.Diagnostics.Process]::new()
    $childProcess.StartInfo = $startInfo
    if (-not $childProcess.Start()) {
        Throw-FixedLauncherStop "STOP_LAUNCHER_BOUNDARY"
    }
    $processStarted = $true

    # Best effort only: immutable strings and the running child environment cannot be zeroed.
    $startInfo.Environment.Clear()
    $tokenPlain = $null
    if ($tokenBstr -ne [IntPtr]::Zero) {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenBstr)
        $tokenBstr = [IntPtr]::Zero
    }
    if ($tokenSecure -ne $null) {
        try { $tokenSecure.Dispose() } catch {}
        $tokenSecure = $null
    }

    $stdoutState = New-BoundedReadState $childProcess.StandardOutput.BaseStream
    $stderrState = New-BoundedReadState $childProcess.StandardError.BaseStream
    $watchdog = [System.Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        Update-BoundedReadState $stdoutState $STDOUT_MAX_BYTES
        Update-BoundedReadState $stderrState $STDERR_MAX_BYTES
        if ($stdoutState.Overflow) { Throw-FixedLauncherStop "STOP_STDOUT_TOO_LARGE" }
        if ($stderrState.Overflow) { Throw-FixedLauncherStop "STOP_STDERR_TOO_LARGE" }
        if ($childProcess.HasExited -and $stdoutState.Complete -and $stderrState.Complete) {
            break
        }
        if ($watchdog.ElapsedMilliseconds -ge $PROCESS_WATCHDOG_MS) {
            $confirmed = Stop-OwnedChildTree $childProcess
            if (-not $confirmed) {
                Throw-FixedLauncherStop "STOP_CHILD_EXIT_UNCONFIRMED"
            }
            Throw-FixedLauncherStop "STOP_CHILD_WATCHDOG"
        }
        [System.Threading.Thread]::Sleep(10)
    }

    $capturedStdout = Get-BoundedUtf8Text $stdoutState
    $capturedStderr = Get-BoundedUtf8Text $stderrState
    $childExitCode = $childProcess.ExitCode

    if ($childExitCode -eq 0) {
        if ($capturedStderr.Length -ne 0) {
            Throw-FixedLauncherStop "STOP_OUTPUT_CONTRACT"
        }
        $validated = Validate-DiagnosticJson $capturedStdout
        if ($validated.Outcome -cne "pass_enum_complete") {
            Throw-FixedLauncherStop "STOP_OUTPUT_CONTRACT"
        }
        $finalStdout = $validated.Json
        $finalStderr = $null
        $finalExitCode = 0
    }
    elseif ($childExitCode -eq $childExitCodes.STOP_ENUM_INDETERMINATE) {
        if ($capturedStderr -cne "STOP_ENUM_INDETERMINATE`n") {
            Throw-FixedLauncherStop "STOP_OUTPUT_CONTRACT"
        }
        $validated = Validate-DiagnosticJson $capturedStdout
        if ($validated.Outcome -cne "stop_indeterminate") {
            Throw-FixedLauncherStop "STOP_OUTPUT_CONTRACT"
        }
        $finalStdout = $validated.Json
        $finalStderr = "STOP_ENUM_INDETERMINATE"
        $finalExitCode = $childExitCodes.STOP_ENUM_INDETERMINATE
    }
    else {
        if ($capturedStdout.Length -ne 0) {
            Throw-FixedLauncherStop "STOP_OUTPUT_CONTRACT"
        }
        $stderrCode = if ($capturedStderr.EndsWith("`n")) {
            $capturedStderr.Substring(0, $capturedStderr.Length - 1)
        }
        else { "" }
        if (
            $capturedStderr.Contains("`r") -or
            $stderrCode.Contains("`n") -or
            -not $childExitCodes.ContainsKey($stderrCode) -or
            $stderrCode -ceq "PASS_ENUM_COMPLETE" -or
            $childExitCodes[$stderrCode] -ne $childExitCode
        ) {
            Throw-FixedLauncherStop "STOP_OUTPUT_CONTRACT"
        }
        $finalStdout = $null
        $finalStderr = $stderrCode
        $finalExitCode = $childExitCode
    }
}
catch {
    $requestedCode = [string]$_.Exception.Message
    if (-not $launcherExitCodes.ContainsKey($requestedCode)) {
        $requestedCode = "STOP_LAUNCHER_BOUNDARY"
    }
    if ($processStarted -and $childProcess -ne $null) {
        $confirmed = Stop-OwnedChildTree $childProcess
        if (-not $confirmed) {
            $requestedCode = "STOP_CHILD_EXIT_UNCONFIRMED"
        }
    }
    $finalStdout = $null
    $finalStderr = $requestedCode
    $finalExitCode = $launcherExitCodes[$requestedCode]
}
finally {
    if ($startInfo -ne $null) {
        try { $startInfo.Environment.Clear() } catch {}
    }
    $tokenPlain = $null
    if ($tokenBstr -ne [IntPtr]::Zero) {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenBstr)
        $tokenBstr = [IntPtr]::Zero
    }
    if ($tokenSecure -ne $null) {
        try { $tokenSecure.Dispose() } catch {}
    }
    if ($stdoutState -ne $null -and $stdoutState.Memory -ne $null) {
        try { $stdoutState.Memory.Dispose() } catch {}
    }
    if ($stderrState -ne $null -and $stderrState.Memory -ne $null) {
        try { $stderrState.Memory.Dispose() } catch {}
    }
    if ($childProcess -ne $null) {
        try { $childProcess.StandardOutput.Dispose() } catch {}
        try { $childProcess.StandardError.Dispose() } catch {}
        try { $childProcess.Dispose() } catch {}
    }
    $stdoutState = $null
    $stderrState = $null
    $childProcess = $null
    $startInfo = $null
    $tokenSecure = $null
}

if ($null -ne $finalStdout) {
    [Console]::Out.WriteLine($finalStdout)
}
if ($null -ne $finalStderr) {
    [Console]::Error.WriteLine($finalStderr)
}
exit $finalExitCode
