---
'@cat-factory/app': patch
---

Complete the infrastructure-picker translations, and correct the localization status doc.

`docs/localization.md` still described the SPA as shipping five bundled locales; ten ship. The doc
also credited `i18n:check` with enforcing key parity, which it does not do, and said nothing about
RTL.

Auditing the catalogs against that claim turned up a real gap behind it: the execution-backend and
test-env-backend picker labels and descriptions were missing from `es`/`fr`/`pl`/`uk` (12 keys each)
and `he` (1), so those users saw English. `InfrastructureBackendPicker.vue` holds the keys as strings
in a table and resolves them through `t(item.label)`, which `vue-i18n-extract` cannot see, so
`i18n:check` never reported them. All ten catalogs are now at full key parity.

Three labels in the same pickers had also drifted from `en` (`runner-pool` still read "self-hosted"
after `en` became "Custom runner pool (HTTP)") and are retranslated to match.
