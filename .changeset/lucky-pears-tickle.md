---
'@cat-factory/executor-harness': patch
'@cat-factory/local-server': patch
---

Runner image: take Pi to `0.86.0`.

The three agent CLI pins are the documented exception to the 24h release-age window the workspace
dependencies are held to, so this takes the newest published release rather than the newest aged
one. Claude Code stays at `2.1.278`, which is still its newest, and Codex at `0.154.0` by request.

Image content changed, so the harness version and every tag pin move with it, which is what makes a
deployment's next `image:publish` actually roll out.
