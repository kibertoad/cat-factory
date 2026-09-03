---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Let a bootstrap say how its work should land: a pull request, or a push.

A bootstrap's delivery used to be decided by its target. Landing a service in a monorepo always
opened a pull request; creating a repository always force-pushed the scaffold onto the default
branch. Neither is wrong as a default and both are wrong as the only option: a team that wants
the first commit of a new service reviewed before it becomes `main` had no way to ask for that,
and a team standing services up in their own monorepo had to review and merge a pull request per
service to get one there.

`delivery` (`pull_request` | `direct_push`) is now a third axis on the launch form and on
`POST /workspaces/:ws/bootstrap/jobs`, orthogonal to where the content comes from and where the
service lands. Omitted, it resolves to the target's own default, so every existing caller is
unchanged: `direct_push` for a new repository, `pull_request` for a monorepo. It is stored on the
run, because a retry re-dispatches under it.

Three consequences worth knowing before choosing:

- **`direct_push` into a monorepo publishes as the agent works.** The harness checkpoints
  committed work to whichever branch it is pushing, so a run that faults leaves what it had
  already written on the default branch. A retry resumes on top of it.
- **`pull_request` for a NEW repository needs a base commit**, since a pull request is opened
  between two commits. A repository with none is refused at pre-flight, naming both ways out.
  Create it with an initial README, or push directly. The modal's own "create repository" button
  now seeds one.
- **A `pull_request` run does not trigger the initial service mapping.** The mapper clones the
  default branch, which such a run has not written to, so it would map the repository's initial
  README. The service frame says so; run "map service" from the inspector once the pull request
  has merged.

`/api/v1`: a bootstrap job now projects `delivery`, and its already-released `prUrl` is populated
for a new-repo run that opened one. Read `delivery` for whether a pull request is coming and
`repoUrl` for which target a run took; the two URL fields are no longer mutually exclusive. Spec
version 1.68.0, additive, all four SDKs regenerated.

Internal break: `MonorepoBootstrapLeg` no longer carries `branch`/`pr`, and `BootstrapRepoRequest`
carries a required `delivery` plan instead; `monorepoBootstrapBranch` / `monorepoBootstrapPrTitle`
are now `bootstrapWorkBranch` / `bootstrapPrTitle`. A bootstrap run also records its `workBranch`,
so a retry resumes the branch its first attempt pushed instead of opening a second one.
