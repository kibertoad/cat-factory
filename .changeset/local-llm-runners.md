---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Run agents on locally-hosted LLMs (Ollama, LM Studio, llama.cpp, vLLM, or any
custom OpenAI-compatible server). Each user configures their own runners in
Settings → "My local runners" (a runner lives on that person's machine), stored
per-user in the DB with on-the-fly connection validation that probes the runner's
`/v1/models` and lists the installed models to enable. The enabled models appear
in the picker as the `direct` flavour and need no API key — the LLM proxy resolves
the run initiator's endpoint and skips the DB key lease (new optional
`LlmUpstreamEndpoint.apiKey` signal / keyless local branch), and inline LLM calls
register the user's runners as keyless resolvers. Resolution is by the run
initiator, exactly like personal subscriptions.

New per-user `local_model_endpoints` table mirrored across both runtimes (D1
migration `0002` ⇄ Drizzle), a user-scoped `GET|PUT|DELETE /local-model-endpoints`
+ `POST /local-model-endpoints/test` API, and a cross-runtime conformance
assertion for the store (CRUD + bearer-key encryption round-trip + enabled-models
JSON). Container kinds (coder/tester/merger/…) and the inline reviewer/planner all
run on the local model. Breaking only in the pre-1.0 sense: a new table is added,
no migration of existing data is needed.
