---
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

Provisioning auto-detection now prioritizes the option matching the user's selected
provision-type tab.

The "Detect from repo" affordance sends the currently-selected tab (`kubernetes` vs
`docker-compose`) as a new optional `prefer` field on `POST /environments/detect-provisioning`.
The detector honors it: on the `docker-compose` tab a compose file wins when present (even if
Kubernetes manifests also exist, surfaced as a low-confidence "switch to kubernetes" hint),
falling back to the other kind when the preferred one isn't found. With no preference (or any
non-compose tab) it keeps the historical kubernetes-first order, so existing behavior is
unchanged unless a caller opts in.
