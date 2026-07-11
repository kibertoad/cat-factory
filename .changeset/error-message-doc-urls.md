---
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Boot-time configuration problems now carry a documentation link. Each `ENV_HELP`
entry embeds a stable in-repo doc URL (built through a new centralized `DOCS`
helper in `@cat-factory/server`), the operator log appends a `Docs:` line, and the
"backend misconfigured" screen renders a "View documentation" link per problem.
This establishes the doc-URL convention for the error-message coverage initiative
(item A1).
