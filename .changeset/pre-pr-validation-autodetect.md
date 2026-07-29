---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

Autodetect pre-PR validation checks from a service's repository.

The service inspector's pre-PR validation panel gains a "Detect" button backed by
`GET /workspaces/:ws/services/:blockId/validation-checks/detect`. It reads the repo root
through the existing checkout-free `RepoFiles` seam and suggests check commands from what
the repo declares — npm/composer scripts, Make/just/Task targets, and the tool configs
checked in beside them — across node, python, go, rust, maven, gradle, dotnet, ruby, php,
elixir and the three generic task runners.

The endpoint writes nothing: suggestions land in the panel's unsaved rows and the operator
saves them as before, so an unconfigured service still behaves exactly as it did.
