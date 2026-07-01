---
'@cat-factory/app': patch
---

UX quality-of-life pass (follow-up): complete the destructive-confirm coverage across the
settings/connection surfaces the first pass didn't reach. Add a reusable `useConfirmAction`
composable (built on the same `useConfirm()` singleton + `useToast()`) that gates the
recurring disconnect/remove/revoke/clear/destroy actions behind a confirmation and toasts on
success, so every such affordance routes through one confirm-then-mutate + feedback path
instead of mutating instantly and silently. Gated: revoke API key, revoke team invite,
disconnect email sender, disconnect observability / incident provider, clear release-health
config, destroy human-test environment, remove custom manifest type, remove reference
architecture, disconnect task/document source, remove provider connection, remove Kubernetes
handler / override / custom handler, and clear Slack / Linear / web-search config. Generic
`common.confirm.*` / `common.toast.*` copy added across all 8 locales.

The `clear` shape warns the config can be reconfigured later (a cleared config is
re-enterable) rather than reusing the harsher "can't be undone" copy of the
remove/revoke/destroy shapes, and destroying a human-test environment now surfaces an error
toast on failure instead of silently rejecting.
