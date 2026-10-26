---
'@cat-factory/orchestration': patch
'@cat-factory/contracts': minor
'@cat-factory/kernel': patch
'@cat-factory/app': patch
---

A gate parameter's declared default now reaches the gate. The new contracts helper `effectiveGateConfigFields` fills every parameter a step leaves unanswered (absent, a blank string or an empty multi-select) with the default the gate declared, and every reader goes through it: pipeline save and run admission validate its result, the engine freezes it onto the gate state, and the pipeline builder renders it. The builder still stores only what the author chose, so a default the deployment changes later reaches existing pipelines.

A `required` gate parameter with no value and no default is now refused at pipeline save and at run admission (start, retry and restart), also when the step carries no gate configuration at all. The refusal is a 422 with `details.reason: 'gate_config_fields_invalid'` and a `problems` list; the reason is exported as `GATE_CONFIG_REFUSAL_REASONS` and the SPA shows translated copy for it. The builder also shows a hint for such a step before save.

Boot now refuses a descriptor field whose declared default breaks its own rules (for example a number outside `min`/`max`) with `<surface>_field_default_invalid`, because every door fills defaults in and such a default would refuse every creation for a value the caller never sent.
