---
'@cat-factory/app': patch
---

UX papercuts (docs/initiatives/ux-papercuts.md): stop leaking raw internal identifiers into
the review and consensus windows (UX-36/37).

- The requirements- and clarity-review windows now render the reviewer's model through
  `models.labelForRef(...)` (friendly `<label> · <provider>` label) instead of the raw
  `provider:model` id, matching the pipeline step surfaces; it falls back to the bare ref when
  the catalog hasn't loaded, so there is no regression.
- The consensus session window renders the step's `agentKind` through `agentKindMeta(...).label`
  (a human title) instead of the raw enum, and each participant's model through
  `models.labelForRef(...)` instead of the raw `modelId`.
