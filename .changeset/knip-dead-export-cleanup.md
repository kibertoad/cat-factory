---
'@cat-factory/agents': patch
'@cat-factory/cli': patch
'@cat-factory/consensus': patch
'@cat-factory/gates': patch
'@cat-factory/integrations': patch
'@cat-factory/kernel': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Internal cleanup: prune dead/needless exports flagged by knip (no runtime behaviour
change). ~110 findings resolved — genuinely-dead symbols deleted (e.g. the unused
`ENVIRONMENT_ANALYSIS_PIPELINE_ID` / `INITIATIVE_BREAKDOWN_PIPELINE_ID` pipeline-id
constants, `isCiStatusProviderWired`, `parseApiKeyProvider`, unused re-export members of
the runtime facade barrels), and the `export` keyword dropped from symbols only used
inside their own module (repository classes, config constants, helper types). Also tidied
stale `knip.jsonc` baseline entries (removed no-longer-needed `ignore` / `ignoreDependencies`
and dead entry-glob patterns).

The residual knip warnings are now all DELIBERATE: the neutral `VcsClient` port type
re-export barrel, the Worker config-type barrel, the `providerEndpoints` base-URL group,
and a couple of types that must stay exported for declaration emit. Since backwards
compatibility is a non-goal pre-1.0, the removed exports (which nothing imported) are
dropped outright rather than deprecated.
