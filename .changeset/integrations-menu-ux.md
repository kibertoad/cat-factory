---
'@cat-factory/app': minor
---

Restructure the Integrations menu for usability. The hub is now purely
workspace-scoped: per-user connections (personal GitHub token, local model
runners, personal subscriptions) move into a new user-scoped **My setup** hub
reached from the user menu (with a "Personal (only you)" fallback group in the
hub when auth is disabled, so nothing becomes unreachable). The hub gains a
search filter, an explicit per-row state ("Connected" / amber "Disabled" /
muted "Not connected") with connected rows sorted first, a "Get started" cue
recommending GitHub + a model provider on an empty workspace, and demotes the
issue-tracker settings entry to a quiet footer link.
