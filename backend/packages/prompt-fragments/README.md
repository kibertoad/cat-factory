# @cat-factory/prompt-fragments

The **built-in tier** of best-practice prompt fragments — small, curated guidance
snippets that get folded into an agent's system prompt at run time
(`composeSystemPrompt`). This package is **plain, build-static data**: no I/O, no
framework. It is the source of truth for the shipped defaults and the seed for the
tenant-scoped [prompt-fragment library](../../docs/adr/0006-prompt-fragment-library.md).

## What's here

- `src/collections/*.ts` — fragments authored per topic. Today: `node`, `react`,
  `acceptance`. Each exports an array of `PromptFragment`.
- `src/index.ts` — merges the collections into a single `FRAGMENTS` registry plus
  `FRAGMENTS_BY_ID` and `getFragment(id)` for O(1) lookup during composition.

A `PromptFragment` (shape defined in [`@cat-factory/contracts`](../contracts))
carries an `id`, `version`, `title`, optional `category`, a `summary` (used by the
relevance selector), the `body` (injected text), and an optional `appliesTo`
hint (`blockTypes` / `agentKinds`).

## How it's used

- The Worker serves this catalog **read-only** at `GET /prompt-fragments`; the SPA
  shows it in the per-block fragment picker.
- A block stores selected `fragmentIds[]`; at run time core composes the chosen
  bodies into the system prompt.
- When the optional library is enabled, this becomes the **built-in tier** of a
  three-tier merge (built-in ∪ account ∪ workspace); ids here can be shadowed or
  suppressed by higher tiers. See
  [ADR 0006](../../docs/adr/0006-prompt-fragment-library.md).

## Adding a collection

1. Create `src/collections/<topic>.ts` and export an array of `PromptFragment`.
2. Spread it into `FRAGMENTS` in `src/index.ts`.
3. Keep ids **globally unique and stable** — blocks persist them, so a renamed id
   silently drops a selection (unknown ids are skipped, never error).

```bash
pnpm --filter @cat-factory/prompt-fragments build       # tsc → dist/
pnpm --filter @cat-factory/prompt-fragments typecheck
```
