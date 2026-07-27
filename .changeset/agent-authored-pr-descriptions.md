---
'@cat-factory/executor-harness': minor
'@cat-factory/agents': minor
'@cat-factory/server': minor
---

Pipeline-opened pull requests now carry a reviewer briefing instead of the barebones dispatch-time text.

A PR-opening coding agent is asked (via the new `PR_DESCRIPTION_GUIDANCE` appended to its system prompt) to end its run by writing a reviewer-facing description — the problem, the decisions made and alternatives rejected, what to look out for — to a `.cat-pr-description.md` sentinel at the checkout root (one per sibling repo in a multi-repo run, plus the workspace root as a fallback for the primary; an optional leading `# <title>` line sets the PR title when it is the file's only `#` heading, so an agent using `#` for its section headings does not rename the PR to "Problem"). The harness lifts it (secret-scrubbed, size-capped with a visible truncation note, managed-report markers stripped, kept out of the commit) onto the PR it opens, falling back to the dispatch-time text when the agent wrote none.

A RESUMED run — whose PR is already open, so the create call answers 422 — now refreshes that PR's title and description in place, carrying the engine's managed verification-report region across. Only a real agent briefing refreshes; the generic fallback never does, so an edit a human made to a description is not clobbered.

Because the briefing is model-authored text landing on a host-parsed surface, it crosses a text boundary first: the harness carries a conformity-pinned copy of kernel's `hostMarkdown`, defusing issue references, account mentions and issue-closing keywords, and closing any code fence the briefing left open (an unbalanced one would otherwise swallow the verification report appended to the same body). The briefing's size budget leaves that report room under the host's body limit.

The dispatch-time fallback (`prBody`) is itself restructured as a briefing: the task, the human-chosen implementation approach with rejected alternatives when the fork-decision phase ran, and an explicit marker that no agent briefing exists — with each untrusted hole rendered through `hostMarkdown`.
