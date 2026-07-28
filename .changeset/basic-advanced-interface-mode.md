---
'@cat-factory/app': minor
---

Split the SPA into basic and advanced interface modes, launching in basic by default. Basic hides
the power-user navigation destinations (pipeline builder, fragment library, sandbox, Kaizen,
infrastructure/environment setup, merge thresholds, service fragment defaults, local models, the
operator dashboards) and the run options that only exist to override a workspace-level default
(merge policy, model preset, per-task best-practice fragments, tracker writeback, the technical hint). The tier resolves as `NUXT_PUBLIC_UI_MODE` → the user's browser-stored choice →
basic; while the env value is set the in-app switcher is a read-only indicator. The sidebar can also
collapse to an icon rail, which basic mode always starts in.
