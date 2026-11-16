---
'@cat-factory/orchestration': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Make projects work on a mothership-mode node.

- The board snapshot read schedules for every mounted subject, projects included, so a node's
  persistence RPC refused the whole read and the board answered 404 once it mounted a project.
  It now reads schedules for mounted services only.
- Linking services to a project, and projects to a task, checks the ids against the account's own
  services and projects. A by-id read naming a missing id was refused over the RPC, so a node
  answered 404 where every other runtime answers the 422 that names the bad link.
- An outcome that stays inline no longer resolves the account's blob store.
- The capability-credential store is reachable over the persistence RPC on both facades. It was
  allow-listed but never wired, so a node's capability credential reads (a project run's vendor
  login, the credentials checklist) failed with "not wired".
