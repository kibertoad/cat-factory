---
'@cat-factory/local-server': patch
---

Carry the LLM call `phase` / `turnIndex` axes through the mothership-mode local telemetry store.
The axes landed on `LlmCallMetric` and the local-first `node:sqlite` telemetry store landed
independently, so neither PR saw the other: the store's schema, row mapping and insert never grew
the columns. Mirrors D1 telemetry migration `0004` column-for-column, as that store's contract
requires, so a mothership-mode node groups a run's spend by phase exactly like a D1 or Postgres
one instead of reporting every call as unattributed. An existing local telemetry database predates
the columns and is not migrated (it is short-retention, laptop-local state); delete the file to
pick up the new schema.
