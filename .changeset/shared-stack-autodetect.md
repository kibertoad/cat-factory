---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

Add repo autodetection to the shared-stacks definition screen. A new **Autodetect** button on
the shared-stack form reads the repo at the entered clone URL — checkout-free, over the
workspace's VCS connection (no clone, no host daemon) — and prefills the compose-shaped fields
from a non-binding recommendation the user reviews before saving:

- **`composeFiles`** — the base compose file plus any `<stem>.override.ya?ml` auto-merge family
  (the common single self-contained `docker-compose.yml` case resolves to just that one file).
- **`managedNetworks`** — the `external: true` networks the compose references, which a shared
  stack is responsible for creating + owning (the `acme-net` shape). A self-contained stack that
  defines its dependencies internally declares no external network, so this stays empty.
- **`composeProfiles`** — the `COMPOSE_PROFILES` the file declares.
- A suggested **name** from the repo basename (only when the field is empty).

New wire contract `POST /workspaces/:ws/shared-stacks/detect` (`detectSharedStackContract` +
`sharedStackRecommendationSchema`), served by `SharedStackService.detect`, which reuses the
deterministic compose scan (`detectSharedStack`) the environment provisioning detector already
runs. Detection is a pass-through (`detected: false`) when no VCS connection is wired, and a
genuine read fault surfaces as an actionable error. Nothing is persisted.
