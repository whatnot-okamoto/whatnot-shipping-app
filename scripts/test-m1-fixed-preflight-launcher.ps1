# Dedicated fake-only launcher tests. Never supply actual URL/token or start the Node CLI.
$ErrorActionPreference = 'Stop'
[Environment]::SetEnvironmentVariable('M1_PRODUCTION_REDIS_URL', 'SYNTHETIC_PARENT_URL', 'Process')
[Environment]::SetEnvironmentVariable('M1_PRODUCTION_REDIS_TOKEN', 'SYNTHETIC_PARENT_TOKEN', 'Process')
$launcher = Join-Path $PSScriptRoot 'check-m1-fixed-preflight.ps1'
function Read-Functions([string] $Path) {
    $tokens = $null; $errors = $null
    $tree = [Management.Automation.Language.Parser]::ParseFile($Path, [ref] $tokens, [ref] $errors)
    if ($errors.Count -ne 0) { throw 'PREFLIGHT_PARSE_FAILED' }
    return @($tree.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] })
}
$defs = Read-Functions $launcher
$previous = Read-Functions (Join-Path $PSScriptRoot 'inspect-diff-modal-01-v1.ps1')
$cases = 0
function Assert-Fixed($Condition) { if (-not $Condition) { throw ('FIXED_LAUNCHER_TEST_FAILED line=' + (Get-PSCallStack)[1].ScriptLineNumber) } }
foreach ($name in @('Test-M1InteractiveConsole', 'Read-M1ConsoleKey', 'Read-M1HiddenValue', 'Convert-M1HiddenValue',
    'Stop-M1InspectChild', 'Invoke-M1InspectChild', 'Invoke-M1InspectLauncher')) {
    Assert-Fixed (($defs | Where-Object Name -eq $name).Extent.Text -ceq ($previous | Where-Object Name -eq $name).Extent.Text)
    $cases++
}
$functions = ($defs | ForEach-Object { $_.Extent.Text }) -join "`n"
$module = New-Module -ScriptBlock {
    param($Code, $Root)
    . ([scriptblock]::Create($Code))
    $script:M1InspectDirectory = $Root
    $script:M1ExpectedFingerprint = 'a' * 64
    $script:makeChild = ${function:New-M1InspectChild}
    function script:Test-M1InteractiveConsole { return $script:interactive }
    function script:New-M1InspectChild {
        $script:created++
        $real = & $script:makeChild
        $script:fake = [pscustomobject]@{ StartInfo = $real.StartInfo; Disposed = $false }
        $real.Dispose()
        $script:fake | Add-Member ScriptMethod Dispose { $this.Disposed = $true }
        return $script:fake
    }
    function script:Read-M1HiddenValue([string] $Label, [int] $Limit) {
        $script:reads++
        $s = [Security.SecureString]::new()
        $value = if ($script:reads -eq 1) { 'https://synthetic.invalid' } else { 'SYNTHETIC_PRIVATE_TOKEN' }
        foreach ($c in $value.ToCharArray()) { $s.AppendChar($c) }
        return $s
    }
    function script:Invoke-M1InspectChild($Child) {
        $script:started++
        if ($script:mode -eq 'start-failure') { throw 'SYNTHETIC_PRIVATE_TOKEN' }
        if ($Child.StartInfo.Environment['M1_PRODUCTION_REDIS_URL'] -cne 'https://synthetic.invalid' -or
            $Child.StartInfo.Environment['M1_PRODUCTION_REDIS_TOKEN'] -cne 'SYNTHETIC_PRIVATE_TOKEN') { throw 'BAD_CHILD_INPUT' }
        $argsExpected = @('--no-warnings', '--experimental-strip-types', '--experimental-loader', './scripts/typescript-test-loader.mjs',
            './scripts/check-m1-fixed-preflight.mjs', '--expected-fingerprint', ('a' * 64), '--url-env', 'M1_PRODUCTION_REDIS_URL', '--token-env', 'M1_PRODUCTION_REDIS_TOKEN')
        if (($Child.StartInfo.ArgumentList -join '|') -cne ($argsExpected -join '|')) { throw 'BAD_ARGUMENTS' }
        return $script:result
    }
} -ArgumentList $functions, $PSScriptRoot
try {
    foreach ($mode in @('checked', 'blocked', 'indeterminate', 'fixed-error', 'timeout', 'output-limit', 'stop-unconfirmed',
        'start-failure', 'noninteractive', 'extra-field', 'secret-error', 'bad-enum', 'bad-bytes', 'bad-bool', 'bad-exit', 'bad-json')) {
        & $module {
            param($Mode)
            $script:mode = $Mode; $script:created = 0; $script:reads = 0; $script:started = 0; $script:fake = $null
            $script:interactive = $Mode -ne 'noninteractive'
            $safe = [ordered]@{ tool_version = 'm1-fixed-preflight:v1'; result = 'checked'; epoch = 'absent'; migration_record = 'absent'
                source = 'valid'; source_bytes = 100; fingerprint_match = $true; session_current = 'absent'; lease = 'absent'
                lease_ttl = 'absent'; attempt = 'absent'; legacy_phase = 'promoting'; legacy_unfinished = $true }
            $script:result = @{ Code = 0; Out = ''; Err = '' }
            switch ($Mode) {
                'blocked' { $safe.result = 'blocked'; $safe.fingerprint_match = $false; $script:result.Code = 2 }
                'indeterminate' { $safe.result = 'indeterminate'; $safe.legacy_phase = 'unknown'; $script:result.Code = 2 }
                'extra-field' { $safe.lease_owner = 'SYNTHETIC_PRIVATE_TOKEN' }
                'bad-enum' { $safe.attempt = 'running' }
                'bad-bytes' { $safe.source_bytes = 0.5 }
                'bad-bool' { $safe.fingerprint_match = 'true' }
                'bad-exit' { $script:result.Code = 2 }
            }
            $script:result.Out = $safe | ConvertTo-Json -Compress
            if ($Mode -eq 'bad-json') { $script:result.Out = 'SYNTHETIC_PRIVATE_TOKEN' }
            $code = switch ($Mode) {
                'fixed-error' { 'M1_PREFLIGHT_HTTP' }
                'timeout' { 'M1_LAUNCHER_TIMEOUT' }
                'output-limit' { 'M1_LAUNCHER_OUTPUT_LIMIT' }
                'stop-unconfirmed' { 'M1_LAUNCHER_STOP_UNCONFIRMED' }
                'secret-error' { 'https://synthetic.invalid SYNTHETIC_PRIVATE_TOKEN' }
            }
            if ($code) { $script:result = @{ Code = 1; Out = ''; Err = $code } }
        } $mode
        $savedOut = [Console]::Out; $savedErr = [Console]::Error
        $out = [IO.StringWriter]::new(); $err = [IO.StringWriter]::new()
        try {
            [Console]::SetOut($out); [Console]::SetError($err)
            $code = & $module { Invoke-M1InspectLauncher }
        } finally { [Console]::SetOut($savedOut); [Console]::SetError($savedErr) }
        try {
            Assert-Fixed (-not ($out.ToString() + $err.ToString()).Contains('SYNTHETIC_PRIVATE_TOKEN'))
            Assert-Fixed (-not ($out.ToString() + $err.ToString()).Contains('https://synthetic.invalid'))
            if ($mode -in @('checked', 'blocked', 'indeterminate')) {
                Assert-Fixed ($code -eq $(if ($mode -eq 'checked') { 0 } else { 2 }))
                Assert-Fixed ($err.ToString() -eq '' -and (ConvertFrom-Json $out.ToString() -AsHashtable).Count -eq 13)
            } else {
                Assert-Fixed ($code -eq 1 -and $out.ToString() -eq '')
                $expected = switch ($mode) {
                    'fixed-error' { 'M1_PREFLIGHT_HTTP' }; 'timeout' { 'M1_LAUNCHER_TIMEOUT' }
                    'output-limit' { 'M1_LAUNCHER_OUTPUT_LIMIT' }; 'stop-unconfirmed' { 'M1_LAUNCHER_STOP_UNCONFIRMED' }
                    default { 'M1_LAUNCHER_FAILED' }
                }
                Assert-Fixed ($err.ToString().Trim() -ceq $expected)
            }
            & $module {
                if ($script:mode -eq 'noninteractive' -and ($script:created -ne 0 -or $script:reads -ne 0 -or $script:started -ne 0)) { throw 'STARTED_BEFORE_GATE' }
                if ($script:fake -and (-not $script:fake.Disposed -or
                    $script:fake.StartInfo.Environment.ContainsKey('M1_PRODUCTION_REDIS_URL') -or
                    $script:fake.StartInfo.Environment.ContainsKey('M1_PRODUCTION_REDIS_TOKEN'))) { throw 'CLEANUP_FAILED' }
            }
            Assert-Fixed ([Environment]::GetEnvironmentVariable('M1_PRODUCTION_REDIS_URL', 'Process') -ceq 'SYNTHETIC_PARENT_URL')
            Assert-Fixed ([Environment]::GetEnvironmentVariable('M1_PRODUCTION_REDIS_TOKEN', 'Process') -ceq 'SYNTHETIC_PARENT_TOKEN')
            $cases++
        } finally { $out.Dispose(); $err.Dispose() }
    }
    & $module {
        $l = Get-M1InspectLimits
        if ($l.RuntimeMs -ne 60000 -or $l.StopMs -ne 5000 -or $l.OutChars -ne 4096 -or $l.ErrChars -ne 128) { throw 'LIMIT_CHANGED' }
    }
    $cases++
} finally { Remove-Module $module }

# Run the actual supervisor at the dedicated 4096/128 character boundaries.
$bounded = New-Module -ScriptBlock { param($Code) . ([scriptblock]::Create($Code)) } -ArgumentList $functions
try {
    foreach ($spec in @(@(4096, 0, $false), @(4097, 0, $true), @(0, 128, $false), @(0, 129, $true))) {
        & $bounded {
            param($OutLength, $ErrLength, $Overflow)
            $outStream = [IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes('x' * $OutLength))
            $errStream = [IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes('y' * $ErrLength))
            $fake = [pscustomobject]@{ StandardInput = [IO.StringWriter]::new(); StandardOutput = [IO.StreamReader]::new($outStream)
                StandardError = [IO.StreamReader]::new($errStream); ExitCode = 0; Killed = $false; Confirmed = $false }
            $fake | Add-Member ScriptMethod Start { return $true }
            $fake | Add-Member ScriptMethod Kill { param([bool] $Tree)
                if (-not $Tree) { throw 'EXPECTED_TREE_KILL' }; $this.Killed = $true }
            $fake | Add-Member ScriptMethod WaitForExit { param([int] $Milliseconds)
                if ($Milliseconds -lt 0 -or $Milliseconds -gt 5000) { throw 'WAIT_LIMIT' }
                if ($this.Killed) { $this.Confirmed = $true }; return $true }
            try {
                $r = Invoke-M1InspectChild $fake
                if ($Overflow) {
                    if ($r.Code -ne 1 -or $r.Out -ne '' -or $r.Err -cne 'M1_LAUNCHER_OUTPUT_LIMIT' -or
                        -not $fake.Killed -or -not $fake.Confirmed) { throw 'OUTPUT_BOUND_FAILED' }
                } elseif ($r.Code -ne 0 -or $r.Out.Length -ne $OutLength -or $r.Err.Length -ne $ErrLength -or $fake.Killed) {
                    throw 'EXACT_OUTPUT_BOUND_FAILED'
                }
            } finally { $fake.StandardInput.Dispose(); $fake.StandardOutput.Dispose(); $fake.StandardError.Dispose() }
        } $spec[0] $spec[1] $spec[2]
        $cases++
    }
} finally { Remove-Module $bounded }

# Real PowerShell only for early rejection. Redirected console prevents any Node CLI start.
foreach ($argList in @(@(), @('--expected-fingerprint', ('a' * 64)), @('--expected-fingerprint', ('A' * 64)),
    @('--expected-fingerprint', ('a' * 64 + "`n")), @('--expected-fingerprint', ('a' * 63)),
    @('--expected-fingerprint', ('a' * 64), 'extra'), @('--url', 'SYNTHETIC_PRIVATE_TOKEN'))) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = Join-Path $PSHOME 'pwsh.exe'; $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true; $info.RedirectStandardInput = $true
    foreach ($a in @('-NoLogo', '-NoProfile', '-File', $launcher) + $argList) { $info.ArgumentList.Add($a) }
    $p = [Diagnostics.Process]::new(); $p.StartInfo = $info
    try {
        [void] $p.Start(); $p.StandardInput.Close()
        Assert-Fixed ($p.WaitForExit(10000))
        Assert-Fixed ($p.ExitCode -eq 1 -and $p.StandardOutput.ReadToEnd() -eq '')
        Assert-Fixed ($p.StandardError.ReadToEnd().Trim() -cin @('M1_LAUNCHER_ARGUMENT', 'M1_LAUNCHER_FAILED'))
        $cases++
    } finally {
        if (-not $p.HasExited) { $p.Kill($true); [void] $p.WaitForExit(5000) }
        $p.Dispose()
    }
}
[Environment]::SetEnvironmentVariable('M1_PRODUCTION_REDIS_URL', $null, 'Process')
[Environment]::SetEnvironmentVariable('M1_PRODUCTION_REDIS_TOKEN', $null, 'Process')
[Console]::WriteLine("M1 fixed launcher: $cases scenarios passed (fake only / no Node CLI)")
