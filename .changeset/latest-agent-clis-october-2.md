---
'@cat-factory/executor-harness': patch
'@cat-factory/deploy-harness': patch
'@cat-factory/local-server': patch
---

Update the runner image to Pi 1.3.0, Claude Code 2.1.302 and Codex 0.163.0, the latest npm releases
taken without the 24-hour age threshold, and the Pi extensions `rpiv-todo` / `rpiv-web-tools` to
2.13.8 inside it (the newest release past the window). The executor and UI image pins move to
1.163.5. The deploy image moves to 0.8.5 because the dependency refresh moved its toolchain.
