---
'@cat-factory/app': patch
---

Localize the AI provider surfaces (phase 5 of the app i18n migration).

All user-facing copy in the `providers/**` components now resolves through `@nuxtjs/i18n`
instead of hard-coded strings, under the `providers.*` namespace:

- The default-preset mismatch dialog (`AiPresetMismatchDialog`) and the AI-provider
  onboarding modal (`AiProviderOnboardingModal`, the keys/OpenRouter/local-runner routes).
- The personal-credential password prompt (`PersonalCredentialModal`, the reason-keyed
  title + connect-vs-unlock bodies).
- The direct/proxy provider API-keys section (`ApiKeysSection`, per-vendor labels + guided
  steps, scope/provider pickers, caching note, connected-key usage).
- The pooled LLM-vendor credentials modal (`VendorCredentialsModal`, tabs, pool intro,
  per-vendor guided steps, connected-token usage).

New keys ship in all five bundled locales (en/es/fr/pl/uk). The connected-key/token usage
readouts use plurals with the correct forms (3-form one/few/many for pl/uk) and format the
token count through the vue-i18n number formatter; per-vendor labels/steps resolve via
literal `t(...)` keys so the typed-message-key drift guard stays live.
