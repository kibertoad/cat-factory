---
'@cat-factory/app': patch
---

Give every pipeline-conflict toast a translated description and a jump action (error-message initiative G1).

Before this, only a conflict's title was resolved from an i18n key; the description fell back to the
raw, untranslated backend `message`. Every mapped `ConflictReason` now carries a translated
`errors.conflict.description.<reason>` (remedy prose) across all ten locales, and the reasons a UI
panel can fix (`github_not_connected`, `env_test_no_vcs`, `agent_backend_unconfigured`,
`preset_unsatisfiable`, `model_policy_blocked`, `env_test_not_provisionable`) carry a one-click jump
to the panel that fixes them — the same actionable, sticky-toast shape as the existing
`providers_unconfigured` case, but data-driven from a single exhaustive `CONFLICT_INFO` map instead
of one `if` per reason. The raw backend message is now shown only as a last-resort description for an
unmapped reason.
