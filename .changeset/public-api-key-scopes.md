---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Public API: per-key permission scopes + task deletion.

Inbound public-API keys now carry a `scope` on the `/api/v1` surface — an inclusive ladder
(`read` ⊂ `write` ⊂ `admin`) the controller enforces per endpoint: reads need `read`,
non-destructive mutations (create/start/stop/retry/edit a task, start an initiative run)
need `write`, and destructive operations need `admin`. A valid key whose scope is too low
gets `403 insufficient_scope` (distinct from the `401` an unknown key gets).

This unblocks the first destructive endpoint: `DELETE /api/v1/tasks/:taskId` (admin-scoped)
deletes a task and its run history, completing the Tier-1 task lifecycle.

The workspace token UI gains a scope selector on create; a minted key defaults to `write`.

Breaking (pre-1.0, external surface): `publicApiKeySchema` gains a required `scope` field
and the `public_api_keys` table gains a `scope` column (D1 ⇄ Drizzle). Existing keys backfill
to `write` — they keep every capability the surface shipped before scopes existed but do not
auto-gain the new destructive power, which must be minted `admin` explicitly.
