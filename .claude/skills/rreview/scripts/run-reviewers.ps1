#Requires -Version 7.2
param(
    [Parameter(Mandatory)][ValidatePattern('^[0-2]{3}$')][string]$Spec,
    [Parameter(Mandatory)][string]$OutDir,
    [Parameter(Mandatory)][string]$BriefFile,
    [string]$Repo = (Get-Location).Path,
    [string]$CodexModel,
    [string]$ClaudeModel = 'opus',
    [ValidateSet('read-only', 'workspace-write', 'danger-full-access')][string]$CodexSandbox = 'read-only',
    [int]$TimeoutMinutes = 60
)

$ErrorActionPreference = 'Stop'

function Invoke-Git {
    $out = git -C $Repo @args
    if ($LASTEXITCODE -ne 0) { throw "git $args failed ($LASTEXITCODE)" }
    $out
}

# Detects tracked edits and added/removed untracked files; edits inside existing untracked files are not covered.
function Get-TreeFingerprint {
    $text = (@(Invoke-Git status --porcelain=v1 -uall) + @(Invoke-Git diff HEAD --binary)) -join "`n"
    [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($text)))
}

$counts = $Spec.ToCharArray() | ForEach-Object { [int][string]$_ }
if (($counts | Measure-Object -Sum).Sum -eq 0) { throw "Spec $Spec requests no reviewers." }

$Repo = [IO.Path]::GetFullPath((git -C $Repo rev-parse --show-toplevel))
$BriefFile = (Resolve-Path -LiteralPath $BriefFile).Path
$OutDir = [IO.Path]::GetFullPath($OutDir)
if (($OutDir + '\').StartsWith($Repo + '\', [StringComparison]::OrdinalIgnoreCase)) {
    git -C $Repo check-ignore -q -- $OutDir
    if ($LASTEXITCODE -ne 0) { throw "OutDir inside the repository must be git-ignored: $OutDir" }
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$briefNote = "Read the request brief at '$BriefFile' first and judge the change against it."

$reviewers = [Collections.Generic.List[object]]::new()
function Add-Reviewer([string]$Name, [string]$Kind, [string[]]$Arguments) {
    $reviewers.Add([pscustomobject]@{
            Name = $Name; Kind = $Kind; Arguments = $Arguments
            Output = Join-Path $OutDir "$Name.md"; Log = Join-Path $OutDir "$Name.log"
            Process = $null; StdoutTask = $null; StderrTask = $null
            ExitCode = $null; TimedOut = $false; Seconds = 0; Error = $null; CostUsd = $null
        })
}

# Codex's Windows sandbox cannot launch the Microsoft Store pwsh (CreateProcessAsUserW error 5), so another pwsh goes first on codex's PATH.
$codexPath = $null
if ($IsWindows -and $counts[0] -gt 0) {
    $candidates = @(Get-Command pwsh -All -CommandType Application -ErrorAction SilentlyContinue |
            Where-Object Source -NotMatch '\\WindowsApps\\' | ForEach-Object Source)
    $candidates += Join-Path $HOME '.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe'
    $codexPwsh = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($codexPwsh) { $codexPath = (Split-Path -Parent $codexPwsh) + ';' + $env:PATH }
    else { Write-Warning 'No pwsh outside WindowsApps found; codex reviewers cannot run shell commands.' }
}

$codexModelArgs = @(if ($CodexModel) { '-m', $CodexModel })
for ($i = 1; $i -le $counts[0]; $i++) {
    $name = "codex-creview-$i"
    Add-Reviewer $name 'codex' (@('exec', '-C', $Repo) + $codexModelArgs + @('-s', $CodexSandbox,
            '--ephemeral', '--color', 'never', '-o', (Join-Path $OutDir "$name.md"), ('$creview ' + $briefNote)))
}
foreach ($skill in @(@{ Name = 'creview'; Count = $counts[1] }, @{ Name = 'sreview'; Count = $counts[2] })) {
    for ($i = 1; $i -le $skill.Count; $i++) {
        Add-Reviewer "claude-$($skill.Name)-$i" 'claude' @('-p', "/$($skill.Name) $briefNote",
            '--model', $ClaudeModel, '--output-format', 'json', '--no-session-persistence',
            '--add-dir', (Split-Path -Parent $BriefFile), '--disallowedTools', 'Edit', 'Write', 'NotebookEdit')
    }
}

$before = Get-TreeFingerprint

foreach ($r in $reviewers) {
    Remove-Item -LiteralPath $r.Output -ErrorAction SilentlyContinue
    try {
        $exe = (Get-Command $r.Kind -CommandType Application | Select-Object -First 1).Source
        $psi = [Diagnostics.ProcessStartInfo]::new($exe)
        foreach ($a in $r.Arguments) { $psi.ArgumentList.Add($a) }
        $psi.WorkingDirectory = $Repo
        if ($r.Kind -eq 'codex' -and $codexPath) { $psi.Environment['PATH'] = $codexPath }
        $psi.UseShellExecute = $false
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
        $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
        $r.Process = [Diagnostics.Process]::Start($psi)
        $r.Process.StandardInput.Close()
        $r.StdoutTask = $r.Process.StandardOutput.ReadToEndAsync()
        $r.StderrTask = $r.Process.StandardError.ReadToEndAsync()
    }
    catch {
        $r.Error = "start failed: $_"
    }
}

$deadline = [DateTime]::UtcNow.AddMinutes($TimeoutMinutes)
foreach ($r in ($reviewers | Where-Object Process)) {
    $p = $r.Process
    $remaining = [int][Math]::Max(0, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)
    if (-not $p.WaitForExit($remaining)) {
        $r.TimedOut = $true
        $p.Kill($true)
    }
    $p.WaitForExit()
    $r.ExitCode = $p.ExitCode
    $r.Seconds = [int]($p.ExitTime - $p.StartTime).TotalSeconds
    $stdout = $r.StdoutTask.GetAwaiter().GetResult()
    $stderr = $r.StderrTask.GetAwaiter().GetResult()
    Set-Content -LiteralPath $r.Log -Value ($stderr + "`n----- stdout -----`n" + $stdout) -Encoding utf8NoBOM

    if ($r.Kind -eq 'claude') {
        try {
            $json = $stdout | ConvertFrom-Json
            $r.CostUsd = $json.total_cost_usd
            if ($json.is_error) { $r.Error = 'claude reported is_error' }
            elseif ($json.result) { Set-Content -LiteralPath $r.Output -Value $json.result -Encoding utf8NoBOM }
        }
        catch {
            $r.Error = 'claude output is not JSON'
        }
    }
}

$after = Get-TreeFingerprint

$summary = [ordered]@{
    spec              = $Spec
    repo              = $Repo
    worktreeUnchanged = ($before -eq $after)
    reviewers         = @($reviewers | ForEach-Object {
            $hasOutput = (Test-Path -LiteralPath $_.Output) -and (Get-Item -LiteralPath $_.Output).Length -gt 0
            [ordered]@{
                name     = $_.Name
                ok       = (-not $_.Error) -and (-not $_.TimedOut) -and $_.ExitCode -eq 0 -and $hasOutput
                exitCode = $_.ExitCode
                timedOut = $_.TimedOut
                error    = $_.Error
                seconds  = $_.Seconds
                costUsd  = $_.CostUsd
                output   = $_.Output
                log      = $_.Log
            }
        })
}
$json = $summary | ConvertTo-Json -Depth 4
Set-Content -LiteralPath (Join-Path $OutDir 'summary.json') -Value $json -Encoding utf8NoBOM
$json
