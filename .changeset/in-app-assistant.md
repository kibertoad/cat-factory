---
'@cat-factory/contracts': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/workspaces': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

Add the in-app assistant: type what you want done, and the platform does it

Everything on the board is reachable, and reaching it means knowing which panel holds it. Putting a
repository on the board is a modal behind a sidebar entry; filing a task from a ticket is a second
modal plus a source picker plus a container picker; declaring that one service depends on another is
a field in a frame's inspector most people never open. Each is several clicks from someone who
already knows the sentence they would say.

The assistant takes the sentence. It ships with three actions, the ones a request most often is:
declare that one service depends on another (so both are spun up when either is tested), add a
service backed by a GitHub or GitLab repository named by its URL, and file a board task from an issue
URL (GitHub, GitLab, Jira, Linear).

The design decision worth reviewing is that the model does not act. It reads the request, names one
action from a closed catalog and copies that action's arguments out of the words in front of it;
everything after that is deterministic. The platform looks the id up in the catalog it rendered,
validates the arguments through the shared descriptor validator, resolves every name against the
board itself, and performs the action through the same service the equivalent button calls. So a
hallucinated action id is a decline, an invented argument key is a dropped key, and a service name
matching nothing (or matching two) is a question with the candidates attached. Nothing the model
writes reaches a side effect, a stored row, or the screen.

That last part is also why a turn answers with DATA rather than a chat message: the outcome variant
carries the ids and titles of what was touched, or the machine-readable reason it could not act, and
every sentence a person reads is rendered by the SPA from the i18n catalog. Putting the model's own
explanation on the wire would have made the surface untranslatable and put unreviewed model text on
screen.

Two alternatives were considered and rejected. A TOOL-CALLING loop (let the model call the board's
own methods) would have put the model inside the write path, where a wrong argument is a wrong write
rather than a wrong question, and would have made "which service did you mean?" unanswerable without
a second round trip. A DEPLOYMENT-REGISTERED action catalog was left for a later step: every action
performs a board write through an engine-internal service, the same reading that keeps the `merger`
step resolver a privileged built-in, so opening the catalog means defining a public, minimal action
context first. The tracker holds it as a named phase.

Worth watching when reviewing:

- The assistant is member tier and mounts no permission gate, on the same reading as the bug hunt:
  every action it performs is board authoring a member can already do from a button. Each write
  carries the asker's own tier (`blockEditAuthority`), so it is never a way around a policy its user
  is held to.
- A turn is a billable model call no run start gates, so it answers to the workspace budget
  (`isOverBudget`) before any vendor is reached, and fails closed.
- `WorkspaceService.snapshot` was refactored (no behaviour change) so that its board composition and
  the two visibility passes are one private method, and a new `boardBlocks` read shares them. That
  keeps exactly one definition of what is on a board while letting a caller that needs only the
  frames skip the workspace's pipelines, executions and three built-in catalogs.
- There is no conformance group, and the reason is in the doc rather than an omission: the module is
  composed in `createCore` from dependencies every facade already provides, with no port
  implementation, table, migration or cron of its own. Making an end-to-end turn assertable per
  facade needs an `AssistantRouter` seam first, which is on the tracker.
