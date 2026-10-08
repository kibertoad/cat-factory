---
'@cat-factory/executor-harness': patch
'@cat-factory/deploy-harness': patch
'@cat-factory/local-server': patch
---

Update the runner image to Pi 1.1.0, Claude Code 2.1.295 and Codex 0.162.0, the latest npm releases
taken without the 24-hour age threshold, and the Pi extensions `rpiv-todo` / `rpiv-web-tools` to
2.12.0 inside it. The executor and UI image pins move to 1.163.3. The deploy image moves to 0.8.3
because the dependency refresh raised its `@types/node` floor.
