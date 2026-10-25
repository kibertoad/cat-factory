---
'@cat-factory/app': patch
---

Failures shown inline in a panel now read the same as the failure toasts: a translated description
first, with the server's own message and the request ID behind "Show details". This covers the
settings connection tests and audit log, the MCP authorize screen, the context pickers, the
inspector detect buttons, and the panels and stores that printed a raw error or an English
"Failed to load".
