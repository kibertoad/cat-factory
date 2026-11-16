---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/workspaces': patch
'@cat-factory/server': minor
'@cat-factory/app': minor
---

A project task's outcome body over the effective inline threshold is now offloaded to the
account's blob store, for every project kind, through one `ProjectOutcomeStore` that holds the body
as opaque JSON and leaves decoding to the kind's module. The body is an `outcome` artifact anchored
on the project's root block, exempt from the age-based retention sweep and reclaimed with the
project. Deleting the board that homes a project another board still mounts now carries the
artifacts anchored on its blocks to the board it is re-homed to, instead of purging them with the
board. A body that cannot be offloaded and is over the runtime's own row ceiling is refused with
`outcome_too_large_for_inline`; an offloaded body that cannot be read is refused with
`outcome_body_unavailable` (503).

The create-project form lists the definitions of the picked kind the account can pin
(`GET /workspaces/:workspaceId/project-kinds/:kind/definitions`), each with a one-line summary its
kind's module writes (`ProjectKindModule.definitionSummary`), and renders the picked definition's
inputs, so a kind that pins a definition can be created from the board. Every project refusal
reason has translated copy. A research revision now records the text of the ad-hoc questions it
answers, so a later `clarify` or `refresh` task can ask them again.

The public run-evidence surface lists and serves only the artifact kinds it documents, so an
`outcome` artifact never appears as run evidence.
