---
'@cat-factory/app': patch
---

Make personal (individual-usage) subscription management discoverable during setup. The most
common setup, using a Claude / ChatGPT (Codex) / GLM coding plan the developer already pays for,
was reachable only as the last tab of the LLM-vendors modal, and none of the onboarding surfaces
routed there.

- The "Set up an AI model provider" onboarding dialog now leads with a "Your coding-plan
  subscription" route (tagged "Most popular") that deep-links straight onto the vendor modal's
  Personal subscriptions tab.
- The 428 credential-required modal's "Connect subscription" CTA now opens the Personal
  subscriptions tab instead of landing on the unrelated workspace-pool tab (bug).
- The workspace-pool tab (the modal's default) gains a callout pointing individual-plan users at
  the Personal subscriptions tab, replacing the cross-reference sentence buried in the intro
  paragraph.
- The Integrations hub's "Models and providers" group gains a footer link to personal
  subscriptions, since that hub is where people look first even though the connection is
  per-user.
