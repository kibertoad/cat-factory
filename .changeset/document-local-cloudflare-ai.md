---
---

Docs: document using Cloudflare AI in local mode. The Node/local facade serves the
`workers-ai` models over Cloudflare's REST API (there is no Workers binding off-Worker),
gated on `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`; without a configured provider
the model picker shows nothing selectable. Fix the misleading "default Cloudflare Workers
AI routing" note in `deploy/local/.env.example` (it never listed the two required vars)
and add a "Using Cloudflare AI" section to `deploy/local/README.md` with how to mint a
Workers AI API token and find the account id (`wrangler whoami` or the accounts REST
endpoint). No code changes.
