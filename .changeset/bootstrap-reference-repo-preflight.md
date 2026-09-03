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
branch was `main`. Both surfaced as bare git errors.

Behaviour change worth noting on `POST /api/v1/bootstraps`: it delegates to the same service
method, so it gains the same refusal. A request that used to be accepted and then fail its run is
now refused synchronously.
