---
'@cat-factory/executor-harness': minor
'@cat-factory/agents': patch
'@cat-factory/consensus': patch
'@cat-factory/integrations': patch
'@cat-factory/kernel': patch
'@cat-factory/observability-langfuse': patch
'@cat-factory/orchestration': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/provider-cloudflare': patch
'@cat-factory/provider-s3': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/app': patch
---

Refresh dependencies (direct + transitive) and bump the coding-agent CLIs baked into the
runner image.

- **Runner image (`@cat-factory/executor-harness`, image tag `1.57.0`)**: Pi
  `0.80.6 → 0.82.1`, Claude Code `2.1.207 → 2.1.220`, Codex `0.144.1 → 0.145.0`, and the
  two Pi extensions `@juicesharp/rpiv-todo` / `@juicesharp/rpiv-web-tools`
  `1.20.0 → 2.1.0`. The todo extension's v2 tool result keeps the `details.tasks[]` shape
  (`subject` + `pending`/`in_progress`/`completed`/`deleted` status) that
  `parseTodoProgress` reads, so live subtask progress is unaffected. The image pins in
  `deploy/backend` (`package.json` + `wrangler.toml`) and
  `RECOMMENDED_HARNESS_IMAGE` are synced to the new tag.
- **Workspace dependencies**: refreshed the whole lockfile within the declared ranges, so
  transitive dependencies move up too. Direct bumps include `ai` 7.0.37, `@ai-sdk/*`
  (anthropic 4.0.21, openai 4.0.20, amazon-bedrock 5.0.32), `hono` 4.12.32,
  `@hono/node-server` 2.0.12, `pg-boss` 12.26.3, `undici` 8.9.0, `wrangler` 4.114.0,
  `@cloudflare/workers-types`, `@cloudflare/vitest-pool-workers` 0.18.8,
  `@aws-sdk/client-s3` 3.1095.0, `@playwright/test` 1.62.0 and `turbo` 2.10.7. Every
  version picked is the newest that already satisfies the `minimumReleaseAge` supply-chain
  gate, and the AI-SDK family stays inside the majors that pair with `workers-ai-provider`
  (`ai@^7`, `@ai-sdk/*@^4`). No third-party entries were added to
  `minimumReleaseAgeExclude`. The frontend's `typescript@^6` pin is left alone (Nuxt /
  `vue-tsc` toolchain).
