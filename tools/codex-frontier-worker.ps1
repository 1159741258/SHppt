[CmdletBinding()]
param(
    [string]$Repo = "",
    [string]$RepoPath = "",
    [int]$IntervalMinutes = 15,
    [switch]$Once,
    [switch]$DryRun,
    [int]$IssueNumber = 0
)

$ErrorActionPreference = "Stop"

function Invoke-ExternalText {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $output = & $FilePath @Arguments 2>&1

    if ($LASTEXITCODE -ne 0) {
        $details = ($output | Out-String).Trim()
        throw "$FilePath failed with exit code $LASTEXITCODE. $details"
    }

    return ($output -join "`n").Trim()
}

function Invoke-RepoCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory
    )

    $output = & $FilePath -C $WorkingDirectory @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        $details = ($output | Out-String).Trim()
        throw "$FilePath failed with exit code $LASTEXITCODE. $details"
    }

    return ($output -join "`n").Trim()
}

function Invoke-GhText {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    return Invoke-ExternalText -FilePath "gh" -Arguments $Arguments
}

function Invoke-GhJson {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $text = Invoke-GhText -Arguments $Arguments
    if ([string]::IsNullOrWhiteSpace($text)) {
        return $null
    }

    return $text | ConvertFrom-Json
}

function Write-JsonFile {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Value,
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $parent = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    $json = $Value | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Get-LabelNames {
    param([object]$Issue)

    return @($Issue.labels | ForEach-Object { $_.name })
}

function Get-LoginNames {
    param([object]$Issue)

    return @($Issue.assignees | ForEach-Object { $_.login })
}

function Get-DefaultBranch {
    return Invoke-GhText -Arguments @(
        "repo", "view", $script:Repo,
        "--json", "defaultBranchRef",
        "--jq", ".defaultBranchRef.name"
    )
}

function Get-RepositoryNameFromRemote {
    $remote = Invoke-RepoCommand -FilePath "git" -Arguments @("remote", "get-url", "origin") -WorkingDirectory $script:RepoPath
    if ($remote -notmatch "github\.com[:/]([^/]+/[^/.]+?)(?:\.git)?$") {
        throw "Could not derive GitHub repository name from origin remote: $remote"
    }

    return $Matches[1]
}

function Get-IssueCandidates {
    if ($script:RequestedIssueNumber -gt 0) {
        return @(
            Invoke-GhJson -Arguments @(
                "issue", "view", "$script:RequestedIssueNumber",
                "--repo", $script:Repo,
                "--json", "number,title,body,state,labels,assignees,createdAt,url"
            )
        )
    }

    return @(
        Invoke-GhJson -Arguments @(
            "issue", "list",
            "--repo", $script:Repo,
            "--state", "open",
            "--label", "ready-for-agent",
            "--limit", "1000",
            "--json", "number,title,body,state,labels,assignees,createdAt,url"
        ) | Sort-Object -Property number
    )
}

function Get-IssueDetails {
    param([int]$Number)

    $issue = Invoke-GhJson -Arguments @(
        "issue", "view", "$Number",
        "--repo", $script:Repo,
        "--json", "number,title,body,state,labels,assignees,comments,url"
    )
    $apiIssue = Invoke-GhJson -Arguments @(
        "api", "repos/$($script:Repo)/issues/$Number"
    )

    $dependencySummary = $apiIssue.issue_dependencies_summary
    $comments = @($issue.comments | ForEach-Object { $_.body })

    return [ordered]@{
        number = $issue.number
        title = $issue.title
        body = $issue.body
        state = $issue.state
        url = $issue.url
        labels = @(Get-LabelNames -Issue $issue)
        assignees = @(Get-LoginNames -Issue $issue)
        comments = $comments
        issue_dependencies_summary = $dependencySummary
    }
}

function Get-OpenCodexPullRequests {
    return @(
        Invoke-GhJson -Arguments @(
            "pr", "list",
            "--repo", $script:Repo,
            "--state", "open",
            "--limit", "1000",
            "--json", "headRefName,body,number,url"
        )
    )
}

function Test-OpenCodexPullRequest {
    param(
        [object]$PullRequest,
        [int]$Number
    )

    $branchPrefix = "codex/issue-$Number-"
    if ($PullRequest.headRefName -and $PullRequest.headRefName.StartsWith($branchPrefix)) {
        return $true
    }

    $body = [string]$PullRequest.body
    if ($body -and $body -match "(?i)(fixes|closes|resolves)\s+#$Number(?:\D|$)") {
        return $true
    }

    return $false
}

function Get-BlockedCount {
    param([int]$Number)

    $value = Invoke-GhText -Arguments @(
        "api", "repos/$($script:Repo)/issues/$Number",
        "--jq", ".issue_dependencies_summary.blocked_by // 0"
    )
    return [int]$value
}

function Find-EligibleIssue {
    $openPullRequests = @(Get-OpenCodexPullRequests)
    foreach ($candidate in @(Get-IssueCandidates)) {
        $number = [int]$candidate.number
        $labels = @(Get-LabelNames -Issue $candidate)
        $assignees = @(Get-LoginNames -Issue $candidate)

        if ($candidate.state -ne "OPEN" -and $candidate.state -ne "open") {
            continue
        }

        if ($labels -notcontains "ready-for-agent") {
            Write-Host "Skipping #${number}: missing ready-for-agent label."
            continue
        }

        if ($labels -contains "agent-running" -or
            $labels -contains "ready-for-human" -or
            $labels -contains "wontfix") {
            Write-Host "Skipping #${number}: excluded label."
            continue
        }

        if ($assignees.Count -gt 0) {
            Write-Host "Skipping #${number}: assigned to $($assignees -join ', ')."
            continue
        }

        $blockedCount = Get-BlockedCount -Number $number
        if ($blockedCount -ne 0) {
            Write-Host "Skipping #${number}: $blockedCount open native blocker(s)."
            continue
        }

        if (@($openPullRequests | Where-Object { Test-OpenCodexPullRequest -PullRequest $_ -Number $number }).Count -gt 0) {
            Write-Host "Skipping #${number}: open Codex pull request already exists."
            continue
        }

        return Get-IssueDetails -Number $number
    }

    return $null
}

function Add-IssueComment {
    param(
        [int]$Number,
        [string]$Body
    )

    $null = Invoke-GhText -Arguments @(
        "issue", "comment", "$Number",
        "--repo", $script:Repo,
        "--body", $Body
    )
}

function Claim-Issue {
    param([int]$Number)

    $null = Invoke-GhText -Arguments @(
        "issue", "edit", "$Number",
        "--repo", $script:Repo,
        "--add-label", "agent-running"
    )
    Add-IssueComment -Number $Number -Body @"
> *This was generated by a local Codex worker.*

The local worker claimed this Issue. It will be processed while it remains open, agent-ready, and unblocked.
"@
}

function Release-IssueForHuman {
    param(
        [int]$Number,
        [string]$Reason
    )

    try {
        $null = Invoke-GhText -Arguments @(
            "issue", "edit", "$Number",
            "--repo", $script:Repo,
            "--remove-label", "agent-running"
        )
        $null = Invoke-GhText -Arguments @(
            "issue", "edit", "$Number",
            "--repo", $script:Repo,
            "--add-label", "ready-for-human"
        )
        Add-IssueComment -Number $Number -Body @"
> *This was generated by a local Codex worker.*

The local worker stopped without opening a pull request and released this Issue for human review.

Reason: $Reason
"@
    } catch {
        Write-Warning "Could not release Issue #${Number}: $($_.Exception.Message)"
    }
}

function Get-IssueNumbersFromPullRequest {
    param([string]$Body)

    if ([string]::IsNullOrWhiteSpace($Body)) {
        return @()
    }

    return @(
        [regex]::Matches($Body, "(?i)(fixes|closes|resolves)\s+#(\d+)") |
            ForEach-Object { [int]$_.Groups[2].Value } |
            Sort-Object -Unique
    )
}

function Cleanup-ClosedCodexPullRequests {
    $closedPullRequests = @(
        Invoke-GhJson -Arguments @(
            "pr", "list",
            "--repo", $script:Repo,
            "--state", "closed",
            "--limit", "1000",
            "--json", "body,headRefName,mergedAt,number,url"
        )
    )

    foreach ($pullRequest in $closedPullRequests) {
        if (-not ($pullRequest.headRefName -and $pullRequest.headRefName.StartsWith("codex/issue-"))) {
            continue
        }

        foreach ($number in @(Get-IssueNumbersFromPullRequest -Body ([string]$pullRequest.body))) {
            $issue = Invoke-GhJson -Arguments @(
                "issue", "view", "$number",
                "--repo", $script:Repo,
                "--json", "state,labels"
            )
            if ($null -eq $issue) {
                continue
            }

            $labels = @(Get-LabelNames -Issue $issue)
            if ($labels -notcontains "agent-running") {
                continue
            }

            $null = Invoke-GhText -Arguments @(
                "issue", "edit", "$number",
                "--repo", $script:Repo,
                "--remove-label", "agent-running"
            )

            if ($pullRequest.mergedAt) {
                Add-IssueComment -Number $number -Body @"
> *This was generated by a local Codex worker.*

The Codex pull request was merged. The local worker released the Issue lock.
"@
            } else {
                $null = Invoke-GhText -Arguments @(
                    "issue", "edit", "$number",
                    "--repo", $script:Repo,
                    "--add-label", "ready-for-agent"
                )
                Add-IssueComment -Number $number -Body @"
> *This was generated by a local Codex worker.*

The Codex pull request was closed without merging. The Issue is available on the local agent frontier again.
"@
            }
        }
    }
}

function New-AgentWorktree {
    param(
        [int]$Number,
        [string]$DefaultBranch
    )

    $stamp = Get-Date -Format "yyyyMMddHHmmss"
    $branch = "codex/issue-$Number-$stamp"
    $worktreePath = Join-Path $env:TEMP "codex-frontier-$Number-$stamp-$([guid]::NewGuid().ToString('N'))"

    $null = Invoke-RepoCommand -FilePath "git" -Arguments @("fetch", "origin", $DefaultBranch) -WorkingDirectory $script:RepoPath
    $null = Invoke-RepoCommand -FilePath "git" -Arguments @(
        "worktree", "add", "-b", $branch, $worktreePath, "origin/$DefaultBranch"
    ) -WorkingDirectory $script:RepoPath

    return [pscustomobject]@{
        Branch = $branch
        Path = $worktreePath
    }
}

function Remove-AgentWorktree {
    param(
        [string]$Path,
        [string]$Branch
    )

    if ($Path -and (Test-Path -LiteralPath $Path)) {
        try {
            $null = Invoke-RepoCommand -FilePath "git" -Arguments @("worktree", "remove", "--force", $Path) -WorkingDirectory $script:RepoPath
        } catch {
            Write-Warning "Could not remove worktree $($Path): $($_.Exception.Message)"
        }
    }

    if ($Branch) {
        try {
            $null = Invoke-RepoCommand -FilePath "git" -Arguments @("branch", "-D", $Branch) -WorkingDirectory $script:RepoPath
        } catch {
            Write-Warning "Could not remove local branch $($Branch): $($_.Exception.Message)"
        }
    }
}

function Write-IssueRuntime {
    param(
        [object]$Issue,
        [string]$WorktreePath
    )

    $runtimePath = Join-Path $WorktreePath ".github\codex\runtime\issue.json"
    Write-JsonFile -Value $Issue -Path $runtimePath
}

function Invoke-LocalCodex {
    param(
        [object]$Issue,
        [string]$WorktreePath
    )

    Write-IssueRuntime -Issue $Issue -WorktreePath $WorktreePath
    $promptPath = Join-Path $WorktreePath ".github\codex\prompts\implement-issue.md"
    $outputPath = Join-Path $env:TEMP "codex-frontier-output-$($Issue.number)-$([guid]::NewGuid().ToString('N')).md"

    if (-not (Test-Path -LiteralPath $promptPath)) {
        throw "Prompt file not found: $promptPath"
    }

    $prompt = Get-Content -LiteralPath $promptPath -Raw
    Write-Host "Running local codex exec for Issue #$($Issue.number)..."
    $prompt | & codex exec `
        --cd $WorktreePath `
        --sandbox workspace-write `
        --ephemeral `
        --output-last-message $outputPath `
        -
    if ($LASTEXITCODE -ne 0) {
        throw "codex exec failed with exit code $LASTEXITCODE"
    }

    $runtimePath = Join-Path $WorktreePath ".github\codex\runtime\issue.json"
    Remove-Item -LiteralPath $runtimePath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $outputPath -Force -ErrorAction SilentlyContinue
}

function New-PullRequestFromWorktree {
    param(
        [object]$Issue,
        [string]$WorktreePath,
        [string]$Branch,
        [string]$DefaultBranch
    )

    $status = Invoke-RepoCommand -FilePath "git" -Arguments @("status", "--porcelain") -WorkingDirectory $WorktreePath
    if ([string]::IsNullOrWhiteSpace($status)) {
        throw "codex exec completed without producing a repository change"
    }

    $null = Invoke-RepoCommand -FilePath "git" -Arguments @("add", "--all") -WorkingDirectory $WorktreePath
    $null = Invoke-RepoCommand -FilePath "git" -Arguments @("diff", "--cached", "--check") -WorkingDirectory $WorktreePath
    $null = Invoke-RepoCommand -FilePath "git" -Arguments @("config", "user.name", "Codex Local Worker") -WorkingDirectory $WorktreePath
    $null = Invoke-RepoCommand -FilePath "git" -Arguments @("config", "user.email", "codex-local-worker@users.noreply.github.com") -WorkingDirectory $WorktreePath
    $null = Invoke-RepoCommand -FilePath "git" -Arguments @("commit", "-m", "Implement issue #$($Issue.number)") -WorkingDirectory $WorktreePath
    $null = Invoke-RepoCommand -FilePath "git" -Arguments @("push", "--set-upstream", "origin", $Branch) -WorkingDirectory $WorktreePath

    $title = "Implement issue #$($Issue.number): $($Issue.title)" -replace "\s+", " "
    if ($title.Length -gt 180) {
        $title = $title.Substring(0, 177) + "..."
    }

    $bodyPath = Join-Path $env:TEMP "codex-frontier-pr-$($Issue.number)-$([guid]::NewGuid().ToString('N')).md"
    $body = @"
Codex generated this change locally for #$($Issue.number).

Fixes #$($Issue.number)

The PR was created by the local Windows Codex worker and requires human review before merging.
"@
    [System.IO.File]::WriteAllText($bodyPath, $body, [System.Text.UTF8Encoding]::new($false))

    try {
        return Invoke-GhText -Arguments @(
            "pr", "create",
            "--repo", $script:Repo,
            "--base", $DefaultBranch,
            "--head", $Branch,
            "--title", $title,
            "--body-file", $bodyPath
        )
    } finally {
        Remove-Item -LiteralPath $bodyPath -Force -ErrorAction SilentlyContinue
    }
}

function Process-Issue {
    param(
        [object]$Issue,
        [string]$DefaultBranch
    )

    $worktree = $null
    try {
        Claim-Issue -Number $Issue.number
        $worktree = New-AgentWorktree -Number $Issue.number -DefaultBranch $DefaultBranch
        Invoke-LocalCodex -Issue $Issue -WorktreePath $worktree.Path
        $prUrl = New-PullRequestFromWorktree `
            -Issue $Issue `
            -WorktreePath $worktree.Path `
            -Branch $worktree.Branch `
            -DefaultBranch $DefaultBranch

        Add-IssueComment -Number $Issue.number -Body @"
> *This was generated by a local Codex worker.*

The local Codex worker opened a pull request: $prUrl
"@
        Write-Host "Created pull request: $prUrl"
    } catch {
        $reason = $_.Exception.Message -replace "\s+", " "
        if ($reason.Length -gt 700) {
            $reason = $reason.Substring(0, 697) + "..."
        }
        Write-Warning "Issue #$($Issue.number) failed: $reason"
        Release-IssueForHuman -Number $Issue.number -Reason $reason
    } finally {
        if ($worktree) {
            Remove-AgentWorktree -Path $worktree.Path -Branch $worktree.Branch
        }
    }
}

if ([string]::IsNullOrWhiteSpace($RepoPath)) {
    $RepoPath = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$script:RepoPath = (Resolve-Path -LiteralPath $RepoPath).Path
$script:RequestedIssueNumber = $IssueNumber

$null = Get-Command gh -ErrorAction Stop
$null = Get-Command git -ErrorAction Stop
$null = Get-Command codex -ErrorAction Stop
$null = Invoke-GhText -Arguments @("auth", "status")

if ([string]::IsNullOrWhiteSpace($Repo)) {
    $script:Repo = Get-RepositoryNameFromRemote
} else {
    $script:Repo = $Repo
}

$defaultBranch = Get-DefaultBranch
if ($IntervalMinutes -lt 1) {
    throw "IntervalMinutes must be at least 1."
}

do {
    try {
        Write-Host "Checking local Codex frontier for $($script:Repo)..."
        if (-not $DryRun) {
            Cleanup-ClosedCodexPullRequests
        }
        $issue = Find-EligibleIssue
        if ($null -eq $issue) {
            Write-Host "No eligible Issue found."
        } elseif ($DryRun) {
            Write-Host "Dry run selected Issue #$($issue.number): $($issue.title)"
        } else {
            Write-Host "Selected Issue #$($issue.number): $($issue.title)"
            Process-Issue -Issue $issue -DefaultBranch $defaultBranch
        }
    } catch {
        Write-Warning $_.Exception.Message
    }

    if (-not $Once) {
        Write-Host "Sleeping for $IntervalMinutes minute(s)."
        Start-Sleep -Seconds ($IntervalMinutes * 60)
    }
} while (-not $Once)
