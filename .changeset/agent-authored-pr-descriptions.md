---
'@cat-factory/executor-harness': minor
'@cat-factory/agents': minor
'@cat-factory/server': minor
---

Pipeline-opened pull requests now carry a reviewer briefing instead of the barebones dispatch-time text.

A PR-opening coding agent is asked (via the new `PR_DESCRIPTION_GUIDANCE` appended to its system prompt) to end its run by writing a reviewer-facing description — the problem, the decisions made and alternatives rejected, what to look out for — to a `.cat-pr-description.md` sentinel at the checkout root (one per sibling repo in a multi-repo run; an optional leading `# <title>` line sets the PR title). The harness lifts it (secret-scrubbed, size-capped with a visible truncation note, managed-report markers stripped, kept out of the commit) onto the PR it opens, falling back to the dispatch-time text when the agent wrote none. That fallback (`prBody`) is itself restructured as a briefing: the task, the human-chosen implementation approach with rejected alternatives when the fork-decision phase ran, and an explicit marker that no agent briefing exists.
