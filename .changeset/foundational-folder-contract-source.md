---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/app': patch
---

Add a `folder` mode to foundational-service repo sources: link a whole repo FOLDER — optionally
including its subfolders — as the contract set of the ONE service the link names. It joins the
existing `directory` (one service per subdirectory) and `files` (an explicit path list) modes.

The point is WHEN the file set is decided. A `files` link pins the paths, so a contract added
upstream stays invisible until somebody edits the link; a `folder` link re-discovers the set on
every sync, which is what a spec directory that grows actually needs. Freshness still costs one
head-commit read against the folder, and the walk only runs once that read says the commit moved.

The walk is bounded (depth, directories listed, contract files taken) and breadth-first over
name-sorted listings, so the result is deterministic across syncs and the cap falls on the
deepest, least-specific files rather than on a root-level `openapi.yaml`. A truncation is
reported on the sync result rather than treated as a transient failure, because holding the
pinned commit back would make the next pass truncate identically while the source looked
permanently behind. An EMPTY folder is stable for the same reason and pins the same way: a folder
under which nothing even looked like a contract retires its service, exactly as a directory that
lost its `service.md` does, while a folder whose candidates all read back unusable is the
transient case that keeps the prior row and leaves the pin behind. The listings and contract
bodies a walk needs are fetched with bounded concurrency rather than one round trip at a time,
which is what keeps a deep subtree's sync to seconds. Contract ids in a `folder` source come from the path RELATIVE to the folder
root (`v1/users.yaml` → `v1-users`): the basename rule the other modes use would collapse
`v1/users.yaml` and `v2/users.yaml` onto one id and silently drop one of them. An optional
`service.md` at the folder root supplies the description and capability tags, never the id or
name — the link already gave those, so identity keeps exactly one source.

Two changes reach the existing modes. The sync result gains `skippedFiles` and `truncated`, so a
link that produced fewer contracts than its author expected has an explanation available to them;
`skippedFiles` counts only files that LOOKED like contracts (an OpenAPI or contract-module
extension) and were not usable. And files with no contract extension are no longer fetched at all
before being discarded, which removes a read per README sitting beside a service's specs.

Compatibility: `FoundationalServiceSourceRecord` and the source wire shape gain a required
`recursive` field, backed by a new column on both stores (D1 migration `0075`, the matching
Drizzle migration). Existing rows take `false`, which is the only value the other two modes can
honestly carry.
