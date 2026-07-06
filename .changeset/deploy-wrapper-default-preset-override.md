---
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
---

Expose the seeded default model preset as a programmatic override on the deploy-app boot
seams, so a deployment can change its out-of-the-box default without editing library code.

- `start({ defaultModelPresetId })` (Node) and `startLocal({ defaultModelPresetId })` (local)
  now accept the catalog id of the built-in preset a fresh workspace is seeded with as its
  default; it is forwarded to `buildNodeContainer` / `buildLocalContainer` (both the Postgres
  and mothership local paths). The Worker already honours `defaultModelPresetId` via
  `createApp`'s / `buildContainer`'s `overrides`; that read is now explicit rather than
  relying on the trailing spread.
- `MODEL_PRESET_SEED_IDS` and `DEFAULT_MODEL_PRESET_ID` are re-exported from all three facade
  packages, so a wrapper can name a preset (`.kimi` / `.glm` / `.claude`) without a direct
  `@cat-factory/kernel` import.

Applied only at the first seed of a workspace, so a user's later manual default choice is
always preserved. Facade defaults are unchanged (Node/Cloudflare → Kimi K2.7, local → Claude
Opus 4.8). Documented in the `deploy/{node,local,backend}` READMEs.
