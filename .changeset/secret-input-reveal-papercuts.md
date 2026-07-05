---
'@cat-factory/app': patch
---

UX papercuts — secret/password inputs mask by default with a reveal toggle (section B, UX-19/UX-20)

- **UX-19 (P2): every password/secret field gets a show/hide toggle.** New shared
  `common/SecretInput.vue` primitive (mirroring `common/IconButton.vue` / `common/CopyButton.vue`)
  wraps `UInput` with a masked default (`type="password"`) and a trailing eye-toggle button —
  labeled and `aria-pressed` via the new `common.reveal` / `common.hide` keys — so a user can
  verify a pasted token, the leading cause of invalid-credential retries. It forwards every other
  UInput prop/listener via `$attrs` and binds with `v-model` exactly like `UInput`. Every bare
  `type="password"` field now routes through it: both auth screens (`LoginScreen`,
  `ResetPasswordScreen`), the descriptor-driven `DocumentSourceConnectModal` +
  `UserSecretsSection` (via a `:secret` prop that preserves the `field.secret`-conditional
  masking), `ObservabilityConnectionPanel`, `LocalModelEndpointsPanel`, `SlackPanel`,
  `PersonalCredentialModal`, plus the audit-missed surfaces `AccountDeploymentSettings`,
  `AccountTeamSettings`, `KubernetesEnvironmentForm` / `KubernetesEngineForm`,
  `ProviderManifestEditor`, and `PackageRegistriesPanel`.
- **UX-20 (P2): plaintext secret textareas are masked.** The four fully-visible secret
  `UTextarea`s (`ApiKeysSection`, `VendorCredentialsModal`, `OpenRouterCatalogPanel`,
  `PersonalSubscriptionSection`) are converted to the same masked-by-default `SecretInput`, so
  live vendor keys no longer render in cleartext (shoulder-surf / screen-share leakage).

Adds `common.reveal` / `common.hide` message keys across all eight locales.
