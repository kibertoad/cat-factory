---
'@cat-factory/executor-harness': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/local-server': patch
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

Project targets are read-only unless a stage writes. A target may declare `access: 'write'` and a `pathPrefix`, and a stage may declare `writes`; a writing stage must read at least one stage, every stage it reads must hold its result at a checkpoint, it cannot be repeatable, and its definition needs a writable target. Two targets on one origin must differ in `pathPrefix`, and a path with an encoded slash, backslash or dot, or a `;`, never matches a prefix. A project job's `http_request` now sends only GET, HEAD and OPTIONS to a target unless that target allows writes and the run is a writing stage, and reaches only paths under a target's prefix. Runner image 1.168.0; a deployment that overrides the executor image with an older one keeps sending any method, so the enforcement holds only on 1.168.0 or later. Public API 1.100.0.

This tightens existing research projects: their runs reach their vendor read-only through the API tool, where only the researcher's instructions asked for that before. A definition that names neither field hashes as before, so existing pins stay valid.
