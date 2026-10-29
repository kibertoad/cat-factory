---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/consensus': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/conformance': minor
'@cat-factory/executor-harness': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/gatekeeper-bindings': minor
'@cat-factory/mcp-server': minor
---

Images can be attached to a task as context, when creating it or later from the inspector (up to six per task). They are stored as `context` artifacts in the account's binary-artifact storage, kept for as long as the task exists, and removed with it.

The agents that work on the task are shown them as real image input wherever their model path accepts images: an inline step attaches them to its model request, the requirements, clarity and brainstorm reviewers do the same, and a container step on an image-capable CLI gets them as files under `.cat-context/task-images/`. Where a step cannot carry an image (a text-only model, an undeclared model, a Pi or Codex container, the ambient text-only inline path, a consensus panel or a delegated executor) its prompt names the images and states why they were withheld.

`GET /api/v1/runs/{runId}/artifacts` can now list a `context` artifact (task-scoped) beside screenshots, references and assets: the OpenAPI surface is 1.90.0. The executor image is 1.164.0, which parses the new `taskImages` job field and reports it on the capability handshake.
