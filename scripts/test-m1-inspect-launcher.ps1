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
function Assert-M1($Condition) {
    if (-not $Condition) { throw ('M1_LAUNCHER_TEST_FAILED at line ' + (Get-PSCallStack)[1].ScriptLineNumber + ' case=' + $mode) }
}
function Capture-M1([scriptblock] $Action) {
    $savedOut = [Console]::Out; $savedErr = [Console]::Error
    $out = [IO.StringWriter]::new(); $err = [IO.StringWriter]::new()
    try {
        [Console]::SetOut($out); [Console]::SetError($err)
        $code = & $Action
        return @{ Code = $code; Out = $out.ToString(); Err = $err.ToString() }
    } finally { [Console]::SetOut($savedOut); [Console]::SetError($savedErr); $out.Dispose(); $err.Dispose() }
}

# Exercise the production input loop with synthetic key events, not an interactive console.
# Only the internal console read is replaced; no new launcher input parameters are exposed.
$inputModule = New-Module -ScriptBlock {
    param($Code)
    . ([scriptblock]::Create($Code))
    function script:Read-M1ConsoleKey {
        if ($script:keys.Count -eq 0) { throw 'SYNTHETIC_PRIVATE_READ_FAILURE' }
        return $script:keys.Dequeue()
    }
} -ArgumentList $functions
try {
    foreach ($mode in @('characters', 'backspace', 'empty-backspace', 'limit', 'overflow',
        'empty', 'escape', 'ctrl-c', 'control', 'read-failure')) {
        & $inputModule {
            param($Mode)
            $script:keys = [Collections.Generic.Queue[object]]::new()
            $script:limit = 4
            $script:expectedValue = 'abc'; $script:expectedMask = '***'; $script:success = $true
            $events = @('a', 'b', 'c', 'Enter')
            switch ($Mode) {
                'backspace' { $events = @('a', 'b', 'Backspace', 'c', 'Enter'); $script:expectedValue = 'ac'; $script:expectedMask = "**`b `b*" }
                'empty-backspace' { $events = @('Backspace', 'a', 'Enter'); $script:expectedValue = 'a'; $script:expectedMask = '*' }
                'limit' { $events = @('a', 'b', 'c', 'd', 'Enter'); $script:expectedValue = 'abcd'; $script:expectedMask = '****' }
                'overflow' { $events = @('a', 'b', 'c', 'd', 'e'); $script:expectedMask = '****'; $script:success = $false }
                'empty' { $events = @('Enter'); $script:expectedMask = ''; $script:success = $false }
                'escape' { $events = @('a', 'Escape'); $script:expectedMask = '*'; $script:success = $false }
                'ctrl-c' { $events = @('a', 'CtrlC'); $script:expectedMask = '*'; $script:success = $false }
                'control' { $events = @('a', 'Tab'); $script:expectedMask = '*'; $script:success = $false }
                'read-failure' { $events = @('a'); $script:expectedMask = '*'; $script:success = $false }
            }
            foreach ($event in $events) {
                $key = switch ($event) {
                    'Enter' { [ConsoleKeyInfo]::new([char]13, [ConsoleKey]::Enter, $false, $false, $false) }
                    'Backspace' { [ConsoleKeyInfo]::new([char]8, [ConsoleKey]::Backspace, $false, $false, $false) }
                    'Escape' { [ConsoleKeyInfo]::new([char]27, [ConsoleKey]::Escape, $false, $false, $false) }
                    'CtrlC' { [ConsoleKeyInfo]::new([char]3, [ConsoleKey]::C, $false, $false, $true) }
                    'Tab' { [ConsoleKeyInfo]::new([char]9, [ConsoleKey]::Tab, $false, $false, $false) }
                    default { [ConsoleKeyInfo]::new([char]$event, [ConsoleKey]::A, $false, $false, $false) }
                }
                $script:keys.Enqueue($key)
            }
            $script:actual = $null
        } $mode
        $output = Capture-M1 { & $inputModule {
            try { $script:actual = Read-M1HiddenValue 'Fixture' $script:limit; return 0 }
            catch { [Console]::Error.WriteLine('M1_LAUNCHER_FAILED'); return 1 }
        } }
        $expected = & $inputModule {
            $expectedText = 'Fixture: ' + $script:expectedMask
            if ($script:success -or ($script:keys.Count -eq 0 -and $script:expectedMask -eq '')) {
                $expectedText += [Environment]::NewLine
            }
            return @{ Code = $(if ($script:success) { 0 } else { 1 }); Out = $expectedText;
                Err = $(if ($script:success) { '' } else { 'M1_LAUNCHER_FAILED' + [Environment]::NewLine }) }
        }
        Assert-M1 ($output.Code -eq $expected.Code -and $output.Out -ceq $expected.Out -and $output.Err -ceq $expected.Err)
        & $inputModule {
            if ($null -ne $script:actual) {
                try {
                    if (-not $script:actual.IsReadOnly() -or
                        (Convert-M1HiddenValue $script:actual) -cne $script:expectedValue) { throw 'MASKED_INPUT_MISMATCH' }
                } finally { $script:actual.Dispose(); $script:actual = $null }
            }
        }
        $script:cases++
    }
} finally { Remove-Module $inputModule }

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
    $fake | Add-Member ScriptMethod WaitForExit { param([int] $Milliseconds)
        if ($Milliseconds -ne 0) { throw 'UNBOUNDED_NORMAL_WAIT' }
        $this.Waited = $true
        return $true
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

# Real supervisor + launcher cleanup, with controllable non-network process/pipe failures.
$supervisor = New-Module -ScriptBlock {
    param($Code, $Root)
    . ([scriptblock]::Create($Code))
    $script:M1InspectDirectory = $Root
    $script:productionLimits = Get-M1InspectLimits
    function script:Get-M1InspectLimits { return @{ RuntimeMs = 500; StopMs = 80; PollMs = 1; OutChars = 2048; ErrChars = 128 } }
    function script:Test-M1InteractiveConsole { return $true }
    function script:Read-M1HiddenValue([string] $Label, [int] $Limit) {
        $secret = [Security.SecureString]::new()
        $text = if ($Label.Contains('URL')) { 'https://supervisor-synthetic.invalid' } else { 'SYNTHETIC_PRIVATE_TOKEN' }
        foreach ($c in $text.ToCharArray()) { $secret.AppendChar($c) }
        return $secret
    }
    function New-FakePipe([string] $Mode, [string] $Text) {
        $pipe = [pscustomobject]@{ Mode = $Mode; Text = $Text; Offset = 0; Disposed = $false; LargestRead = 0;
            Pending = [Threading.Tasks.TaskCompletionSource[int]]::new() }
        $pipe | Add-Member ScriptMethod ReadAsync { param([char[]] $Buffer, [int] $Offset, [int] $Count)
            $this.LargestRead = [Math]::Max($this.LargestRead, $Count)
            if ($this.Mode -eq 'pending') { return $this.Pending.Task }
            if ($this.Mode -eq 'throw') { throw 'SYNTHETIC_PRIVATE_READ' }
            if ($this.Mode -eq 'fault') { return [Threading.Tasks.Task]::FromException[int]([Exception]::new('SYNTHETIC_PRIVATE_READ')) }
            $length = [Math]::Min($Count, $this.Text.Length - $this.Offset)
            if ($length -gt 0) { $this.Text.CopyTo($this.Offset, $Buffer, $Offset, $length); $this.Offset += $length }
            return [Threading.Tasks.Task]::FromResult[int]($length)
        }
        $pipe | Add-Member ScriptMethod Dispose { $this.Disposed = $true; [void] $this.Pending.TrySetCanceled() }
        return $pipe
    }
    function script:New-M1InspectChild {
        $ok = '{"status":"legacy","version":"diff-modal-01:v1","source_bytes":0,"source_fingerprint":"' + ('a' * 64) + '","migration_id":null}'
        $outMode = 'text'; $outText = $ok; $errText = ''
        switch ($script:mode) {
            { $_ -in @('timeout', 'never-stop', 'kill-fail', 'stop-wait-fail') } { $outMode = 'pending' }
            'stdout-limit' { $outText = 'SYNTHETIC_PRIVATE_OUTPUT' * 200 }
            'stderr-limit' { $errText = 'SYNTHETIC_PRIVATE_OUTPUT' * 100 }
            'stdout-exact' { $outText = 'x' * 2048 }
            'stderr-exact' { $errText = 'x' * 128 }
            'read-throw' { $outMode = 'throw' }
            'read-fault' { $outMode = 'fault' }
            'fixed-error' { $outText = ''; $errText = "M1_MIGRATION_SOURCE_SCHEMA`n" }
        }
        $script:outPipe = New-FakePipe $outMode $outText
        $script:errPipe = New-FakePipe 'text' $errText
        $script:fake = [pscustomobject]@{
            StartInfo = [Diagnostics.ProcessStartInfo]::new(); StandardInput = [IO.StringWriter]::new();
            StandardOutput = $script:outPipe; StandardError = $script:errPipe;
            ExitCode = $(if ($script:mode -eq 'fixed-error') { 1 } else { 0 }); Mode = $script:mode;
            Started = $false; Killed = $false; Confirmed = $false; Disposed = $false; TreeKill = $false;
            Events = [Collections.Generic.List[string]]::new(); Waits = [Collections.Generic.List[int]]::new()
        }
        $script:fake | Add-Member ScriptMethod Start {
            $this.Events.Add('start')
            if ($this.Mode -eq 'start-false') { return $false }
            $this.Started = $true
            if ($this.Mode -eq 'start-throw') { throw 'SYNTHETIC_PRIVATE_START' }
            return $true
        }
        $script:fake | Add-Member ScriptMethod Kill { param([bool] $Tree)
            $this.Events.Add('kill'); $this.TreeKill = $Tree
            if ($this.Mode -eq 'kill-fail') { throw 'SYNTHETIC_PRIVATE_KILL' }
            $this.Killed = $true
        }
        $script:fake | Add-Member ScriptMethod WaitForExit { param([int] $Milliseconds)
            $this.Waits.Add($Milliseconds)
            if ($Milliseconds -lt 0 -or $Milliseconds -gt 80) { throw 'BAD_WAIT_BOUND' }
            if ($this.Mode -eq 'wait-fail' -and -not $this.Killed) { throw 'SYNTHETIC_PRIVATE_WAIT' }
            if ($this.Mode -eq 'stop-wait-fail' -and $this.Killed) { throw 'SYNTHETIC_PRIVATE_WAIT' }
            if ($this.Mode -in @('never-stop', 'kill-fail', 'stop-wait-fail')) { return $false }
            if (-not $this.Killed -and $this.Mode -notin @('success', 'fixed-error', 'stdout-exact', 'stderr-exact')) { return $false }
            if (-not $this.Confirmed) {
                if (-not $this.StartInfo.Environment.ContainsKey('M1_PRODUCTION_REDIS_URL') -or
                    -not $this.StartInfo.Environment.ContainsKey('M1_PRODUCTION_REDIS_TOKEN')) { throw 'PREMATURE_INPUT_RELEASE' }
                $this.Events.Add('confirmed')
            }
            $this.Confirmed = $true
            return $true
        }
        $script:fake | Add-Member ScriptMethod Dispose {
            $this.Events.Add('dispose'); $this.Disposed = $true
            if ($this.StartInfo.Environment.ContainsKey('M1_PRODUCTION_REDIS_URL') -or
                $this.StartInfo.Environment.ContainsKey('M1_PRODUCTION_REDIS_TOKEN')) { throw 'INPUT_NOT_REMOVED' }
        }
        return $script:fake
    }
} -ArgumentList $functions, $PSScriptRoot
try {
    & $supervisor {
        if ($script:productionLimits.RuntimeMs -ne 60000 -or $script:productionLimits.StopMs -ne 5000 -or
            $script:productionLimits.OutChars -ne 2048 -or $script:productionLimits.ErrChars -ne 128) { throw 'BAD_PRODUCTION_LIMITS' }
    }
    $script:cases++
    foreach ($mode in @('success', 'fixed-error', 'timeout', 'stdout-limit', 'stderr-limit', 'stdout-exact',
        'stderr-exact', 'read-throw', 'read-fault', 'wait-fail', 'start-false', 'start-throw', 'never-stop', 'kill-fail', 'stop-wait-fail')) {
        & $supervisor { param($Mode) $script:mode = $Mode } $mode
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $output = Capture-M1 { & $supervisor { Invoke-M1InspectLauncher } }
        Assert-M1 ($clock.ElapsedMilliseconds -lt 3000)
        if ($mode -eq 'success') {
            if ($output.Code -ne 0) {
                $diagnostic = & $supervisor { return ($script:fake.Events -join ',') + ';reads=' + $script:outPipe.Offset + ',' + $script:errPipe.Offset }
                throw ('SUPERVISOR_FIXTURE_FAILURE ' + $diagnostic)
            }
            Assert-M1 ($output.Code -eq 0 -and $output.Err -eq '')
        } else {
            $expected = switch ($mode) {
                'timeout' { 'M1_LAUNCHER_TIMEOUT' }
                { $_ -in @('stdout-limit', 'stderr-limit') } { 'M1_LAUNCHER_OUTPUT_LIMIT' }
                { $_ -in @('never-stop', 'kill-fail', 'stop-wait-fail') } { 'M1_LAUNCHER_STOP_UNCONFIRMED' }
                'fixed-error' { 'M1_MIGRATION_SOURCE_SCHEMA' }
                default { 'M1_LAUNCHER_FAILED' }
            }
            Assert-M1 ($output.Code -eq 1 -and $output.Out -eq '' -and $output.Err.Trim() -ceq $expected)
        }
        Assert-M1 (-not ($output.Out + $output.Err).Contains('SYNTHETIC_PRIVATE'))
        Assert-M1 (-not ($output.Out + $output.Err).Contains('supervisor-synthetic.invalid'))
        & $supervisor {
            if (-not $script:fake.Disposed) { throw 'NOT_DISPOSED' }
            $needsKill = $script:mode -notin @('success', 'fixed-error', 'stdout-exact', 'stderr-exact', 'start-false')
            if ($needsKill -and -not $script:fake.TreeKill) { throw 'TREE_KILL_MISSING' }
            if ($script:fake.Confirmed -and
                $script:fake.Events.IndexOf('confirmed') -ge $script:fake.Events.IndexOf('dispose')) { throw 'DISPOSE_BEFORE_CONFIRMATION' }
            if ($script:fake.StartInfo.Environment.ContainsKey('M1_PRODUCTION_REDIS_URL') -or
                $script:fake.StartInfo.Environment.ContainsKey('M1_PRODUCTION_REDIS_TOKEN')) { throw 'INPUT_RETAINED' }
            if ($script:outPipe.LargestRead -gt 256 -or $script:errPipe.LargestRead -gt 129 -or
                $script:outPipe.Offset -gt 2049 -or $script:errPipe.Offset -gt 129) { throw 'UNBOUNDED_READ' }
        }
        Assert-M1 ([Environment]::GetEnvironmentVariable('M1_PRODUCTION_REDIS_URL', 'Process') -ceq 'SYNTHETIC_PARENT_URL')
        Assert-M1 ([Environment]::GetEnvironmentVariable('M1_PRODUCTION_REDIS_TOKEN', 'Process') -ceq 'SYNTHETIC_PARENT_TOKEN')
        $script:cases++
    }
} finally { Remove-Module $supervisor }

# Real, owned Node fixture + grandchild: no loader, SDK, file I/O, or networking.
# PID handoff is synthetic test metadata only, consumed in memory without display.
$real = New-Module -ScriptBlock {
    param($Code, $Root)
    . ([scriptblock]::Create($Code))
    $script:M1InspectDirectory = $Root
    function script:Get-M1InspectLimits { return @{ RuntimeMs = 1500; StopMs = 1000; PollMs = 10; OutChars = 2048; ErrChars = 128 } }
    function script:Test-M1InteractiveConsole { return $true }
    function script:Read-M1HiddenValue([string] $Label, [int] $Limit) {
        $secret = [Security.SecureString]::new()
        $text = if ($Label.Contains('URL')) { 'https://owned-fixture.invalid' } else { 'SYNTHETIC_OWNED_TOKEN' }
        foreach ($c in $text.ToCharArray()) { $secret.AppendChar($c) }
        return $secret
    }
    function script:New-M1InspectChild {
        $info = [Diagnostics.ProcessStartInfo]::new()
        $info.FileName = (Get-Command node -CommandType Application | Select-Object -First 1).Source
        $info.UseShellExecute = $false; $info.CreateNoWindow = $true
        $info.RedirectStandardInput = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
        [void] $info.Environment.Remove('NODE_OPTIONS')
        [void] $info.Environment.Remove('NODE_PATH')
        $fixture = @'
const {spawn} = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore', windowsHide: true});
process.stdout.write(String(child.pid) + '\n');
const mode = process.argv[1];
if (mode === 'stdout-limit') process.stdout.write('SYNTHETIC_PRIVATE_FLOOD'.repeat(1000));
if (mode === 'stderr-limit') process.stderr.write('SYNTHETIC_PRIVATE_FLOOD'.repeat(1000));
setInterval(() => {}, 1000);
'@
        $info.ArgumentList.Add('-e'); $info.ArgumentList.Add($fixture); $info.ArgumentList.Add($script:mode)
        $owned = [Diagnostics.Process]::new(); $owned.StartInfo = $info
        $script:proxy = [pscustomobject]@{ Owned = $owned; StartInfo = $info; StandardInput = $null;
            StandardOutput = $null; StandardError = $null; RootObserver = $null; Descendant = $null;
            Confirmed = $false; Disposed = $false; TreeKill = $false }
        $script:proxy | Add-Member ScriptMethod Start {
            if (-not $this.Owned.Start()) { return $false }
            $this.RootObserver = [Diagnostics.Process]::GetProcessById($this.Owned.Id)
            $this.StandardInput = $this.Owned.StandardInput
            $this.StandardOutput = $this.Owned.StandardOutput
            $this.StandardError = $this.Owned.StandardError
            $line = $this.StandardOutput.ReadLineAsync()
            if (-not $line.Wait(3000)) { throw 'FIXTURE_START_TIMEOUT' }
            $pidText = $line.GetAwaiter().GetResult()
            if ($pidText -notmatch '\A[0-9]{1,10}\z') { throw 'FIXTURE_PID_FAILED' }
            $this.Descendant = [Diagnostics.Process]::GetProcessById([int] $pidText)
            return $true
        }
        $script:proxy | Add-Member ScriptMethod WaitForExit { param([int] $Milliseconds)
            $ended = $this.Owned.WaitForExit($Milliseconds)
            if ($ended) { $this.Confirmed = $true }
            return $ended
        }
        $script:proxy | Add-Member ScriptMethod Kill { param([bool] $Tree)
            $this.TreeKill = $Tree; $this.Owned.Kill($Tree)
        }
        $script:proxy | Add-Member ScriptMethod Dispose {
            if (-not $this.Confirmed) { throw 'FIXTURE_DISPOSE_BEFORE_CONFIRMATION' }
            $this.Disposed = $true; $this.Owned.Dispose()
        }
        return $script:proxy
    }
} -ArgumentList $functions, $PSScriptRoot
try {
    foreach ($mode in @('timeout', 'stdout-limit', 'stderr-limit')) {
        & $real { param($Mode) $script:mode = $Mode; $script:proxy = $null } $mode
        try {
            $clock = [Diagnostics.Stopwatch]::StartNew()
            $output = Capture-M1 { & $real { Invoke-M1InspectLauncher } }
            Assert-M1 ($clock.ElapsedMilliseconds -lt 7000)
            $expected = if ($mode -eq 'timeout') { 'M1_LAUNCHER_TIMEOUT' } else { 'M1_LAUNCHER_OUTPUT_LIMIT' }
            Assert-M1 ($output.Code -eq 1 -and $output.Out -eq '' -and $output.Err.Trim() -ceq $expected)
            & $real {
                if (-not $script:proxy.TreeKill -or -not $script:proxy.Confirmed -or -not $script:proxy.Disposed -or
                    -not $script:proxy.RootObserver.WaitForExit(2000) -or
                    -not $script:proxy.Descendant.WaitForExit(2000)) { throw 'OWNED_TREE_NOT_STOPPED' }
                if ($script:proxy.StartInfo.Environment.ContainsKey('M1_PRODUCTION_REDIS_URL') -or
                    $script:proxy.StartInfo.Environment.ContainsKey('M1_PRODUCTION_REDIS_TOKEN')) { throw 'OWNED_INPUT_RETAINED' }
            }
            Assert-M1 ([Environment]::GetEnvironmentVariable('M1_PRODUCTION_REDIS_URL', 'Process') -ceq 'SYNTHETIC_PARENT_URL')
            Assert-M1 ([Environment]::GetEnvironmentVariable('M1_PRODUCTION_REDIS_TOKEN', 'Process') -ceq 'SYNTHETIC_PARENT_TOKEN')
            $script:cases++
        } finally {
            # Failure cleanup is restricted to handles created by this synthetic fixture.
            & $real {
                if ($null -ne $script:proxy) {
                    foreach ($owned in @($script:proxy.RootObserver, $script:proxy.Descendant)) {
                        if ($null -ne $owned) {
                            try { if (-not $owned.HasExited) { $owned.Kill($true); [void] $owned.WaitForExit(2000) } }
                            finally { $owned.Dispose() }
                        }
                    }
                }
            }
        }
    }
} finally { Remove-Module $real }

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
