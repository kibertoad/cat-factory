---
'@cat-factory/executor-harness': minor
'@cat-factory/local-server': minor
'@cat-factory/node-server': minor
'@cat-factory/server': minor
'@cat-factory/integrations': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/app': minor
---

Local mode: warm container pool + checkout reuse, and optional native (host-process)
execution of the developer's installed Claude Code / Codex CLI.

**Warm pool + persistent checkout (default off = unchanged):** the local runner transport
can keep idle harness containers warm and lease one — preferring a member that already holds
the run's repo — instead of cold-starting a container per run. A leased member reuses a
stable per-repo checkout (`git reset --hard` + a keep-list clean sweep that preserves
dependency caches like `node_modules`, then `fetch` + switch branch) rather than cloning from
scratch. New harness job field `persistentCheckout` drives this; it is set only by the local
pool transport, so every other runtime keeps the ephemeral fresh-clone path byte-for-byte.
Pooling is Docker-family only (the new `capabilities.pooling`); Apple `container` keeps the
per-run path.

**Configured in the UI + DB, not env:** the warm-pool sizing (size / pre-warm / max / idle
timeout) and the per-repo checkout-reuse knobs (workspace root + dep-cache keep list) are a
new per-deployment singleton (`local_settings`, Postgres/Drizzle only — local-mode-only, so
no D1 mirror) exposed through a dedicated **"Local mode"** settings panel
(Integrations → Local mode), served by a new `GET|PUT /local-settings` controller wired only
on the local facade (503 elsewhere). This REPLACES the env vars `LOCAL_POOL_SIZE`,
`LOCAL_POOL_MIN_WARM`, `LOCAL_POOL_MAX`, `LOCAL_POOL_IDLE_TTL_MS`, `HARNESS_WORKSPACE_ROOT`,
`HARNESS_CLEAN_KEEP` (no longer read). The container transport forwards the checkout knobs to
the harness container as `HARNESS_*` env. Breaking: those env vars are dropped — set the
values in the UI instead.

**Native execution (`LOCAL_NATIVE_AGENTS`, default off):** an allow-list of subscription
harnesses (`claude-code,codex`) to run as a host process (new `LocalProcessRunnerTransport`)
driving the developer's OWN installed `claude` / `codex` CLI with its ambient login (new
harness `ambientAuth` mode) — no leased credential, no personal-credential gate for those
vendors. Native applies ONLY to a listed harness's NATIVE vendor (Anthropic `claude` /
OpenAI `codex`): a non-native vendor that reuses the `claude-code` harness (GLM/Kimi/DeepSeek
carries its own base URL) and proxy/`pi` models are NOT run unsandboxed on the host — they
keep the sandboxed per-run container path (so they still lease their real credential and
still need `LOCAL_HARNESS_IMAGE`). Gated, local-facade-only, with the explicit no-sandbox /
own-subscription trade documented. Requires `LOCAL_HARNESS_ENTRY`. The Tester's local
docker-compose infra is reported unsupported in native mode for now (host-compose +
git-worktree isolation are a follow-up phase).

Breaking: none (all paths default off). The executor-harness image is bumped (1.16.0) for
the new `persistentCheckout` / `ambientAuth` handling.
