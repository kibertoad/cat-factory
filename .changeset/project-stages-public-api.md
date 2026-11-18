---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/conformance': patch
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

A staged project's stages are served and driven through the public API: `GET /api/v1/projects/{projectId}/stages` lists each stage with its derived state, `POST .../stages/{stageId}/tasks` starts one (`write`), and `POST .../stages/{stageId}/checkpoint` accepts its newest result (`decide`), each with an SDK method (`projects.listStages`, `startStage`, `acceptStage`) and an MCP tool. A public outcome names its `taskType`, and a project kind serves `schemas.outcomes`, each task type's body schema. `ProjectStageService` gains `list`, and `ProjectOutcomeReader.list` takes the project. Public API 1.105.0.
