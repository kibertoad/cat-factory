---
'@cat-factory/app': patch
---

Refresh the model catalog when a personal (individual-usage) subscription is connected or
disconnected, so the AI-readiness surfaces react immediately.

Connecting a personal subscription (Claude / GLM / Codex) in `PersonalSubscriptionSection`
now calls `models.refresh(workspaceId)`, mirroring the direct-API-key flow. Previously the
per-workspace catalog stayed stale, so the "No AI model configured" banner persisted even
though the connected subscription already made its models usable.

With the catalog refreshed, the existing reactive readiness signals do the rest:

- The "No AI model configured" banner clears once a subscription makes a model usable.
- If the workspace default preset still points at models the subscription doesn't cover,
  the default-preset-mismatch banner + dialog surface immediately, with the link to pick a
  different preset.

Starting tasks with an incompatible preset was already blocked server-side
(`providers_unconfigured`), which accounts for the initiator's personal subscriptions.
