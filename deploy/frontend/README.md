# deploy/frontend — example Cloudflare Pages deployment

This package is the **deployment** half of the frontend. All the SPA logic
(components, stores, composables, pages, types) lives in the published
[`@cat-factory/app`](../../frontend/app) Nuxt layer; this package is a thin Nuxt
app that `extends` the layer and carries only the per-deployment config: branding
overrides (`nuxt.config.ts`) and the Pages project (`wrangler.toml`).

Use it as a template: copy this directory, override the branding, point it at your
backend, and deploy.

## Worked example: a consumer extension module

This template also ships a **worked example** of extending the SPA without forking
the layer — the frontend analogue of the backend
[`@cat-factory/example-custom-agent`](../../backend/internal/example-custom-agent)
package. `app/plugins/acme-security.client.ts` registers one module
(`app/modular/acme-security.ts`) that contributes to every landed consumer seam at
once: a bespoke run-detail window for the `security-auditor` agent kind (reusing the
layer's shared `ResultWindowShell` + `StepRunMeta` chrome), the palette entry that
routes that kind to the window, a sidebar/command-palette destination, an extra
inspector panel, and a CODE-shipped custom task type (`acme:incident`, with
descriptor-driven create-form fields) that becomes a first-class create-task choice +
card badge — all through the auto-imported `registerAppModule` seam, with zero host
edits. Its strings live in `i18n/locales/en.json` (deep-merged into the layer
catalog). Delete `app/plugins/acme-security.client.ts` (or the whole `app/` dir) to
drop it. See the authoring walkthrough in
[`frontend/app/app/docs/consumer-extensions.md`](../../frontend/app/app/docs/consumer-extensions.md).

## How it depends on the library

In this monorepo the dependency is `workspace:*`. **In your own deployment, depend
on the published npm version** instead:

```jsonc
// deploy/frontend/package.json
"dependencies": {
  "@cat-factory/app": "^0.6.0",   // instead of "workspace:*"
  "nuxt": "^4.4.8"
}
```

## Configure

- `nuxt.config.ts` — override `app.head.title`/meta/favicon and any layer config.
- `wrangler.toml` — set `name` to your Pages project.
- The backend URL is **not** in config: it is baked in at build time from
  `NUXT_PUBLIC_API_BASE` (the SPA is `ssr: false`).

## Run & deploy

```sh
pnpm dev                            # local dev against http://localhost:8787 (layer default)

# build the static SPA with your production API base, then deploy
NUXT_PUBLIC_API_BASE=https://catfactory-api.kiberion.com pnpm generate
pnpm deploy                         # wrangler pages deploy (project + dir from wrangler.toml)
```

PowerShell build step:

```powershell
$env:NUXT_PUBLIC_API_BASE = "https://catfactory-api.kiberion.com"; pnpm generate
```

Sanity-check after deploying:

```sh
curl -s https://catfactory-api.kiberion.com/health                              # {"status":"ok"}
curl -s https://catfactory.kiberion.com | grep -o catfactory-api.kiberion.com   # baked API base
```
