---
'@cat-factory/executor-harness': patch
---

Fix `spawn E2BIG` when the Claude Code harness runs with a large composed system prompt.

The runner passed the system prompt as a single `--append-system-prompt <string>` argv, but Linux caps one argv string at `MAX_ARG_STRLEN` (128 KiB) regardless of the larger total `ARG_MAX`. A `pr-reviewer` prompt with best-practice fragments folded in reached ~150 KiB, so `execve` failed the whole spawn with `E2BIG` before the agent ran (clone succeeded, agent phase died at 0s). Small prompts still ride `--append-system-prompt`; a prompt that would overflow argv is now folded into the stdin task prompt instead (the same mechanism the Codex runner already uses), which has no size ceiling.
