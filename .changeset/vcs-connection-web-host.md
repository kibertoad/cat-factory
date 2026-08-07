---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Link repositories, merge/pull requests and issues to the instance a workspace is actually
connected to. A VCS connection (and each connect option) now carries `webUrl`, the browser-facing
host derived from the provider's configured API base, and the SPA builds every repo link from it
in the provider's own shape instead of hand-building `https://github.com/...`. A deployment whose
API base does not name a host withholds those links rather than pointing at the provider's public
instance. The source-control panel's pull-request vocabulary is provider-keyed, so a GitLab
workspace sees merge requests.

`AppConfig.gitlab` is now always present, shaped like its GitHub sibling: `apiBase` is the address
of the instance a deployment talks to, and `enabled` alone carries the `GITLAB_TOKEN` opt-in for
the single-token engine connection. Gating the whole config on that token had made the address
unreadable on a deployment reaching GitLab any other way, so local mode's `GITLAB_PAT` shape got
no links at all.

Internal breaks, so a SPA build and a backend must be deployed together: `webUrl` is required on
the connection and connect-option shapes, and `AppConfig.gitlab` is no longer optional.
