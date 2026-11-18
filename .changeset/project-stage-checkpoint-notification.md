---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': patch
'@cat-factory/conformance': patch
'@cat-factory/app': patch
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

A project stage whose result awaits a person's acceptance raises a `stage_checkpoint` notification on the board that homes the project, naming the stage's task; accepting the stage settles it. It counts as review debt, has its Slack and email titles and a Slack routing row, and opens the stage's task from the inbox. `ProjectStageService` gains `announceCheckpoint` and takes the notification service. Public API 1.106.0: the notification type vocabulary gains `stage_checkpoint`.
