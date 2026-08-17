---
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/worker': minor
---

Close the mothership-mode repository surface: the VCS sync + repo-write half, service CRUD, the
mount cascade and the last per-workspace reads all go remote, and the agent-kind registry's
CAPABILITY layer becomes org state a node reads from the mothership.

**The surface-completion backlog is empty, and the drift guard no longer has a word for it.** Every
org/durable repository method is now either allow-listed or carries a PERMANENT classification;
`pending` is gone from the guard's reason vocabulary, so a new repository method must be proxied or
justified in the same PR rather than parked. What landed: the whole VCS installation + projection
surface (reads AND the sync/repo-write writes a node's delegated GitHub client earns), service CRUD
(a mothership-mode node could not create a service frame at all before this), the frame-deletion
mount cascade, the Kaizen streak write and detail read, the workspace roster reads, the profile
edit and the sealed test-credential list.

**Four new scope rules, and two of them close real cross-tenant holes.** `installationUpsert` binds
the STORED installation row as well as the declared one, because the upsert conflicts on the
installation id alone: without it an in-scope caller could name another org's installation and
repoint its binding at a board it controls, which is the account takeover
`GitHubInstallationService.connect` refuses in the service layer the RPC bypasses. `serviceInsert`
binds the FRAME BLOCK a service claims (admitting one that does not exist yet, since the service
row is written first), because `getByFrameBlock` resolves by frame block id alone and a service
planted on another org's frame redirects that org's runs at a repo the caller controls.
`serviceUpdate` and `workspaceList` bind the account a patch would re-home a service into, and the
candidate list a repo-linkage read answers a subset of.

**Six dead port methods are deleted rather than proxied**: the single-service `listByService` on
five repositories (board composition has gone through the batched `listByServices` for as long as
the allow-list has existed), `serviceRepository.getByRepo`, `githubInstallationRepository`'s
`updateCachedToken` (nothing has written that column since the App token cache moved in-process),
and the unused `DrizzleServiceFrameRepository`. Allow-listing a method no caller invokes buys
attack surface for nobody.

**`GET /internal/agent-kinds`** makes the deployment's agent-kind capability layer org state, the
fourth application of the rule its three siblings established. Unlike them it MERGES with the
node's own registry rather than replacing it: a kind's executable half (prompts as functions,
`preOps`/`postOps`, its output parser) cannot cross a wire, so the kind CATALOG stays node-local
exactly like task types and pipelines, and a step naming an unknown kind still fails loudly at
admission. What crosses is `assignSkills`/`assignToolServers` — a `SKILL.md` payload, a transport
plus a credential's NAME — whose absence on a node one build behind is silent: the agent simply
works without the org's playbook, which reads exactly like an agent that considered the standard
and moved on. A failed read THROWS rather than answering with an empty layer.

**Compatibility (internal):** `githubInstallationRepository.updateCachedToken`,
`serviceRepository.getByRepo` and the five `listByService` methods are removed from their kernel
ports and both runtimes. Nothing in the tree called them; a deployment that implemented these ports
itself drops the members.
