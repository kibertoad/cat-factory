---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/agents': minor
'@cat-factory/server': minor
'@cat-factory/workspaces': minor
'@cat-factory/conformance': minor
'@cat-factory/app': minor
---

Narrow the built-in pipeline catalog, and make a step conditional on what the change touches.

A pipeline step can now carry a RUN CONDITION beside its estimate gate (`stepOptions[i].condition`),
declaring the service scope it applies to. Every build rung carries BOTH testers: the browser pass
runs where the change touches a frontend service, the API pass where it touches anything else. Run
admission drops the condition-excluded steps before its gates, so a preset carrying `tester-ui` is
not refused on a backend service.

A condition is a SKIP AXIS, so it is held to the two structural rules an estimate gate is held to
(`assertValidRunConditions`, mirrored in the SPA's health advisory and in what the builder offers):
the step's kind must be one that may be absent from a run, and it may not also carry a human
approval gate. Without that, a condition on `merger` dropped the merge on every run outside its
scope while the pipeline still finished reporting success.

A skipped step now records WHY as a machine-readable `skipReason` (`gated` / `condition` /
`producer_skipped`) that the SPA renders as translated copy, and its `output` stays empty. The
reason used to be an English sentence written into `output`, which three separate aggregations
select on to build a model's view of the prior steps — so a condition-skipped tester's note was
handed to `merger` and `ci-fixer` as if it were the tester's report.

Five presets are withdrawn (`pl_frontend`, `pl_tech_debt`, `pl_blueprint`, `pl_spec`,
`pl_environment_analysis`) and one is added: `pl_complex` ("Complex build"), which settles the
requirements and researches the problem before the standard loop. `pl_code_comments` stays as an
INTERNAL pipeline: the documentation-refresh preset spawns onto it, so it resolves for a run while
being withheld from every listing. Withheld from `pipelineCatalogVersions` too, which the health
advisory reads as "the built-ins that exist" — an internal entry there is reported as newly
available on every board forever, with no reseed able to clear it. `pipelineCatalogNames` still
spans the whole catalog, so a task PINNED to an internal pipeline is named (and started) rather
than silently falling through to a full build.

Running ONE agent against a block is now a first-class action (`POST
/workspaces/:ws/blocks/:id/agent-kind-executions`, `ExecutionService.startAgentKind`) rather than
something that needed a single-step preset. It backs the post-bootstrap service mapping, a new
"Map service" action on the service frame, and the environment wizard's deep analysis.

BREAKING (internal): a workspace seeded before this change holds rows for the five withdrawn
presets; the pipeline-health advisory offers their removal, naming a replacement where one exists.
Anything naming `BLUEPRINT_PIPELINE_ID` / `TECH_DEBT_PIPELINE_ID` should use `BLUEPRINT_AGENT_KIND`
with `startAgentKind`, or name a build rung directly.
