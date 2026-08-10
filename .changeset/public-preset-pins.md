---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

Let `/api/v1` callers pin what a task runs on (surface 1.43.0). `GET /api/v1/model-presets` lists
the model library, task create and task PATCH accept `modelPresetId` and `riskPolicyId`, and the
task projection reads both back. A pinned id no library carries is refused with `details.reason`
naming which one it missed, rather than falling back to the default, because a run that quietly
used another model succeeds while being about something else. The check lives on `BoardService`, so
the SPA, tracker intake, an initiative spawn and blueprint reconciliation get the same refusal.

**Breaking, deliberately, on a surface with no adopters:** `GET /api/v1/merge-presets` is renamed
to `GET /api/v1/risk-policies` in place (response `presets` → `policies`, `presetId` → `policyId`,
SDK group `mergePresets` → `riskPolicies`, reasons `merge_preset_*` → `risk_policy_*`). It shipped
one release ago under the name the product renamed away from a month before that, and the id it
serves is what a task pins as `riskPolicyId`, so leaving it would put two names for one concept on
one wire permanently. `backend/docs/public-api-versions.md` records why this is an exception to ADR
0034 rather than a precedent.
