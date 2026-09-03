---
'@cat-factory/kernel': patch
'@cat-factory/contracts': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/app': patch
---

Reach the bootstrap's reference template the way the clone reaches it, and pre-flight it

Two components disagreed about what "we can read the reference architecture's repository" means.
The monorepo adoption survey resolved it through `resolveRepoFilesForCoords`, scoped to the
workspace's PROJECTED repos, while the apply phase cloned it with the installation token. A
reference architecture is an admin-managed `owner/name`, not a repository the board links, so the
ordinary case surveyed as unread while the clone worked: every adoption decision showed the
template as "unverified", which reads to a reviewer as a template with no opinion rather than as a
template nobody opened. `RepoBootstrapper.resolveReferenceRepo` is now the one answer, and it is
the bootstrapper's, so the survey and the clone agree by construction.

The same call is a pre-flight. A run naming a reference architecture whose repository the
connection cannot see is refused before any row is written, with `reference_repo_not_found` (422,
the entry is wrong) or `reference_repo_unreadable` (503, the provider is down) rather than a job
row, a provisional board card and a failure a phase later. It also binds the retry, so correcting
the entry and retrying is the way out with every other value of the run intact.

Two clone bugs fall out of resolving the template properly: a new-repo run scoped its job token to
the target alone, so a PRIVATE template was uncloneable, and it assumed the template's default
branch was `main`. Both surfaced as bare git errors. The scope goes through the shared
`jobTokenRepoIds`, so a template that IS the run's own target is asked for once rather than twice,
and a mint GitHub refuses (`repository_ids` may only name repositories the installation holds,
which reading a public repository does not prove) is reported naming the repository to grant.

The bootstrapper is also told which provider its client speaks, so a workspace connected to
another one is refused as unconnected rather than probed with the wrong credential and reported as
a reference architecture naming the wrong repository.

Behaviour change worth noting on `POST /api/v1/repos/bootstrap`: it delegates to the same service
method, so it gains the same refusals, as a 422/503 rather than a `failed` creation in the 201.
The public surface version moves to 1.68.0 and `backend/docs/public-api.md` documents both.
