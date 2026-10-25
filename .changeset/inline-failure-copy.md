---
'@cat-factory/app': patch
---

Failures shown inline in a panel now read the same as the failure toasts: a translated description
first, with the server's own message and the request ID behind "Show details", and a "Copy
details" button. This covers the sites listed in #2420: the settings connection tests, GitLab
connect, the MCP authorize screen, the audit log and usage, the inspector detect buttons and context
pickers, and the PR review, bug fishing, fork decision, follow-up, bug hunt, sandbox, platform
observability, provisioning log and environment wizard stores. A few sibling surfaces still show
raw text and follow separately.
