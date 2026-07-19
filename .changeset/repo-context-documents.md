---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/integrations': minor
'@cat-factory/gitlab': minor
'@cat-factory/app': minor
---

Attach repo files as task context via a repository picker. When a repo-backed
document source (GitHub / GitLab) is selected in the context-document picker, the
user now searches for a repository (reusing the shared server-side repo search),
then picks one or more files from it — either by searching the whole tree by path
or by browsing it with the monorepo directory browser, which now supports
multi-pick in file mode. Backed by a new recursive repo-tree read (`listTree` on
the VCS/GitHub client ports, `GET /github/repos/:id/files`) so file search is a
single cached call per repo instead of walking the tree level-by-level.
