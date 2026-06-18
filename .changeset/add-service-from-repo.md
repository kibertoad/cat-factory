---
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/app': minor
---

Add an existing GitHub repository to the board as a service, with no bootstrap
run. A new "Add from existing repo" button (sidebar, Repositories section) opens
a picker of repos the GitHub App can access — including ones the workspace
doesn't track yet — plus a link to grant the App access to more repos. Importing
links + syncs the repo into the workspace (if needed), creates a `ready` service
frame titled after the repo, and links the repo projection to it so tasks dropped
on the frame target that repo. Backed by `POST /workspaces/:ws/blocks/from-repo`
(`BoardService.addServiceFromRepo` + `GitHubSyncService.linkRepo`).
