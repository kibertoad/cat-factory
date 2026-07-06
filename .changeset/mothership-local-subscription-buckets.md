---
'@cat-factory/local-server': patch
'@cat-factory/node-server': patch
---

Mothership mode: give the four remaining `local-sqlite` bucket repositories a `node:sqlite` home on
the laptop, so the subscription features and the local-mode settings panel work in mothership mode
(previously their services were OFF for lack of a database).

- The local credential store (`credentialStore.ts`) gains three sealed-credential repositories —
  `SqliteProviderSubscriptionTokenRepository` (the per-workspace pooled Claude Code / Codex / GLM
  subscription tokens), `SqlitePersonalSubscriptionRepository` (per-user individual-usage
  credentials, the outer double-encryption blob), and `SqliteSubscriptionActivationRepository`
  (their short-lived per-run, system-key-only copies). A new `localSettingsStore.ts` holds the
  local-mode operational settings singleton (`SqliteLocalSettingsRepository`), kept out of the
  credential store so its "only credentials" invariant holds.
- All mirror their `D1*` SQL (D1 is SQLite) and stay LOCAL for the same reason the API-key pool
  does: the tokens are leased + decrypted by the LOCAL container executor with the LOCAL key, so
  they must never traverse the machine API to the mothership.
- New `NodeContainerOptions` credential-override seams (`providerSubscriptionTokenRepository` /
  `personalSubscriptionRepository` / `subscriptionActivationRepository`, mirroring the existing
  `providerApiKeyRepository` seam) let `buildNodeSubscriptionService` /
  `buildNodePersonalSubscriptionService` build without a `db`; the activation repo is threaded once
  and shared by both its consumers (the personal-subscription service's mint + the engine core's
  clear-on-completion). `localSettingsService` is built in the local facade from the local-sqlite
  repo when there is no `db`.
