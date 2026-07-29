---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/workspaces': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/worker': minor
'@cat-factory/app': minor
---

Let a deployment declare its infra dependencies in code: `startNode`/`startLocal` take
`seedSharedStacks`, and a compose layer can now be an inline document or a file in another repo.

A `StackRecipe`'s and a `SharedStack`'s `composeFiles` entries are now `ComposeFileRef`s — a bare
in-repo path (unchanged, still the common case) or an explicit `ComposeSource`: `inline` (the
compose document itself) or `repo` (a path in another `owner/name`, read without cloning it). A
stack whose layers are all inline / foreign owns no repository, so `SharedStack.cloneUrl` is
nullable.

An `inline` layer may name where it is materialized, and that path is host-escape guarded on every
path that accepts one: a layer that would land outside the checkout is refused when the shared
stack is SAVED (`details.reason: 'compose_layer_escapes_checkout'`) and again before any layer is
read or written, alongside the recipe path's existing pre-daemon check.

Breaking (pre-1.0): `SharedStack.cloneUrl` is `string | null` rather than `string`, and
`composeFiles` entries widen from `string` to `string | ComposeSource`. D1 migration `0070`
rebuilds `shared_stacks` to relax the `clone_url` NOT NULL; the Drizzle mirror does the same. No
data changes — every existing row keeps its clone URL and its plain-path layers.
