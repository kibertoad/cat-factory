---
'@cat-factory/server': minor
'@cat-factory/app': minor
---

Attaching a document to a task is member-tier work, not integration management

The document-source controller held every route behind one admin gate
(`requireWorkspacePermission('integrations.manage')` on `*`), so import-by-ref, `POST
/documents/link`, plan and spawn were all 403 for a `member`. That locked the feature to operators,
and the person a linked document exists for is usually not one: they link the spec or the design
their own task is about. The Add-task context picker imports the pasted ref and then links it, so
for a member the attach flow failed on its very first write, whichever surface they started from.

Import, search, plan, spawn and `POST /documents/link` now sit at the member tier. Connect and
disconnect keep `integrations.manage`, because those are the two routes that write and clear the
per-workspace source CREDENTIAL. The per-DocKind template/exemplar role links keep it too: one tag
decides what every doc run in the board writes from, which is the fragment-library blast radius
rather than one task's context, and nothing in the authoring flow needs it.

Two details are load-bearing. The member half mounts NO gate: the auth gate's own write floor
already requires `>= member` for every non-GET, so a `board.write` mount would be a no-op that
reads as the enforcement, and `boardController`'s writes mount nothing for exactly that reason. The
admin half is mounted on the controller's OWN path patterns rather than per-handler, so the refusal
still lands before body validation (a member is refused whether or not their payload is well-formed,
and never learns which sources this deployment configured) and rather than on `'*'`, which becomes
`ALL /workspaces/:workspaceId/*` on the shared app and reaches sibling controllers' routes.

`defineWorkspaceRbacSuite` asserts both halves on every runtime, including the part that keeps this a
tier MOVE rather than an opening: a viewer is still refused all five authoring writes by the floor.
In the SPA, the "Connect a source" upgrade on the task-inspector and add-task attachment pickers is
now gated on `integrations.manage`, since for a member it opened a modal, took a token and 403'd;
the attach path itself is unchanged and now works for them.

This narrows nothing, so no deployment loses a capability: `admin` keeps every route it had.
