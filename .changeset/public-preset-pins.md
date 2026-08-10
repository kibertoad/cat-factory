---
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
---

Make the two preset knobs callable on `/api/v1` (surface 1.42.0, additive). `GET
/api/v1/model-presets` lists the workspace's model presets and which is the default, and task
create accepts `modelPresetId` and `riskPolicyId`. A pinned id no preset carries is refused with
`details.reason` naming which library it missed, rather than falling back to the default, because a
run that quietly used another model succeeds while being about something else.
