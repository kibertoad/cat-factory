---
'@cat-factory/executor-harness': patch
'@cat-factory/local-server': patch
---

Runner image: take Claude Code to `2.1.278`.

The three agent CLI pins are the documented exception to the 24h release-age window the workspace
dependencies are held to, so this takes the newest published release rather than the newest aged
one. Pi stays at `0.85.1` and Codex at `0.154.0`, both of which are where they already were: Pi
because that is still its latest, Codex by request.

Image content changed, so the harness version and every tag pin move with it, which is what makes a
deployment's next `image:publish` actually roll out.
