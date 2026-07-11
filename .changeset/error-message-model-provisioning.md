---
'@cat-factory/agents': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/server': patch
---

Elaborate the model-provisioning failure messages with cause + fix + doc links (error-message
coverage initiative, items B1–B4). Each terse throw now names the condition, the likely cause,
the exact remedy (UI-first where the setting is UI-configurable, the env var otherwise), and links
`backend/docs/model-support.md` / `docs/environment-variables.md`.

- **B1** — `Unsupported model provider: X` (`CompositeModelProvider.resolve`) now explains that the
  provider has no credentials configured, names the workspace AI provider key pool as the primary
  fix for the UI-configurable direct providers and the deployment env vars (`CLOUDFLARE_*`,
  `BEDROCK_REGION`) as the alternative, and lists the currently-registered providers as a diagnostic.
- **B2** — `Unsupported Bedrock model: X` now names the `BEDROCK_MODELS` allow-list, echoes the
  models it currently permits, and tells the operator to add the id or pick an allowed one.
- **B3** — LiteLLM selected without a base URL gets a dedicated remedy naming `LITELLM_BASE_URL`
  (an operator-hosted gateway has no public default), instead of the generic "no base URL" message.
- **B4** — `No base URL configured for OpenAI-compatible provider 'X'` now names the
  `${PROVIDER}_BASE_URL` var and the workspace key pool. The inline model resolver and the container
  LLM proxy share one helper (`openAiCompatibleBaseUrlError`) so both surfaces read identically.

Adds a small `providers/docs.ts` doc-URL module to `@cat-factory/agents` (it sits below the server
layer, so it cannot use `@cat-factory/server`'s `config/docs.ts`); `@cat-factory/provider-bedrock`
imports it. No behaviour changes beyond the message text.
