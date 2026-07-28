---
'@cat-factory/local-server': patch
---

Carry the `phase` / `turnIndex` telemetry axes through the mothership-mode local SQLite telemetry
store. The columns landed on the D1 and Drizzle stores but not on the `node:sqlite` mirror, so a
mothership-mode node could not compile against `LlmCallMetric` — and would have dropped both axes
on every locally-recorded call.
