---
'@cat-factory/app': patch
---

Localize the settings panels (phase 4 of the app i18n migration).

All user-facing copy in the workspace/account settings surface now resolves through
`@nuxtjs/i18n` instead of hard-coded strings, under the `settings.*` namespace:

- Model configuration presets editor and account settings tabs.
- Provider connection panel (ephemeral-environment + runner-pool, local delegation),
  service fragment defaults, and the issue-tracker panel (filing / linking / writeback).
- User secrets, merge-threshold presets, the observability connection + incident
  enrichment, and local-mode tuning (warm container pool + checkout reuse).
- The OpenRouter catalog, the workspace settings (waiting / task-limit / observability
  / retention / Kaizen / budget), and the local model endpoints.

314 new keys ship in all five bundled locales (en/es/fr/pl/uk). Plurals use the correct
forms (3-form one/few/many for pl/uk) on the model-override, enabled-model, runner-model
and connection counts; spend currency formats through the vue-i18n number formatter; and
enum-keyed lookups (tracker vendor, invitation status, provider-config reason, task-limit
mode) use exhaustive `Record` maps (the tier-2 drift guard).
