---
'@cat-factory/kernel': minor
'@cat-factory/worker': minor
'@cat-factory/spend': patch
---

Expand the model picker, route AI Gateway catalog models, and default the
implementer (coder) to the latest Kimi.

- The picker catalog (`MODEL_CATALOG`) gains three Cloudflare-served entries:
  `kimi-k2.7` (`@cf/moonshotai/kimi-k2.7-code`), `glm` (`@cf/zai-org/glm-5.2`,
  262K context) and `deepseek-v4-pro` (`deepseek/deepseek-v4-pro`, 131K context).
  The existing DeepSeek reasoning entry is relabelled `DeepSeek R1`.
- The Workers AI upstream now registers the OpenAI gateway plugin
  (`createWorkersAI({ binding, providers: [openai] })`), so a `<provider>/<model>`
  AI Gateway catalog slug like `deepseek/deepseek-v4-pro` (served via Fireworks)
  routes through the account's AI Gateway. A `@cf/...` Workers AI id is unaffected.
  Requires the account's `"default"` AI Gateway to exist with catalog billing on.
- The build phase (`coder`) now defaults to Kimi K2.7 instead of GLM-5.2. GLM-5.2
  on Workers AI was observed emitting malformed tool calls (`write` with no `path`)
  and looping until the harness no-progress guard aborted; design/review
  (`architect`/`reviewer`) stay on GLM-5.2. Operators can still override per kind
  via `AGENT_MODELS`.
- Spend pricing gains an approximate entry for `workers-ai:deepseek/deepseek-v4-pro`
  (a partner model billed at provider rates, not the near-free neuron rate).
