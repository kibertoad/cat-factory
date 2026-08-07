---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Link repositories, merge/pull requests and issues to the instance a workspace is actually
connected to. A VCS connection (and each connect option) now carries `webUrl`, the browser-facing
host derived from the provider's configured API base, and the SPA builds every repo link from it
in the provider's own shape instead of hand-building `https://github.com/...`. A deployment whose
API base does not name a host withholds those links rather than pointing at the provider's public
instance. The source-control panel's pull-request vocabulary is provider-keyed, so a GitLab
workspace sees merge requests.

Internal wire break: `webUrl` is required on the connection and connect-option shapes, so a SPA
build and a backend must be deployed together.
