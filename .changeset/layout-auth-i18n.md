---
'@cat-factory/app': patch
---

Localize the layout + auth components (phase 3 of the app i18n migration).

All user-facing copy in the auth screens and the layout chrome now resolves through
`@nuxtjs/i18n` instead of hard-coded strings:

- **Auth** (`auth.*`): the login / signup / forgot-password screen, the
  reset-password screen, the auth gate loading state, and the user menu.
- **Layout** (`layout.*`): the account-level deployment / fragment / team settings,
  the AI-providers / GitHub-PAT / provider-config / spend-warning banners, the board
  switcher, the command bar (command labels plus search keywords), the integrations
  hub (status, groups, per-item labels), the integration back-title, the
  notifications inbox (per-notification-type actions), and the personal-setup modal.
- **SideBar** is now fully migrated: it switched off the global `$t` to the
  destructured `t`.

New keys ship in all five bundled locales (en/es/fr/pl/uk). The connected-count in
the personal-setup modal uses correct plural forms (3-form for pl/uk); the spend
warning formats currency through the vue-i18n number formatter; and enum-keyed
lookups (notification type, invitation status, provider-config reason) use exhaustive
`Record` maps (the tier-2 drift guard).
