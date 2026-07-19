---
'@cat-factory/integrations': patch
---

GitHub doc fragments/context can now be linked from any repository the workspace
can actually read, not only ones whose owner matches the workspace's GitHub
installation account. `GitHubDocsProvider` dropped its preemptive owner-string
guard: every read already rides the workspace's own installation/PAT token, and
GitHub scopes that token to what it may read, so tenant isolation is enforced by
the token itself — a foreign tenant's private repo still 404s at the read. The
guard was also blocking legitimate reads (a public guidelines repo owned by
another account, or a PAT that spans accounts in local mode), which raised a
confusing "outside this workspace's installation" error for a repo the token
could genuinely reach.
