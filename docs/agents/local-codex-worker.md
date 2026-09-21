# Local Codex Worker

The local worker runs the frontier loop on Windows. GitHub is used for issue and pull request state; Codex runs through the local `codex exec` command.

## Prerequisites

- PowerShell 7
- Git
- GitHub CLI authenticated with permission to edit issues and create pull requests
- Codex CLI available on `PATH`
- The repository clone has an `origin` remote

Check the local installation from the repository root:

```powershell
gh auth status
codex --version
```

## Verify selection

This only reads GitHub state. It does not claim an Issue or run Codex:

```powershell
pwsh -NoProfile -File .\tools\codex-frontier-worker.ps1 -Once -DryRun
```

## Run once

This claims the first eligible Issue, runs local Codex in an isolated temporary worktree, pushes a branch, and opens a pull request:

```powershell
pwsh -NoProfile -File .\tools\codex-frontier-worker.ps1 -Once
```

## Keep polling

The default interval is 15 minutes:

```powershell
pwsh -NoProfile -File .\tools\codex-frontier-worker.ps1
```

Use Windows Task Scheduler to start that command at logon if the worker should run unattended. The task must run under the Windows account that has the intended GitHub CLI and Codex authentication/configuration.

The worker ignores `wayfinder:*` labels, requires `ready-for-agent`, skips native blockers, skips assigned Issues, and avoids Issues with an open matching Codex pull request.
