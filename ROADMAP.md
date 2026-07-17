# JetGit Plus Roadmap

This file records intentionally deferred Git dashboard work so temporary UI removals do not become forgotten features.

## Branch dashboard

### Show My Branches

Reintroduce this only after its semantics can match JetBrains closely. A branch qualifies when the commits exclusive to that branch are authored by the current Git user; identity matching must respect configured name/email and `.mailmap`. The implementation needs graph-aware ancestry queries, a cached per-repository author index, multi-repo invalidation, and acceptable performance on large histories. Until then, no placeholder button should be shown.

### Compare with Current

Restore branch/ref comparison with repository-safe content URIs. Both sides must carry the selected repository id and full ref (`refs/heads/...`, `refs/remotes/...`, or `refs/tags/...`) through `buildGitContentUri`, and the comparison must remain pinned to that repository if the global active repository changes.

### Batch and strategy-aware Update

Consider multi-selection update and user-selectable merge/rebase strategies after single-branch upstream-safe Update has proven stable. Batch execution must report per-branch outcomes and must never update a branch checked out in another worktree.

## Repository discovery

The first multi-repo release intentionally discovers Git repositories only from multi-root workspace folders. A later milestone may discover multiple repositories nested inside one workspace folder, followed by more complex nested repository layouts. Discovery must preserve stable repository identities, deterministic de-duplication, explicit user control, and worktree-safe Git directory watching.
