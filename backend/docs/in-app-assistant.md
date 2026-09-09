# The in-app assistant

One typed request, one action performed on the board.

A person opens the assistant (sidebar, or the command palette), types what they want done, and the
platform does it: declares a dependency between two services, puts a repository on the board as a
service, or files a board task from a tracker issue. There is no conversation, no transcript and no
model prose anywhere in the answer. A turn ends in a board write, a question, or a decline.

Using it (the product page, no checkout needed):
[Ask the Assistant](https://www.catfactory.ai/guide/assistant.html). This doc is the design behind it.

- Surface: `GET /workspaces/:workspaceId/assistant` (capability) and
  `POST /workspaces/:workspaceId/assistant/turns` (one turn). Session-authed, member tier.
- Wire contract: `@cat-factory/contracts` `assistant.ts`.
- Engine: `@cat-factory/orchestration` `modules/assistant/`.
- Prompt: `@cat-factory/agents` `agents/prompts/assistant.ts`.
- SPA: `components/assistant/AssistantModal.vue` over `stores/assistant.ts`.

## The shape: the model routes, the platform acts

The model's whole job is INTERPRETATION. It reads the sentence, names one action from a catalog the
platform rendered for it, and copies that action's arguments out of the words in front of it. It
resolves nothing, decides nothing, and touches nothing.

```
prompt ─▶ AssistantService
             ├─ budget guard (isOverBudget)          ← refuses before any vendor call
             ├─ generateText(catalog + request)      ← the ONE model call, temperature 0
             ├─ extractJson → readAssistantSelection ← unreadable ⇒ 503, never a decline
             ├─ catalog lookup by id                 ← unknown id ⇒ declined
             ├─ descriptor validation per argument   ← unusable value ⇒ needs_input
             └─ action.run(...)                      ← board write, through the board's own service
```

Everything after the model call is deterministic, which is what makes the surface safe to point at
a board. A model that hallucinates an action id, invents an argument key, or names a service that
does not exist changes nothing: those are a decline, a dropped key, and a question with candidates.

The three properties worth stating, because each is a way this design could quietly be lost:

- **No model text reaches the wire.** A turn answers with the ids and titles of what it touched, or
  with a machine-readable reason it could not act. Every sentence a person reads is rendered by the
  SPA from the i18n catalog, which is the platform's standing rule that the backend does not
  localize prose. Putting the model's own explanation on the wire would make the surface
  untranslatable and would put unreviewed model text on screen.
- **Arguments are copied, never normalised.** The prompt says so twice, because a model that tidies
  a pasted URL or expands an abbreviated service name produces a well-formed argument naming
  something else, and the platform cannot tell that from a name the person really typed.
- **An omitted argument stays omitted.** A guessed value is indistinguishable from a stated one once
  it is in the JSON. The clarification path exists precisely for what nobody supplied.

## The three outcomes

A turn answers with a variant, not a status code:

| Outcome       | Means                                                   | The SPA renders                                           |
| ------------- | ------------------------------------------------------- | --------------------------------------------------------- |
| `performed`   | The action ran.                                         | What changed, plus a button that selects it on the board. |
| `needs_input` | One argument did not resolve to something on the board. | The question, plus the candidates as one-click chips.     |
| `declined`    | Nothing in the catalog matches the request.             | What the assistant CAN do.                                |

`needs_input` names ONE field, because a turn asks one question: a person handed three at once
retypes the whole sentence anyway, and the second question is usually answered by whatever settles
the first.

Everything that is a genuine FAILURE stays an error and goes through the one error funnel with its
`details.reason` intact, exactly as the equivalent button's failure does: no model configured
(`assistant_model_unavailable`), the workspace budget spent (`budget_exhausted`), a reply that
carried no decision (`assistant_reply_unreadable`), the vendor failing (`assistant_generation_failed`),
plus every refusal the services underneath already raise (an unconfigured tracker, an issue already
filed as a task, a board rule).

## The action catalog

An action is a declaration plus a function:

```ts
interface AssistantActionDefinition {
  actionId: AssistantActionId
  purpose: string // one line, for the model's catalog
  examples: readonly string[] // prompts that should route here
  parameters: readonly DescriptorField[] // the shared descriptor vocabulary
  run(context): Promise<AssistantActionOutcome>
}
```

`parameters` are ordinary DESCRIPTOR FIELDS, the same vocabulary a task type's form and an inline
use case's brief are declared in. So the arguments are validated by the shared validator rather than
by per-action code, and the catalog the model is shown is DERIVED from the same declaration the
validator reads. The two cannot drift into describing different arguments.

`run` returns an OUTCOME rather than throwing for an unresolvable argument, because "no service by
that name" is a fact about the sentence and the answer to it is a question with candidates.
Exceptions keep their usual meaning: a refusal by the service underneath.

### Shipped actions

| Action                       | Arguments                              | What it calls                                                         |
| ---------------------------- | -------------------------------------- | --------------------------------------------------------------------- |
| `declare-service-dependency` | `consumer`, `provider`, `description?` | `BoardService.updateBlock` with the frame's `serviceConnections`      |
| `add-service-from-repo`      | `repoUrl`, `directory?`                | `BoardService.addServiceFromRepo`                                     |
| `create-task-from-issue`     | `issueUrl`, `service?`                 | `TaskImportService.import` then `TaskLinkService.createTaskFromIssue` |

Each is the operation a board button already performs, so the assistant adds a way to ASK for it
rather than a capability nobody could otherwise reach. Nothing here restates a board rule: a
self-edge, a duplicate connection, an issue already filed and a container in the wrong workspace are
all refused by the services underneath, and they arrive at the SPA as the same errors the inspector
would raise.

What the actions DO own is the resolution the board button gets from a form and a prompt does not:

- **A service NAME → a frame.** Three passes, narrowest first: exact title, then
  punctuation-insensitive (`user service` ⇄ `user-service`), then containment. The order is the
  rule: a board holding both `Api` and `Api Gateway` must not report them as ambiguous when one was
  named outright. A pass matching SEVERAL is reported as ambiguous WITH their titles rather than
  tie-broken, because every available tiebreak picks a service on grounds the person never stated.
- **A repository URL → a projected repo.** Through the shared `parseRepoWebUrl`, the same parser the
  repository picker resolves a pasted URL with, so GitHub and GitLab shapes (subgroups, `/-/`,
  `/tree/<ref>/<path>`) are understood identically on both surfaces. The repository must already be
  projected for the workspace: a URL that is not is either a repository the deployment has no
  credential for or one whose connection has not synced, and inventing a link for it would create a
  service frame whose every run fails at clone time.
- **An issue URL → a tracker, and a service.** Which tracker is answered by asking every ENABLED
  source's own `parseRef`; two answers is a question, never a pick, so the registry's ordering can
  never decide which tracker a person's issue came from. Which service is the one whose linked
  repository the issue lives in (`Service.repoGithubId`, the sole repo ⇄ frame linkage), read for the
  whole board in one batched query. A tracker with no repository (Jira, Linear), a repository this
  workspace does not project, and a monorepo repository backing several services all land on the
  same question, because the person's next move is the same in all three.

### Why the catalog is not a registry

Every action performs a board write through an engine-internal service. That is the same reason the
`merger` step resolver is a privileged built-in rather than a registry entry: opening the catalog to
deployment-registered actions means giving an action a public, minimal context first, and that is a
design decision of its own. The tracker
([`in-app-assistant.md`](../../docs/initiatives/in-app-assistant.md)) holds it as a named next step,
with the `AssistantRouter` seam a conformance group would need alongside it.

An action whose integration a deployment did not wire is OMITTED from the catalog rather than
registered and left to fail. The catalog is what the model routes against, so an unwired action is
one the model can still choose, and the turn would then answer a legitimate request with an
internal-sounding refusal. Omitted, the same request declines with "nothing in the catalog does
that", which is both true of this deployment and what its `available` capability read already said.

## Model, spend and telemetry

A turn resolves its model exactly as the bug-hunt ranking does: an EMPTY selection through
`resolveInlineBlockModelRef`, so nothing pins a model or picks a preset and the workspace DEFAULT
preset supplies both the model and the route order. A container-only subscription ref degrades to
the routing default, since there is no container here.

The call is tagged `agentKind: 'assistant'` through `catFactoryObservability`, so its tokens land in
the same rollups every other inline call does and an operator can see what the assistant spends.

It answers to the workspace BUDGET (`SpendService.isOverBudget`), like every billable model call no
run start gates. The guard runs BEFORE the vendor call and fails closed with `budget_exhausted`.

## Authorization

Member tier, mounted ungated in `WORKSPACE_CONTROLLERS`: what a turn does is board authoring, all of
it reachable from a button beside the prompt box, so gating the assistant on `integrations.manage`
would mean a member could do each of those by hand but not ask for them. The workspace gate's viewer
write floor covers the POST.

Every board write the chosen action makes carries the ASKER's own tier (`blockEditAuthority`), so the
assistant can never be a way around a policy its user is held to.

## Runtime symmetry

There is nothing per-facade here. The module is composed in `createCore` from dependencies every
facade already provides: no new port implementation, no table, no migration, no cron. That is why
the change ships without a conformance group; the ports it reads through
(`RepoProjectionRepository`, `ServiceRepository.listByFrameBlocks`, the board composition) are
already covered by theirs. Adding the `AssistantRouter` seam is what would make an end-to-end turn
assertable per facade, and it is on the tracker with the reason.
