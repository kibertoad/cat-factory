# Inline use cases: non-container model work a deployment declares and `/api/v1` publishes

> **Authoring one is on the website**:
> [Package an Inline Use Case](https://www.catfactory.ai/extend/inline-use-cases.html) owns the
> registration bundle, the parameter vocabulary and the worked composition-root example, and
> [Public API](https://www.catfactory.ai/extend/public-api.html) owns the caller's side. This page
> is the ENGINE side: where each declaration is read, why the surface holds no state at all, and
> why a model this deployment cannot serve is refused rather than substituted.

An **inline use case** is a named piece of model work an organisation runs from OUTSIDE the board:
"write the prose for this scene", "rewrite this barks list in the villain's register". It takes a
small form, runs ONE inline LLM call, and answers with text. There is no task, no repository, no
pipeline, no container and no run.

The feature exists for a wrapper over `/api/v1`: an external content editor whose users generate
creative writing and whose author wants that generation to run on a NARROW set of models, chosen
per kind of work, through the deployment's own credentials, budget and telemetry. Everything the
platform offered for that shape before was run-scoped, so such a wrapper's only route was to hold
its own vendor keys beside the deployment's, which puts the spend outside the workspace budget and
the calls outside the observability the platform exists to keep.

The vehicle is one more app-owned registry, `InlineUseCaseRegistry` (kernel
`domain/inline-use-case-registry.ts`), injected by reference like every other:
`start({ inlineUseCaseRegistry })`, `startLocal({ inlineUseCaseRegistry })`, the Worker's
`inlineUseCaseRegistry` override. `defaultInlineUseCaseRegistry()` is EMPTY: the platform ships no
use case, exactly as it ships no custom task type.

## Where each declaration is read

| Declaration    | Read at           | By                                                                 |
| -------------- | ----------------- | ------------------------------------------------------------------ |
| `models`       | discovery, invoke | `projectModel` / `InlineUseCaseService.requireModelOption`         |
| `parameters`   | discovery, invoke | the SHARED `validateDescriptorFields` / `sanitizeDescriptorFields` |
| `generation`   | discovery, invoke | `useCaseGenerationLimits`, then the range check                    |
| `systemPrompt` | invoke            | `composeUseCasePrompt`                                             |
| `compose`      | invoke            | `composeUseCasePrompt`, when the registration overrides the fold   |

## It persists NOTHING, and that is the design

There is no table, no migration and no repository method, on either facade. A use case is code a
deployment registered; an invocation is a request, a model call and a response. The only durable
trace is the `llm_call_metrics` row every inline call already writes, tagged with the use case's id
as its agent kind, so an operator sees what an editor spends per use case rather than as one
undifferentiated `inline` bucket.

Two rules the rest of the repository states elsewhere therefore do not bite here, and it is worth
saying why rather than leaving the next reader to check: the mothership repository-bucket rule
(there is no repository method to route) and the "state a deployment registers in CODE and a RUN
resolves" rule (nothing here is resolved by a run: the process serving the request resolves its own
registry, composes, and calls the model). What DOES apply is the ordinary facade-symmetry rule, and
the seam guard enforces it: `runtimes/node/test/registry-seams.spec.ts` fails until the registry is
an option on both the container builder and the boot entry point, and until each facade exports a
way to construct one.

## The narrowing is the feature, so nothing substitutes a model

Every other inline caller in the engine degrades a model it cannot serve: `inlineModelRef` turns a
container-only subscription ref into the routing default, which is right where the model is an
implementation detail of a pipeline step. Here the model IS the request, so:

- a model the use case does not declare is `422` `use_case_model_not_allowed`, with the allowed ids
  in `details.allowed` so a caller holding a stale catalog corrects itself from the refusal;
- a declared model this deployment cannot serve inline is `503` `use_case_model_unavailable`,
  carrying which of the two causes it is;
- neither falls through to another model. A narrowed list that silently substitutes is not a
  narrowing, and the caller has no way to see it happened: the text just reads differently.

The two unavailability causes are separate because they lead to different people.
`provider_unavailable` means nothing here resolves the model (no route for the catalog id, or no
resolver registered for the ref's provider), which an operator fixes by configuring the provider.
`container_only` means it resolves only through a subscription harness that runs inside a per-run
container, which this surface has none of; no amount of operator wiring changes that, so the caller
picks another model. Local mode is the one place the second answer differs: an ambient
`claude`/`codex` login CAN serve such a ref inline, and the facade's `runsInline` predicate says so.

## Discovery answers, even when nothing can run

`GET /api/v1/use-cases` is served from the registry and never 404s or 503s:

- a deployment that registered nothing answers `{ "useCases": [] }`, because an empty catalog and a
  missing surface are different facts and a `404` would tell a wrapper this deployment does not
  support use cases at all;
- a deployment with no model provider answers the full catalog with every model
  `available: false, unavailableReason: "provider_unavailable"`, because a picker that renders
  nothing reads as a use case with no models rather than as a key nobody has configured.

Only the INVOCATION refuses in that state, with `503` `use_case_models_unconfigured`, which names
the deployment-level gap rather than reporting four models as individually broken.

## One credential binding per request, carrying all three tiers

Resolving a credential scope is not free: it reads the workspace's owning account, the configured
providers, and then LEASES a key per provider, which is an atomic select-and-mark WRITE plus a secret
decrypt. So the generator seam is bound ONCE per request (`InlineUseCaseGenerator.forScope`) and the
returned session answers every availability probe off that one resolution. That is why
`InlineUseCaseSession.availability` is synchronous: the type is what states that probing an option
costs no I/O, so a discovery read over a catalog cannot quietly become a fan-out of reads and lease
writes again (it once was, once per declared model of every registered use case: a read-scope `GET`
doing lease writes whose usage stamps then skewed the rotation they never spent a token on).

The scope is the ACCOUNT, the WORKSPACE and the USER the key acts as, because all three carry
provider keys and the acting user also carries their own locally-run model endpoints. Both things
downstream reads it for are tiered, and dropping a tier is silent in opposite directions:

- the model pool would omit account- and user-scoped keys, so a model this deployment CAN serve
  publishes as `provider_unavailable` and the operator hunts a key that is already configured;
- `SpendService.isOverBudget` consults the account and user ceilings only when the scope names them,
  so an account past its monthly limit would keep generating through whichever of its workspaces is
  still under its own.

`forScope` may THROW, because its read is a real one, and the two callers answer that differently ON
PURPOSE. Discovery catches it, logs the cause and publishes the catalog with every model unavailable:
a read that 500s tells a wrapper the surface does not exist when what failed was one query behind it.
The invocation lets it propagate, because "the pool could not be read" is not an availability answer,
and reporting it as one would send the caller to pick another model over a fault that has nothing to
do with the one they named.

## The refusal ORDER is cheapest-first

`InlineUseCaseService.invoke` refuses in a fixed order, and the order is the point: each step costs
more than the one before it, so a request that was never going to run spends nothing.

1. **The registration** and **the parameters**, from the request alone: no read at all.
2. **The model option**, against the declared list: still no read.
3. **The generation bounds**: refused, never clamped. Silently running at the ceiling answers a
   request for one generation with a different one while reporting success, and the caller stores
   the text believing it came from the settings it asked for.
4. **The credential binding**, which resolves the pool once, and then the model's AVAILABILITY,
   which is a free read off it.
5. **The workspace budget** (`SpendService.isOverBudget`), which reads the spend ledger. An
   invocation is a billable model call that no run start gates, exactly like the bug hunt's ranking,
   so it answers to the same safeguard; the refusal is `429` `budget_exhausted`, its own cause
   rather than a generic failure, and fail-CLOSED.
6. **The vendor call**, bounded by a deadline (2 minutes by default) and one retry. A synchronous
   surface owes that bound: without it a stalled vendor holds the caller's request open for as long
   as the transport allows, and the AI SDK would retry it twice over. A call the vendor did not
   complete is `503` `use_case_generation_failed`; one that ran out of time is `503`
   `use_case_generation_timeout`, its own reason because the caller's move differs (retry with a
   smaller `maxOutputTokens`, rather than surface the failure to whoever asked).

A reply with no usable text is `503` `use_case_empty_reply` rather than a `200` carrying an empty
string: some reasoning models answer only into their private channel, and a content editor would
otherwise store that silence as the model's answer. A reply that hit the output budget comes back
with `finishReason: "length"` and `truncated: true`, so a consumer knows the text is a prefix.

## The parameter form is the SHARED descriptor vocabulary

`parameters` is `contracts/src/form-fields.ts`, the same vocabulary a reusable operation's per-case
brief and an initiative preset's create form draw on, narrowed to the six types that make sense with
no checkout. `password` is excluded for the reason a task-type field excludes it (the value is
folded into the prompt and captured in telemetry, so it is the wrong home for a secret), and `path`
because it means a repo-relative directory and there is no repository in this call.

That reuse is what lets one validator cover the surface: `validateDescriptorFields` names every
problem at once under `details.reason: "use_case_parameters_invalid"`, defaults fold in through
`withDescriptorFieldDefaults` at the door (so a headless caller and a form mean the same thing by a
declared default), and the answers reach the prompt through `renderDescriptorFieldValue`, which is
why a `select` renders as its caption rather than its stored enum value.

The default fold is what makes a use case declarable with NO code: a `systemPrompt` plus a parameter
list already produces a labelled brief. A registration overrides `compose` when the ordering or the
phrasing of that brief is itself the product. An unanswered parameter is OMITTED from the brief
rather than rendered empty, because a heading with nothing under it reads to a model as an
instruction to invent one.

## Boot validation

A registration is checked once at boot, through the same `validateRegistrations` a facade already
calls with its container. Every problem is an ERROR by this validator's bar (fully knowable from the
registration itself): an id that is not namespaced (the id IS the path segment), an empty model
list, a duplicated model id, several models flagged default or several with none flagged, a
generation bound whose own default falls outside it, and the parameter form held to the same bar
every other descriptor form meets.

Three of the checks exist because the alternative is not silence but MISATTRIBUTION:

- a `catalog` model id nothing resolves (`gemini-flahs`) would publish as `provider_unavailable`,
  whose documented remedy is "configure the provider", so the operator hunts a key for a model that
  will never resolve. The catalog is a compile-time constant, so boot knows the answer, and the
  two-member public reason vocabulary is spared a third member for a state that cannot happen;
- a caption outside the PUBLISHED bounds (a blank `label`, a 600-character `description`) would
  serve a shape this surface's own OpenAPI calls impossible, and serve it silently, because a
  response is not re-validated on the way out. The bounds are read from contracts'
  `USE_CASE_TEXT_LIMITS` rather than restated, so the guard and the schema cannot drift;
- a blank `systemPrompt` is the invariant the type comment already argues for: a use case with no
  instruction is an unrestricted model call wearing a name.

A SINGLE model with no `default` flag is accepted: there is nothing to choose between, so requiring
the flag would fail boot over a use case nobody can misread.

## Where the code lives

| Concern                            | File                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------ |
| The registry + the pure rules      | `kernel/src/domain/inline-use-case-registry.ts`                          |
| The generation seam                | `kernel/src/ports/inline-use-cases.ts`                                   |
| The surface's rules                | `orchestration/src/modules/useCases/InlineUseCaseService.ts`             |
| The default model-calling producer | `orchestration/src/modules/useCases/LlmInlineUseCaseGenerator.ts`        |
| What one invocation cost           | `orchestration/src/modules/useCases/useCaseUsage.ts`                     |
| Boot validation                    | `orchestration/src/validation/validateInlineUseCases.ts`                 |
| The routes                         | `server/src/modules/publicApi/PublicUseCaseController.ts`                |
| The wire shapes                    | `contracts/src/inline-use-cases.ts`, `contracts/src/routes/use-cases.ts` |
| Cross-runtime coverage             | `conformance/src/suites/integration-public-use-cases.ts`                 |

Related: [`reusable-operations.md`](./reusable-operations.md) (the CONTAINER sibling: a form bundled
with a pipeline that runs agents on a checkout), [`public-api.md`](./public-api.md) (what the
surface promises a consumer), [`llm-telemetry.md`](./llm-telemetry.md) (where an invocation's tokens
land) and [`model-support.md`](./model-support.md) (how a provider is configured at all).
