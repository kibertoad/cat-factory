---
'@cat-factory/executor-harness': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/local-server': patch
---

Project targets are read-only unless a stage writes. A target may declare `access: 'write'` and a `pathPrefix`, and a stage may declare `writes`; a writing stage must run after a stage a person accepts at a checkpoint, in a definition with a writable target. A project job's `http_request` now sends only GET, HEAD and OPTIONS to a target unless that target allows writes and the run is a writing stage, and reaches only paths under a target's prefix. Runner image 1.168.0.

This tightens existing research projects: their runs reach their vendor read-only through the API tool, where only the researcher's instructions asked for that before. A definition that names neither field hashes as before, so existing pins stay valid.
