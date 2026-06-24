# deploy/frontend — example Cloudflare Pages deployment

This package is the **deployment** half of the frontend. All the SPA logic
(components, stores, composables, pages, types) lives in the published
[`@cat-factory/app`](../../frontend/app) Nuxt layer; this package is a thin Nuxt
app that `extends` the layer and carries only the per-deployment config: branding
overrides (`nuxt.config.ts`) and the Pages project (`wrangler.toml`).

Use it as a template: copy this directory, override the branding, point it at your
backend, and deploy.

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
