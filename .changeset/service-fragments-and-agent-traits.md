---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/prompt-fragments': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Service-scoped best-practice prompt fragments, delivered by agent traits.

A service (frame block) now owns an explicit selection of best-practice / guideline
fragments — its programming standards — chosen from the **universal fragment pool**.
That pool is the built-in catalog plus any fragments a deployment registers at startup
via the new `registerPromptFragment` seam in `@cat-factory/prompt-fragments` (mirroring
`registerAgentKind` / the model-provider registry); `GET /prompt-fragments` serves the
merged pool. A workspace can also configure a **default set new services inherit**
(`GET|PUT /workspaces/:ws/service-fragment-defaults`), seeded onto a frame's
`serviceFragmentIds` when it is created (board drop, repo import, or bootstrap).

Agents gain first-class **capability traits** (`@cat-factory/agents`): a registry of
standard + custom traits with `traitsFor` / `hasTrait`, assignable to built-in kinds and
to custom kinds via `AgentKindDefinition.traits`. Two standard traits ship:

- **`code-aware`** (coder, ci-fixer, fixer, reviewer, architect): the running service's
  selected fragments are folded into the agent's system prompt, unioned with the block's
  own manual pins. Other kinds keep only their block pins.
- **`spec-aware`** (every code-touching kind): the agent's system prompt gains guidance to
  read the in-repo `spec/` artifact (overview.md → rules.md → features/*.feature →
  spec.json) and treat it as the source of truth for required behaviour.

This **replaces the automatic per-run relevance selector**: fragment delivery is now
explicit (the service's selection) and trait-gated (code-aware) rather than guessed per
run. Per-block manual pins (`Block.fragmentIds`) still apply to that block's own agents.
The tenant fragment **library** (account/workspace CRUD + repo sources) remains as a
management surface but no longer feeds the run path.

Persistence is mirrored on both runtimes: a `service_fragment_ids` column on `blocks`
and a `workspace_fragment_defaults` table (Cloudflare D1 migration `0040` +
`D1ServiceFragmentDefaultsRepository`; Node Drizzle schema/migration +
`DrizzleServiceFragmentDefaultsRepository`), with the cross-runtime conformance suite
asserting the workspace-default round-trip, new-service inheritance, and the
code-aware-only folding on both facades. The UI adds a per-service "Service best
practices" picker in the inspector and a "Default service best practices" workspace
settings panel.
