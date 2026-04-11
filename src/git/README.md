# git

Git and worktree operations.

This directory owns feature branch creation, task worktree lifecycle, overlap scanning helpers, rebase/merge helpers, and the git-specific contract surface consumed by the orchestrator. Merge-train queue logic lives in `@core/merge-train`; this layer only executes the git operations it requests.
