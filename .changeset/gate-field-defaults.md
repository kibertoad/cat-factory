---
'@cat-factory/orchestration': patch
---

A gate parameter's declared default now reaches the gate. When a pipeline step leaves a parameter empty, the run freezes the gate's own default onto the gate state, and pipeline save and run admission validate the same filled values. A `required` gate parameter with no value and no default is now refused with `details.reason: 'gate_config_fields_invalid'` (and a `problems` list), also when the step carries no gate configuration at all.
