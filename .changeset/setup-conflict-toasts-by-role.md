---
'@cat-factory/app': patch
---

A run that cannot start because of a setup gap (no AI provider, no content storage, an incomplete
service environment, no handler for the provision type, a failing deployment integration) now shows
the fix button only to someone who can make the fix. Everyone else gets the same toast, with one
more sentence that names who can fix it: a board admin, an account admin or the deployment operator.
This uses the same rule as the setup cards. The fix opens through the shared setup remedies.
