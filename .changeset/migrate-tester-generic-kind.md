---
'@cat-factory/server': patch
'@cat-factory/executor-harness': patch
'@cat-factory/agents': patch
---

Migrate the `tester` built-in agent onto the generic, manifest-driven `agent` harness kind,
continuing the Task-5 strangler (after the read-only kinds, the merger/on-call/fixers, the
coder, blueprints, and spec-writer).

`ContainerAgentExecutor` now routes `tester` through `buildMigratedBuiltInBody` →
`buildRegisteredAgentBody` as a read-only `mode: 'explore'` structured agent that clones the PR
head branch (it makes NO commits) instead of the bespoke `/test` body. The agent returns ONLY
its structured JSON report; `toRunResult` coerces that `custom` result into the `testReport`
channel the engine's `TesterController` greenlights-or-loops the fixer on. The conservative
coercion the harness `/test` handler used to apply — defaulting every field safely and honouring
a greenlight ONLY when no blocking (high/critical) concern is open — now runs backend-side in
`coerceTestReport` (and the engine re-applies it defensively). The role prompt and the
run-mode / ephemeral-URL guidance come from the standard `roleSystemPrompt` + `userPromptFor`,
which already carry them, so the harness adds none.

The tester needs its docker-compose dependencies stood up for the run, so the generic
`agent` explore flow grows an optional `infra` spec (`{ environment, noInfraDependencies?,
composePath?, environmentUrl? }`): `handleAgent`'s explore mode stands the local
docker-compose infra up before the agent runs and tears it down afterward (lifted from the
bespoke tester handler), folding a stand-up-failure note into the prompt so a missing Docker
daemon is non-fatal. An `ephemeral` run manages no infra (the env is already deployed and its
URL reaches the agent through its prompt). This is a harness `src/**` change, so the
executor-harness image is bumped (1.13.0; deploy tag + `wrangler.toml`).

Two regressions the migration introduced are fixed here. (1) The report's `environment` (which
env the suite ran in, echoed to the UI) was authoritatively set from the task config by the old
`/test` handler; the migrated `coerceTestReport` only read it from the model's JSON, so it was
near-always dropped. The harness now stamps `environment` onto the structured result from the
job's `infra` spec (the authoritative source), so it's deterministic again regardless of what the
model emits. (2) A `local` service with no infra dependencies lost the precise "nothing was stood
up — run the suite directly" guidance and was told its infra had been stood up on localhost;
`testerEnvironmentSection` now restores the no-dependencies run-mode line for those services.

The dead `/test` harness handler (and the other migrated kinds' handlers) is removed in the
later harness-cleanup sweep. The cross-runtime conformance suite already covers the generic
`agent` explore + structured-result path on both runtimes.
