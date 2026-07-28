# @cat-factory/prompt-fragments

The **built-in tier** of best-practice prompt fragments — small, curated guidance
snippets that get folded into an agent's system prompt at run time
(`composeSystemPrompt`). This package is **plain, build-static data**: no I/O, no
framework. It is the source of truth for the shipped defaults and the seed for the
tenant-scoped [prompt-fragment library](../../docs/adr/0006-prompt-fragment-library.md).

## What's here

- `src/collections/*.ts` — fragments authored per topic. Today: `node`, `react`,
  `acceptance`, `design`, `style`, `migration`. Each exports an array of `PromptFragment`.
- `src/index.ts` — merges the collections into a single `FRAGMENTS` registry plus
  `FRAGMENTS_BY_ID` and `getFragment(id)` for O(1) lookup during composition.

A `PromptFragment` (shape defined in [`@cat-factory/contracts`](../contracts))
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
  [ADR 0006](../../docs/adr/0006-prompt-fragment-library.md).

### Two-tier bodies: `body` and `brief`

An **implementer** kind (`coder` / `fixer` / `ci-fixer` / `conflict-resolver` — the kinds
carrying the `brief-standards` trait) runs a long agentic loop whose system prompt, standards
included, is re-sent on **every turn**. Those kinds fold a fragment's optional `brief` — the
same standard stated tersely — instead of its full `body`. Reviewer / planner / investigator
kinds keep the full text: they run few turns and benefit from it when judging built work.

Two rules govern authoring one:

- **A `brief` must not drop a rule, only its elaboration.** It is the same standard compressed,
  not a subset — an agent folding the brief is held to everything the body demands.
- **`brief` travels WITH the body it condenses** and is never re-resolved by id downstream. A
  higher tier that overrides a built-in id supplies no brief (managed rows have no such column),
  so the override's own full `body` is folded — never the built-in's condensed text over a
  tenant's standard.

Omitting `brief` is always safe: the full `body` is used for every kind, unchanged. Fragments
that can reach an implementer kind carry one; the ones scoped to `spec-writer` / `playwright` /
document-authoring kinds (which are not implementers) deliberately do not.

## Programmatic deployment seams (custom fragments + per-task-type defaults)

Two **module-global** registration seams let a deployment (local **or** hosted) extend
the fragment behaviour at startup — an import side effect from the deployment entry, run
**once before** `start()` / `startLocal()`, mirroring `registerAgentKind`. No fork, no
rebuild, no per-workspace UI.

- **Add custom fragments to the universal pool** — `registerPromptFragment(fragment)` /
  `registerPromptFragments(fragments)`. Every `GET /prompt-fragments` catalog read and
  every run-time body lookup then sees them; re-registering an id overrides the built-in
  of that id. (`universalFragments()` is the merged built-in ∪ registered pool.)
- **Mark fragments as the default for a task type** —
  `registerTaskTypeDefaultFragments(taskType, fragmentIds)`. Every **new** task of that
  type (`document`, `review`, `feature`, …) is then seeded with those fragments onto its
  own `fragmentIds` at creation (unioned with the built-in defaults and whatever it
  inherits from its service). The board resolves a new task's seed set through
  `defaultFragmentIdsForTaskType(taskType)`; the only built-in per-type default is the
  document writing-style set (`DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS`), which registered
  ids augment rather than replace. Seeding is server-side and authoritative — it applies
  even for tasks created via the public API with no create-form picker.

```ts
// deployment entry, before start()/startLocal()
import {
  registerPromptFragments,
  registerTaskTypeDefaultFragments,
} from '@cat-factory/prompt-fragments'

registerPromptFragments([
  {
    id: 'org.review-checklist',
    version: '1.0.0',
    title: 'Review checklist',
    summary: 'Our PR review bar.',
    body: '- Check error handling…',
  },
])
// every new REVIEW task starts with this guidance
registerTaskTypeDefaultFragments('review', ['org.review-checklist'])
```

## Adding a collection

1. Create `src/collections/<topic>.ts` and export an array of `PromptFragment`.
2. Spread it into `FRAGMENTS` in `src/index.ts`.
3. Keep ids **globally unique and stable** — blocks persist them, so a renamed id
   silently drops a selection (unknown ids are skipped, never error).

```bash
pnpm --filter @cat-factory/prompt-fragments build       # tsc → dist/
pnpm --filter @cat-factory/prompt-fragments typecheck
```
