---
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/local-server': minor
---

feat(environments): stack-recipe execution engine (shared-stacks initiative, slice 3)

Teach the Docker Compose environment provider to run a declarative STACK RECIPE — the imperative
bring-up of a complex multi-repo/multi-service stack (the acme-main pilot) expressed as data.
The recipe is service-owned (`ServiceProvisioning.recipe`, landed slice 1) and now reaches the
provider: `resolveProviderForType` folds it into the compose handler's `providerConfig.recipe` at
provision time (the compose analogue of merging a kube `manifestSource`), so the provider keys
purely on the persisted, merged config. Runtime-bound to the local facade (needs a host daemon) —
the documented compose exception to runtime symmetry; the contracts + persistence stay symmetric.

- **Multi-`-f` layering + profiles + env files** — `recipe.composeFiles` are read, `{{var}}`-
  rendered, host-escape-checked and port-neutralized per layer (concurrent per-PR stacks never
  collide), then written beside their originals in the checkout and passed as ordered `-f`s;
  `recipe.composeProfiles` drives `COMPOSE_PROFILES`; `recipe.envFiles` materialize committed
  templates into their gitignored targets before `up` (`.env.dev.local-dist` → `.env.dev.local`).
- **Setup-step runner** — ordered `setupSteps` after `up -d` (no `--wait` — readiness is the
  recipe gate, since these stacks rarely declare healthchecks): `compose-exec` (composer install,
  migrations, cache warmup; seed import pipes a `.sql` dump via stdin), `copy-file`, `wait-http`,
  `wait-file` (container `test -f` or checkout), and the opt-in `host-command` (refused unless the
  workspace handler sets `allowHostCommands`). Each step has its own timeout budget.
- **Terminal health gate** — `compose-healthy` (default, poll `ps`), `http`, or `compose-exec`
  (e.g. `bin/console monitor:health`), polled until it passes or its budget elapses.
- **Per-step provisioning log** — the provider streams a `recordStep` entry per step (env file,
  `up`, each setup step, health gate) into the environment provisioning log, so the "View logs"
  drawer shows which step is running / died. Any step's failure tears the half-up stack down for a
  clean retry and surfaces the step's own error as the deployer step's `lastError`.

New optional `ComposeRuntime` seams (implemented by the local docker-CLI runtime): `compose`
stdin-streaming, `copyCheckoutFile`, `checkoutFileExists`, `hostCommand`. All compose safety lines
carry over (host-escape guard on every recipe path, `include:`/cross-file `extends`/`privileged`
refused). Fixture-driven unit tests cover the new pure helpers and the provider recipe flow
(layering, env files, steps, stdin seed, HTTP gate, host-command opt-in, failure teardown).
Recipe `teardownSteps` execution is deferred (the recipe schema carries them; `down -v` remains
the teardown for now).
