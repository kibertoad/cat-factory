---
'@cat-factory/cli': minor
---

Scaffolded local-mode `.env` no longer sets `LOCAL_HARNESS_IMAGE` to a mutable `:latest` tag.
It is now left UNSET by default (documented commented-out) so the backend runs the executor-harness
image version it was built and tested against; the guidance explains that you should pin it only to
lock to a specific version for testing or a hotfix. `--harness-image` still writes an explicit pin
active when supplied.
