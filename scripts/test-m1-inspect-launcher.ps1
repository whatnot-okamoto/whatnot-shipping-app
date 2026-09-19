# Synthetic fixtures only. No real launcher input, Node CLI or Redis connection.
$ErrorActionPreference = 'Stop'
# This dedicated test process owns these synthetic entries; never read inherited real values.
[Environment]::SetEnvironmentVariable('M1_PRODUCTION_REDIS_URL', 'SYNTHETIC_PARENT_URL', 'Process')
[Environment]::SetEnvironmentVariable('M1_PRODUCTION_REDIS_TOKEN', 'SYNTHETIC_PARENT_TOKEN', 'Process')
$launcher = Join-Path $PSScriptRoot 'inspect-diff-modal-01-v1.ps1'
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($launcher, [ref] $tokens, [ref] $parseErrors)
if ($parseErrors.Count -ne 0) { throw 'LAUNCHER_PARSE_FAILED' }
$definitions = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] })
$functions = ($definitions | ForEach-Object { $_.Extent.Text }) -join "`n"
$module = New-Module -ScriptBlock {
    param($Code, $Root)
    . ([scriptblock]::Create($Code))
    $script:M1InspectDirectory = $Root
} -ArgumentList $functions, $PSScriptRoot
$script:cases = 0
function Assert-M1($Condition) { if (-not $Condition) { throw 'M1_LAUNCHER_TEST_FAILED' } }
function Capture-M1([scriptblock] $Action) {
    $savedOut = [Console]::Out; $savedErr = [Console]::Error
    $out = [IO.StringWriter]::new(); $err = [IO.StringWriter]::new()
    try {
        [Console]::SetOut($out); [Console]::SetError($err)
        $code = & $Action
        return @{ Code = $code; Out = $out.ToString(); Err = $err.ToString() }
    } finally { [Console]::SetOut($savedOut); [Console]::SetError($savedErr); $out.Dispose(); $err.Dispose() }
}

# Inspect actual ProcessStartInfo without starting the child. Only named synthetic entries are read.
& $module {
    $child = New-M1InspectChild
    try {
        if ($child.StartInfo.UseShellExecute -or -not $child.StartInfo.CreateNoWindow) { throw 'BAD_CHILD_OPTIONS' }
        if (-not $child.StartInfo.RedirectStandardInput -or -not $child.StartInfo.RedirectStandardOutput -or
            -not $child.StartInfo.RedirectStandardError) { throw 'BAD_CHILD_OPTIONS' }
        $expected = @('--no-warnings', '--experimental-strip-types', '--experimental-loader',
            './scripts/typescript-test-loader.mjs', './scripts/migrate-diff-modal-01-v1.mjs', 'inspect',
            '--url-env', 'M1_PRODUCTION_REDIS_URL', '--token-env', 'M1_PRODUCTION_REDIS_TOKEN')
        if (($child.StartInfo.ArgumentList -join '|') -cne ($expected -join '|')) { throw 'BAD_CHILD_ARGUMENTS' }
        if ($child.StartInfo.Environment.ContainsKey('M1_PRODUCTION_REDIS_URL') -or
            $child.StartInfo.Environment.ContainsKey('M1_PRODUCTION_REDIS_TOKEN')) { throw 'INHERITED_SECRET_FALLBACK' }
    } finally { $child.Dispose() }
}
$script:cases++

# Exercise the real child runner with in-memory streams, never a real Node process.
& $module {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.Environment['M1_PRODUCTION_REDIS_URL'] = 'SYNTHETIC_CHILD_URL'
    $info.Environment['M1_PRODUCTION_REDIS_TOKEN'] = 'SYNTHETIC_CHILD_TOKEN'
    $outStream = [IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes('SYNTHETIC_RESULT'))
    $errStream = [IO.MemoryStream]::new()
    $fake = [pscustomobject]@{ StartInfo = $info; Started = $false; Waited = $false; ExitCode = 0;
        StandardInput = [IO.StringWriter]::new();
        StandardOutput = [IO.StreamReader]::new($outStream); StandardError = [IO.StreamReader]::new($errStream) }
    $fake | Add-Member ScriptMethod Start { $this.Started = $true; return $true }
    $fake | Add-Member ScriptMethod WaitForExit {
        if ($this.StartInfo.Environment.ContainsKey('M1_PRODUCTION_REDIS_URL') -or
            $this.StartInfo.Environment.ContainsKey('M1_PRODUCTION_REDIS_TOKEN')) { throw 'LATE_ENV_CLEANUP' }
        $this.Waited = $true
    }
    try {
        $result = Invoke-M1InspectChild $fake
        if (-not $fake.Started -or -not $fake.Waited -or $result.Code -ne 0 -or
            $result.Out -cne 'SYNTHETIC_RESULT' -or $result.Err -ne '') { throw 'CHILD_RUNNER_FAILED' }
    } finally {
        $fake.StandardInput.Dispose(); $fake.StandardOutput.Dispose(); $fake.StandardError.Dispose()
    }
}
$script:cases++

# Tests replace internal I/O functions in an isolated module. The executable exposes no test/secret parameters.
& $module {
    $script:makeChild = ${function:New-M1InspectChild}
    function script:Test-M1InteractiveConsole { return $script:interactive }
    function script:New-M1InspectChild {
        $script:created++
        $script:child = & $script:makeChild
        # Real start info, fake process lifetime. Keep references to assert finally cleanup.
        $fake = [pscustomobject]@{ StartInfo = $script:child.StartInfo; Disposed = $false }
        $fake | Add-Member ScriptMethod Dispose { $this.Disposed = $true }
        $script:fake = $fake
        return $fake
    }
    function script:Read-M1HiddenValue([string] $Label, [int] $Limit) {
        $index = $script:reads++
        if ($script:readFailure -eq $index) { throw 'SYNTHETIC_PRIVATE_INPUT_FAILURE' }
        $text = if ($index -eq 0) { $script:endpoint } else { $script:token }
        if ($text.Length -gt $Limit) { throw 'SYNTHETIC_TOO_LONG' }
        $secret = [Security.SecureString]::new()
        foreach ($c in $text.ToCharArray()) { $secret.AppendChar($c) }
        $script:secrets.Add($secret)
        return $secret
    }
    function script:Invoke-M1InspectChild($Child) {
        $script:started++
        if ($Child.StartInfo.Environment['M1_PRODUCTION_REDIS_URL'] -cne $script:endpoint -or
            $Child.StartInfo.Environment['M1_PRODUCTION_REDIS_TOKEN'] -cne $script:token) { throw 'CHILD_INPUT_MISMATCH' }
        foreach ($argument in $Child.StartInfo.ArgumentList) {
            if ($argument.Contains($script:endpoint) -or $argument.Contains($script:token)) { throw 'SECRET_ARGUMENT' }
        }
        if ($script:mode -eq 'start-failure') { throw ($script:endpoint + $script:token) }
        return $script:result
    }
}

try {
    # Missing/bad inputs, cancellation, startup failure and child results all use the same production core.
    foreach ($mode in @('success', 'fixed-error', 'start-failure', 'bad-stdout', 'bad-stderr', 'extra-field',
        'invalid-json', 'bad-id', 'bad-fingerprint', 'bad-bytes', 'bad-status', 'bad-version', 'array-version',
        'preserved', 'prepared', 'adopted', 'noninteractive', 'empty-url', 'empty-token', 'bad-url',
        'http-url', 'userinfo-url', 'query-url', 'fragment-url', 'cancel-url', 'cancel-token', 'long-url', 'long-token')) {
        & $module {
            param($Mode)
            $script:mode = $Mode; $script:created = 0; $script:started = 0; $script:reads = 0
            $script:child = $null; $script:fake = $null
            $script:secrets = [Collections.Generic.List[Security.SecureString]]::new()
            $script:interactive = $Mode -ne 'noninteractive'; $script:readFailure = -1
            $script:endpoint = 'https://m1-launcher-synthetic.invalid'
            $script:token = 'M1_SYNTHETIC_TOKEN_NEVER_REAL'
            $safe = @{ status = 'legacy'; version = 'diff-modal-01:v1'; source_bytes = 123;
                source_fingerprint = ('a' * 64); migration_id = $null }
            $script:result = @{ Code = 0; Out = ($safe | ConvertTo-Json -Compress); Err = '' }
            switch ($Mode) {
                'fixed-error' { $script:result = @{ Code = 1; Out = ''; Err = "M1_MIGRATION_SOURCE_SCHEMA`n" } }
                'bad-stdout' { $script:result.Out = $script:endpoint + $script:token }
                'bad-stderr' { $script:result.Err = $script:endpoint + $script:token }
                'invalid-json' { $script:result.Out = '{' + $script:token }
                'extra-field' { $safe.extra = $script:token; $script:result.Out = $safe | ConvertTo-Json -Compress }
                'bad-id' { $safe.migration_id = $script:token; $script:result.Out = $safe | ConvertTo-Json -Compress }
                'bad-fingerprint' { $safe.source_fingerprint = $script:token; $script:result.Out = $safe | ConvertTo-Json -Compress }
                'bad-bytes' { $safe.source_bytes = 262145; $script:result.Out = $safe | ConvertTo-Json -Compress }
                'bad-status' { $safe.status = $script:token; $script:result.Out = $safe | ConvertTo-Json -Compress }
                'bad-version' { $safe.version = $script:token; $script:result.Out = $safe | ConvertTo-Json -Compress }
                'array-version' { $safe.version = @('diff-modal-01:v1'); $script:result.Out = $safe | ConvertTo-Json -Compress }
                { $_ -in @('preserved', 'prepared', 'adopted') } {
                    $safe.status = $Mode; $safe.migration_id = '11111111-1111-4111-8111-111111111111'
                    $script:result.Out = $safe | ConvertTo-Json -Compress
                }
                'empty-url' { $script:endpoint = '' }
                'empty-token' { $script:token = '' }
                'bad-url' { $script:endpoint = 'SYNTHETIC_BAD_URL' }
                'http-url' { $script:endpoint = 'http://m1-launcher-synthetic.invalid' }
                'userinfo-url' { $script:endpoint = 'https://user:pass@m1-launcher-synthetic.invalid' }
                'query-url' { $script:endpoint = 'https://m1-launcher-synthetic.invalid?private=fixture' }
                'fragment-url' { $script:endpoint = 'https://m1-launcher-synthetic.invalid#fixture' }
                'cancel-url' { $script:readFailure = 0 }
                'cancel-token' { $script:readFailure = 1 }
                'long-url' { $script:endpoint = 'x' * 4097 }
                'long-token' { $script:token = 'x' * 8193 }
            }
        } $mode
        $output = Capture-M1 { & $module { Invoke-M1InspectLauncher } }
        $success = $mode -in @('success', 'preserved', 'prepared', 'adopted')
        Assert-M1 ($output.Code -eq $(if ($success) { 0 } else { 1 }))
        if ($success) {
            Assert-M1 ($output.Err -eq '')
            $parsed = ConvertFrom-Json $output.Out -AsHashtable
            Assert-M1 ($parsed.Count -eq 5)
        } else {
            Assert-M1 ($output.Out -eq '')
            $expected = if ($mode -eq 'fixed-error') { 'M1_MIGRATION_SOURCE_SCHEMA' } else { 'M1_LAUNCHER_FAILED' }
            Assert-M1 ($output.Err.Trim() -ceq $expected)
        }
        Assert-M1 (-not ($output.Out + $output.Err).Contains('m1-launcher-synthetic.invalid'))
        Assert-M1 (-not ($output.Out + $output.Err).Contains('M1_SYNTHETIC_TOKEN_NEVER_REAL'))
        & $module {
            if ($script:mode -in @('noninteractive', 'empty-url', 'empty-token', 'bad-url', 'http-url',
                'userinfo-url', 'query-url', 'fragment-url', 'cancel-url', 'cancel-token', 'long-url', 'long-token')) {
                if ($script:started -ne 0) { throw 'UNEXPECTED_CHILD_START' }
            } elseif ($script:started -ne 1) { throw 'MISSING_CHILD_START' }
            if ($script:mode -eq 'noninteractive' -and ($script:created -ne 0 -or $script:reads -ne 0)) { throw 'EARLY_GATE_FAILED' }
            if ($null -ne $script:fake) {
                if (-not $script:fake.Disposed -or
                    $script:fake.StartInfo.Environment.ContainsKey('M1_PRODUCTION_REDIS_URL') -or
                    $script:fake.StartInfo.Environment.ContainsKey('M1_PRODUCTION_REDIS_TOKEN')) { throw 'CLEANUP_FAILED' }
            }
            foreach ($secret in $script:secrets) {
                $disposed = $false
                # PowerShell suppresses a disposed property getter; test a method instead.
                try { $secret.MakeReadOnly() } catch { $disposed = $true }
                if (-not $disposed) { throw 'SECRET_NOT_DISPOSED' }
            }
            if ($null -ne $script:child) { $script:child.Dispose() }
        }
        Assert-M1 ([Environment]::GetEnvironmentVariable('M1_PRODUCTION_REDIS_URL', 'Process') -ceq 'SYNTHETIC_PARENT_URL')
        Assert-M1 ([Environment]::GetEnvironmentVariable('M1_PRODUCTION_REDIS_TOKEN', 'Process') -ceq 'SYNTHETIC_PARENT_TOKEN')
        $script:cases++
    }
} finally { Remove-Module $module }

# Execute only early rejection paths of the real script in a redirected PowerShell child.
# No Node child is reachable; no input is requested and no real values are provided.
foreach ($arguments in @(@(), @('SYNTHETIC_ARG_URL', 'SYNTHETIC_ARG_TOKEN'), @('-Url', 'SYNTHETIC_ARG_URL'))) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = Join-Path $PSHOME 'pwsh.exe'
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    foreach ($argument in @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $launcher) + $arguments) { $info.ArgumentList.Add($argument) }
    $child = [Diagnostics.Process]::new(); $child.StartInfo = $info
    try {
        [void] $child.Start()
        $child.StandardInput.WriteLine('SYNTHETIC_REDIRECT_URL SYNTHETIC_REDIRECT_TOKEN'); $child.StandardInput.Close()
        $out = $child.StandardOutput.ReadToEndAsync(); $err = $child.StandardError.ReadToEndAsync()
        $child.WaitForExit()
        Assert-M1 ($child.ExitCode -eq 1)
        Assert-M1 ($out.GetAwaiter().GetResult() -eq '')
        $expected = if ($arguments.Count -eq 0) { 'M1_LAUNCHER_FAILED' } else { 'M1_LAUNCHER_ARGUMENT' }
        Assert-M1 ($err.GetAwaiter().GetResult().Trim() -ceq $expected)
    } finally { $child.Dispose() }
    $script:cases++
}

# No public parameter/pipeline/credential sources or parent environment mutations.
Assert-M1 ($null -eq $ast.ParamBlock)
$source = $ast.Extent.Text
Assert-M1 ($source -notmatch '\$env:|Get-Clipboard|Set-Clipboard|Get-Content|ReadAllText|SetEnvironmentVariable|GetEnvironmentVariables')
Assert-M1 ($source.Contains('[Console]::ReadKey($true)'))
Assert-M1 ($source.Contains('$MyInvocation.ExpectingInput'))
$script:cases++
[Environment]::SetEnvironmentVariable('M1_PRODUCTION_REDIS_URL', $null, 'Process')
[Environment]::SetEnvironmentVariable('M1_PRODUCTION_REDIS_TOKEN', $null, 'Process')
[Console]::WriteLine("M1 inspect launcher: $script:cases scenarios passed (synthetic / no network)")
