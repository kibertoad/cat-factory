---
'@cat-factory/app': patch
---

A run that cannot start because of a setup gap now shows the fix button only to someone who can
make the fix. This covers the bespoke toasts (no AI provider, no content storage, an incomplete
service environment, no handler for the provision type, a failing deployment integration) and the
mapped ones with a fix (no runner pool, no GitHub connection, a blocked or unsatisfiable model, an
environment that cannot provision or connect). Everyone else gets the same toast, with one more
sentence that names who can fix it: a board admin, an account admin or the deployment operator.
This uses the same rule as the setup cards. The fix opens through the shared setup remedies, and
every one of these toasts can be copied with its request id.
