# Initiative: the in-app AI assistant

## Goal & rationale

Everything the platform does is reachable, and reaching it means knowing which panel holds it. Putting
a repository on the board is a modal behind a sidebar entry; filing a task from a ticket is a second
modal plus a source picker plus a container picker; declaring that one service depends on another is a
field in a frame's inspector that most people never open. Each is two or three clicks away from
someone who already knows the sentence they would say.

This initiative adds the surface that takes the sentence: a prompt box that routes one typed request
to one of the platform's own actions and performs it, with the board write going through exactly the
service the equivalent button calls.

Full design (the source of truth; do not re-derive):
[`backend/docs/in-app-assistant.md`](../../backend/docs/in-app-assistant.md).

## Target pattern

Phase 1 (this initiative's pilot PR) is the reference implementation for how an action is shaped and
how a turn is bounded:

- The model ROUTES and COPIES; it resolves nothing. `readAssistantSelection` parses the reply,
  `keepDeclaredArguments` drops keys the action never declared, the shared descriptor validator judges
  the values, and every name is matched against the board by the action itself.
- An action is a DECLARATION plus a function (`AssistantActionDefinition`), its parameters written in
  the shared descriptor-field vocabulary, so the catalog the model reads is derived from the same
  declaration the validator enforces.
- A turn answers with DATA in all three outcomes. No model prose is on the wire, so every sentence the
  SPA shows comes out of the i18n catalog.
- The billable call answers to the workspace budget before any vendor is reached, the standing rule
  for a model call no run start gates.

## Phase checklist

### Phase 1: the surface and the first three actions

| Item                                                                                        | Status |
| ------------------------------------------------------------------------------------------- | ------ |
| Contracts: `assistant.ts` (outcome variant, reason vocabularies) + the two route contracts  | done   |
| Prompt: `agents/prompts/assistant.ts` (system prompt, catalog rendering, delimited request) | done   |
| Engine: `AssistantService` + `assistant.logic.ts` (selection parse, name match, repo slug)  | done   |
| Actions: dependency edge, service from repo URL, task from issue URL                        | done   |
| Wiring: `createAssistantModule` in the composition root; `AssistantController`, member tier | done   |
| `WorkspaceService.boardBlocks` (the composed board without the snapshot's other four reads) | done   |
| SPA: `AssistantModal.vue`, `stores/assistant.ts`, nav contribution (`intake`, basic tier)   | done   |
| i18n: `assistant.*` + `nav.assistant` + the palette entry, all ten locales                  | done   |
| Design doc + this tracker + the CLAUDE.md flow entry                                        | done   |

### Phase 2: open the catalog to deployments (not started)

The catalog is a plain list today, on the `merger`-resolver reading: every action performs a board
write through an engine-internal service, so a registry would have to define a PUBLIC, minimal action
context first. That is a design decision of its own, and doing it wrong bakes an engine-internal
handle into a published seam.

| Item                                                                                                   | Status |
| ------------------------------------------------------------------------------------------------------ | ------ |
| A minimal public `AssistantActionContext` (the board reads an action may make, and nothing else)       | todo   |
| `AssistantActionRegistry` in kernel + the option on `start()` / `startLocal()` + `registry-seams.spec` | todo   |
| Boot validation: an id collision, an action with no parameters, a parameter key that is not declarable | todo   |

### Phase 3: an assertable turn per facade (not started)

There is no conformance group today, and the reason is honest rather than an omission: the module is
composed in `createCore` from dependencies every facade already provides, with no port implementation,
table, migration or cron of its own, so there is no per-facade wiring to drift. What a group WOULD
catch is a repository read behaving differently under D1 and Postgres inside a turn.

| Item                                                                                                                            | Status |
| ------------------------------------------------------------------------------------------------------------------------------- | ------ |
| An `AssistantRouter` port (the `InlineUseCaseGenerator` / `BugHuntAssessor` shape) so a harness can script the routing decision | todo   |
| `defineAssistantConformance` + the three facade registrations (`check-conformance-group-parity`)                                | todo   |
| An e2e spec: type a request, watch the frame appear on the board over the live stream                                           | todo   |

## Gotchas the pilot surfaced

- **`parseRepoWebUrl` does not parse an ISSUE url.** `/issues/12` is not one of its tree markers, so
  it answers null. The repository behind an issue comes from the source's own canonical external id
  (`owner/repo#12`, `group/sub/project#5`) via `issueRepoSlug`, and a key with no path (`PROJ-12`) is
  the honest null that sends the turn to its "which service?" question.
- **A pasted URL can only name a PROJECTED repository.** There is no lookup that reaches past the
  workspace's projection, and adding one would be the wrong fix: a repository the connection cannot
  see is one whose clones will fail.
- **`addServiceFromRepo` answers with a frame whether it created one or MOUNTED an existing account
  service.** `created` is derived by reading the board's frames BEFORE the write; reading the response
  alone cannot tell the two apart, and a person told only "here is your service" reads the second as
  the first.
- **A container for a new task must be homed in the REQUEST workspace.** `createTaskFromIssue` asserts
  it, so a service this board merely MOUNTS is not a valid target; that refusal is the service's own
  404 rather than something the action pre-empts.
- **The board read had to be extracted, not reused wholesale.** Resolving a service name needs the
  COMPOSED board (a mounted shared service is on screen and nameable), and the only composed read was
  `WorkspaceService.snapshot`, which also loads pipelines, executions and three built-in catalogs.
  `boardBlocks` shares `snapshot`'s composition through one private `visibleBoard`, so there is still
  exactly one definition of what is on a board.
