# @cat-factory/prompt-fragments

The **built-in tier** of best-practice prompt fragments: small, curated guidance
snippets that get folded into an agent's system prompt at run time
(`composeSystemPrompt`). This package is **plain, build-static data**: no I/O, no
framework. It is the source of truth for the shipped defaults and the seed for the
tenant-scoped [prompt-fragment library](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/adr/0006-prompt-fragment-library.md).

## What's here

- `src/collections/*.ts`: fragments authored per topic. Today: `node`, `react`,
  `acceptance`, `design`, `style`, `migration`. Each exports an array of `PromptFragment`.
- `src/index.ts`: merges the collections into a single `FRAGMENTS` registry plus
  `FRAGMENTS_BY_ID` and `getFragment(id)` for O(1) lookup during composition.

A `PromptFragment` (shape defined in [`@cat-factory/contracts`](https://github.com/kibertoad/cat-factory/tree/main/backend/packages/contracts))
carries an `id`, `version`, `title`, optional `category`, a `summary` (used by the
relevance selector), the `body` (injected text), an optional condensed `brief`
(see below), and an optional `appliesTo` hint (`blockTypes` / `agentKinds`).

## How it's used

- The Worker serves this catalog **read-only** at `GET /prompt-fragments`; the SPA
  shows it in the per-block fragment picker.
- A block stores selected `fragmentIds[]`; at run time core composes the chosen
  bodies into the system prompt. Each standard is folded as its **own delimited,
  title-labelled block** (`<best-practice-standard id="…" title="…">`) rather than one
  concatenated blob, so an agent can tell the standards apart and cite one by its title
  (`composeSystemPrompt` / `composeBlockSystemPrompt` in `@cat-factory/agents`). The
  code + PR **review** agents additionally report per-standard **adherence** (a 1–10
  rating + related findings) back on the step, surfaced in run details.
- When the optional library is enabled, this becomes the **built-in tier** of a
  three-tier merge (built-in ∪ account ∪ workspace); ids here can be shadowed or
  suppressed by higher tiers. See
  [ADR 0006](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/adr/0006-prompt-fragment-library.md).

### Two-tier bodies: `body` and `brief`

An **implementer** kind (`coder` / `fixer` / `ci-fixer` / `conflict-resolver`: the kinds
carrying the `brief-standards` trait) runs a long agentic loop whose system prompt, standards
included, is re-sent on **every turn**. Those kinds fold a fragment's optional `brief` (the
same standard stated tersely) instead of its full `body`. Reviewer / planner / investigator
kinds keep the full text: they run few turns and benefit from it when judging built work.

Two rules govern authoring one:

- **A `brief` must not drop a rule, only its elaboration.** It is the same standard compressed,
  not a subset: an agent folding the brief is held to everything the body demands.
- **`brief` travels WITH the body it condenses** and is never re-resolved by id downstream. A
  higher tier that overrides a built-in id supplies its OWN brief (or none), so the override's
  own text is folded, never the built-in's condensed text over a tenant's standard.

Omitting `brief` is always safe: the full `body` is used for every kind, unchanged. Fragments
that can reach an implementer kind carry one; the ones scoped to `spec-writer` / `playwright` /
document-authoring kinds (which are not implementers) deliberately do not.

Every fragment in **this** package is comfortably under `FRAGMENT_BRIEF_MIN_BODY_CHARS`, so the
auto-condensation below never acts on the shipped catalog: keep it that way by writing a brief
by hand when a built-in grows past ~1,500 characters.

### Where a brief comes from at run time

The built-in `brief` above is only the first of three answers. For a fragment resolved through
the tenant library ([ADR 0006](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/adr/0006-prompt-fragment-library.md)) the resolution
order is:

1. **The winning tier's linked `brief`**: a built-in's, or the one a tenant authored on its own
   managed row (the library editor's short-version field, or a repo-sourced guideline file's
   `brief:` frontmatter key).
2. **A model-GENERATED condensation**, for a body over `FRAGMENT_BRIEF_MIN_BODY_CHARS` that has
   no linked brief. Produced once on the first implementer dispatch that folds it, persisted, and
   **regenerated whenever the body changes**: a library edit, a repo resync, or a living
   document re-resolved at run time.
3. **Nothing**: the full `body` is folded for every kind, which is also where every failure on
   that path lands (no model wired, an unreadable store, a refused condensation).

Design, decisions and gotchas:
[`docs/initiatives/auto-generated-fragment-briefs.md`](https://github.com/kibertoad/cat-factory/blob/main/docs/initiatives/auto-generated-fragment-briefs.md).

## Programmatic deployment seams (custom fragments + per-task-type defaults)

A deployment (local **or** hosted) extends the fragment behaviour through the app-owned
`PromptFragmentRegistry` (kernel), injected BY REFERENCE into the facade it builds. No fork, no
rebuild, no per-workspace UI.

> **This replaced two MODULE GLOBALS** (`registerPromptFragment` and
> `registerTaskTypeDefaultFragments`), and the reason is worth stating because it is invisible from
> inside this repo. Their correctness depended on every reader resolving the same physical copy of
> this package. A `workspace:*` dependency publishes as an EXACT version, so a consumer floating the
> range onto a newer patch gets TWO copies: the registration lands in one, the server reads the
> other, and every task of the deployment's operation is seeded with ids that fold nothing. The only
> signal was one boot warning, which is also the warning a typo produces.

- **Build the registry**: `promptFragmentRegistryWithBuiltins()` (this package) news one carrying
  the shipped catalog and its built-in per-type defaults; `defaultPromptFragmentRegistry()` (kernel)
  news an EMPTY one, which is how a deployment says it wants only its own standards. The built-ins
  install through the registry's ordinary public methods, so the platform exercises a consumer's own
  seam on every boot and it cannot rot for consumers only.
- **Add custom fragments to the universal pool**: `registry.register(fragment)` /
  `registry.registerAll(fragments)`. Every `GET /prompt-fragments` catalog read and every run-time
  body lookup then sees them; re-registering an id REPLACES the entry of that id, so a deployment
  refines a shipped standard in place.
- **Mark fragments as the default for a BUILT-IN task type**:
  `registry.registerTaskTypeDefaults(taskType, fragmentIds)`. Every **new** task of that type
  (`document`, `review`, `feature`, …) is then seeded with those fragments onto its own
  `fragmentIds` at creation, beside whatever it inherits from its service. Seeding is server-side
  and authoritative: it applies even for tasks created via the public API with no create-form picker.

  **Registering a type REPLACES its built-in set rather than unioning with it.** The module-global
  seam unioned silently, which meant a deployment could not remove a shipped default however it
  wrote the call. Spread `DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS` into your own list to keep both,
  which says so in the code.

  **A deployment's OWN (namespaced) task type does not use this seam.** It declares
  `defaultFragmentIds` (and `conditionalFragmentIds`, for standing context that depends on the
  answers a case supplies) on its own registration, where boot validation can see the ids and warn
  on one the code pool does not resolve. That declaration is one third of a **reusable operation**:
  see [`backend/docs/reusable-operations.md`](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/reusable-operations.md).

- **A code-registered fragment may NOT carry a `documentRef`.** Every code registration lands on the
  `builtin` tier, whose live resolution needs a connection workspace a deployment-wide registration
  cannot name, so boot REFUSES it (`fragment_document_ref_unsupported`) rather than carrying it,
  rendering it as live in the library UI, and ignoring it at run time (which is what it did).
  Register the body inline, or create the fragment at the ACCOUNT tier with a fetch-via workspace.

```ts
// deployment entry, before start()/startLocal()
import { promptFragmentRegistryWithBuiltins } from '@cat-factory/prompt-fragments'

const promptFragmentRegistry = promptFragmentRegistryWithBuiltins()
promptFragmentRegistry.registerAll([
  {
    id: 'org.review-checklist',
    version: '1.0.0',
    title: 'Review checklist',
    summary: 'Our PR review bar.',
    body: '- Check error handling…',
  },
])
// every new REVIEW task starts with this guidance
promptFragmentRegistry.registerTaskTypeDefaults('review', ['org.review-checklist'])

// …and the SAME instance goes into the facade, which is the whole point.
start({ promptFragmentRegistry /* …the rest */ })
```

**In MOTHERSHIP mode the pool is read from the mothership**, not from the node's own registry: the
standards are org state, and a node one build behind would otherwise fold different guidance than
the deployment registered. A failed read THROWS rather than answering with an empty pool, because
"the mothership is unreachable" and "this deployment registers no standards" are the same value and
opposite facts. Boot warns and names any fragments registered on a mothership-mode node.

## Adding a collection

1. Create `src/collections/<topic>.ts` and export an array of `PromptFragment`.
2. Spread it into `FRAGMENTS` in `src/index.ts`.
3. Keep ids **globally unique and stable**: blocks persist them, so a renamed id
   silently drops a selection (unknown ids are skipped, never error).

```bash
pnpm --filter @cat-factory/prompt-fragments build       # tsc → dist/
pnpm --filter @cat-factory/prompt-fragments typecheck
```
