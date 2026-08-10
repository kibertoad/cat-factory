---
'@cat-factory/acceptance': minor
'@cat-factory/cli': minor
---

The acceptance suite now ADOPTS two repositories the operator created instead of bootstrapping
them, and ships a `configure` command that assembles its `.env`.

Bootstrapping was the one prerequisite no configuration could satisfy: a PAT connection reports
`canCreateRepos: false` for every workspace and the App creation path is org-scoped, so on the
deployment shape the suite's own README offers first, spec 01 could not run at all. It now backs a
board service with each named repository (`POST /api/v1/services` already takes a `repoId`) and
scaffolds both through `pl_build` from the same briefs, which also makes an interrupted scaffold
resume the way an interrupted feature run does. `vcs-connection` stops asking for repository
creation, `target-repos` gates on both repositories being visible to the workspace, and a new
`model-preset` check joins the pinned preset against the model catalog so an undispatchable preset
is named as one rather than found at the first dispatch. Every task the suite files pins
`ACCEPTANCE_MODEL_PRESET`, so a pass runs on the model it says it ran on.

`pnpm --filter @cat-factory/acceptance run configure` resolves what the deployment and the
kubeconfig already know (workspace, connected account, preset library, apiserver, ServiceAccount
token), asks for the API token and the two repository names, and opens each repository's creation
page prefilled. It never overwrites a value without naming it and prints neither token.

`@cat-factory/cli` gains three exports (`readApiServerCommand`, `readTokenCommand`, `decodeToken`)
so the new command asks a kubeconfig the same questions `cat-factory k3s` does.

Internal break, as pre-1.0 internals may: a ledger from an earlier pass is not read for its
`bootstrapJobs`, so a pass interrupted mid-bootstrap under the old shape starts fresh rather than
re-attaching to a job.
