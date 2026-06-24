---
"@cat-factory/app": minor
---

Declutter the left navbar: collapse every integration into a single "Integrations" hub.

The per-integration buttons that used to be spread across the navbar (GitHub, Slack, the
dynamic document/task sources + their import actions, Issue-tracker writeback, Post-release
health/Datadog, Vendors & keys, My local runners, OpenRouter models) are gone from the rail.
They are replaced by ONE **Integrations** button that opens a new `IntegrationsHub` modal —
a grouped list (source control, communication, documents, task trackers, observability,
model providers) of every external system the workspace can enable/link. Each row reuses the
existing per-integration `ui.open*` panel handlers, so the integrations themselves are
unchanged; a row shows its connected status and opening one dismisses the hub to reveal that
integration's own panel. Sections gate on the same `available` probes the navbar used, so a
backend-disabled system simply doesn't appear. The Configuration section keeps only true
workspace settings (merge thresholds, workspace settings, default models, default service
best practices).
