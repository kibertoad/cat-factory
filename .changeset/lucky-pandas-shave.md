---
'@cat-factory/app': patch
---

Remove the "Spawn from document" button from the service inspector. Spawning is now
board-level only: the planner is target-blind, so the frame-scoped path could only
flatten the planned frames into the target and discard the titles and types the
preview showed. The `frameId` capability remains on the endpoint.
