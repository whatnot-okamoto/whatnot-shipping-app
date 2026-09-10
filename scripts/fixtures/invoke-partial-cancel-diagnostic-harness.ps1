param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [System.IO.Path]::GetFullPath(
    [System.IO.Path]::Combine($PSScriptRoot, "..", "..")
)
$launcherPath = [System.IO.Path]::Combine(
    $repositoryRoot, "scripts", "invoke-partial-cancel-diagnostic.ps1"
)
$childPath = [System.IO.Path]::Combine(
    $repositoryRoot, "scripts", "fixtures", "partial-cancel-launcher-child.mjs"
)
$source = [System.IO.File]::ReadAllText($launcherPath)

$inputOverride = @'
$fixedTestToken = [Environment]::GetEnvironmentVariable("PARTIAL_CANCEL_TEST_TOKEN")
function Read-Host {
    param([string]$Prompt, [switch]$AsSecureString)
    if (-not $AsSecureString) { throw "fixed test input requires secure input" }
    if ($fixedTestToken -ceq "__EMPTY__") { return [System.Security.SecureString]::new() }
    return ConvertTo-SecureString -String $fixedTestToken -AsPlainText -Force
}
'@

$repositoryPattern = '(?ms)\$repositoryRoot = \[System\.IO\.Path\]::GetFullPath\(\r?\n\s+\[System\.IO\.Path\]::Combine\(\$PSScriptRoot, "\.\."\)\r?\n\s+\)'
$scriptPattern = '(?ms)\$scriptPath = \[System\.IO\.Path\]::Combine\(\r?\n\s+\$repositoryRoot, "scripts", "diagnose-partial-cancel\.mjs"\r?\n\s+\)'
$repositoryRegex = [regex]::new($repositoryPattern)
$scriptRegex = [regex]::new($scriptPattern)
if (
    $repositoryRegex.Matches($source).Count -ne 1 -or
    $scriptRegex.Matches($source).Count -ne 1
) {
    throw "test harness source shape changed"
}
$harness = $repositoryRegex.Replace(
    $source,
    '$repositoryRoot = ' + "'" + $repositoryRoot.Replace("'", "''") + "'",
    1
)
$harness = $scriptRegex.Replace(
    $harness,
    '$scriptPath = ' + "'" + $childPath.Replace("'", "''") + "'",
    1
)
$harness = $harness.Replace(
    '$PROCESS_WATCHDOG_MS = 180000',
    '$PROCESS_WATCHDOG_MS = 2000'
)
$harness = $harness.Replace(
    '$POST_KILL_WAIT_MS = 10000',
    '$POST_KILL_WAIT_MS = 2000'
)
$harness = ([regex]::new('param\(\)\r?\n')).Replace(
    $harness,
    "param()`r`n$inputOverride`r`n",
    1
)

if (
    $harness.Contains('$PROCESS_WATCHDOG_MS = 180000') -or
    $harness.Contains('$POST_KILL_WAIT_MS = 10000') -or
    -not $harness.Contains($inputOverride.Trim())
) {
    throw "test harness replacement failed"
}

& ([ScriptBlock]::Create($harness))
