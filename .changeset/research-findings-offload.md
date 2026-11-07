---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/workspaces': patch
'@cat-factory/server': minor
'@cat-factory/app': minor
---

A research task's findings revision body over the effective inline threshold is now offloaded to
the account's blob store as a `findings` artifact, anchored on the project's root block. The kind
is exempt from the age-based retention sweep and is reclaimed with the project. Deleting the board
that homes a project another board still mounts now carries the artifacts anchored on its blocks
to the board it is re-homed to, instead of purging them with the board. A body that cannot be
offloaded and is over the runtime's own row ceiling is refused with
`findings_too_large_for_inline`; an offloaded body that cannot be read is refused with
`findings_body_unavailable` (503).

The create-project form lists the research definitions the account can pin
(`GET /workspaces/:workspaceId/research-definitions`) and renders the picked definition's inputs,
so a research kind can be created from the board. Every project refusal reason has translated
copy. A revision now records the text of the ad-hoc questions it answers, so a later `clarify` or
`refresh` task can ask them again.

The public run-evidence surface lists and serves only the artifact kinds it documents, so a
`findings` artifact never appears as run evidence.
