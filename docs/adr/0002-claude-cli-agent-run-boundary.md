---
status: accepted
---

# Keep Claude CLI execution inside a Daemon-controlled AgentRun

P0 treats Claude CLI as an untrusted, version-varying execution provider. The Browser never starts it and never receives its absolute process paths. The trusted Daemon probes the installed CLI before a run, starts it with a restricted Project boundary and an explicit Hard scope, and reconciles actual file effects after the process exits.

P0 gives each AgentRun its own Project Session. A Project Session can be resumed only for that same unfinished AgentRun and only after the Daemon proves that the project identity, File Index snapshot, CLI capability fingerprint, provider/model policy, permission profile, and Hard scope are unchanged. A new Annotation always starts a new Session. One normal AgentRun contains one initial Turn; mid-turn steering and multi-Annotation orchestration are out of scope.

Process exit status and streamed `result` frames are not sufficient evidence of success. The Daemon maintains an append-only side-effect ledger, compares canonical file hashes with the pinned snapshot, rejects writes outside the explicit writable-path set, and creates an ArtifactVersion only after the result and preview are reconciled. A run with a valid change ends in `needs_review`; only an explicit user confirmation can resolve its Annotation.

The complete execution, permission, stream, recovery, and error-action contract is defined in [the Claude CLI and AgentRun contract](../specs/claude-cli-agent-run-contract.md). This decision depends on the physical Content Root boundary in ADR-0001 and leaves ArtifactVersion persistence and file-watcher transport details to their later contracts.
