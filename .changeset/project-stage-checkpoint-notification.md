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

A project stage whose result awaits a person's acceptance raises a `stage_checkpoint` notification on the board that homes the project, naming the stage's task; accepting the stage settles it. It is raised from the derived stage state, so a replay or the recovery of a completion that died after its write raises it again safely, and it stays out of review debt. It has its Slack and email titles and a Slack routing row (product and engineering), and opens the project on its stages through the new `project-stages` result view. `ProjectStageService` gains `announceCheckpoint` and takes the notification service. Public API 1.106.0: the notification type vocabulary gains `stage_checkpoint`.
