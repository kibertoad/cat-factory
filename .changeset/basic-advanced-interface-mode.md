---
'@cat-factory/app': minor
---

Split the SPA into basic and advanced interface modes, launching in basic by default. Basic hides
the power-user navigation destinations (pipeline builder, fragment library, sandbox, Kaizen,
infrastructure/environment setup, merge thresholds, service fragment defaults, local models, the
operator dashboards) and the run options that only exist to override a workspace-level default
(merge policy, model preset, per-task best-practice fragments, tracker writeback, the technical
hint). The tier resolves as `NUXT_PUBLIC_UI_MODE` → the user's browser-stored choice → basic;
while the env value is set the in-app switcher is a read-only indicator.

An override control is hidden only while it is actually unset: a block that already carries a
merge policy, model preset, technical label or tracker-writeback override keeps showing it in
basic mode, editable, so a run can never depend on a setting the current tier conceals. The tier
switch is also reachable from the command palette (`Switch interface mode`), so basic mode is not
a one-way door for a user who never finds the sidebar switcher.

The sidebar can collapse to an icon rail. The preference is per-tier — basic defaults to railed
and advanced to expanded, and each tier remembers its own choice across reloads.
