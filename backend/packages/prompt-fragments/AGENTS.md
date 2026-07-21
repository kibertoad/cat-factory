# `@cat-factory/prompt-fragments` — versioned best-practice prompt fragments

Curated, versioned best-practice fragments injected into agent system prompts. **See
[README.md](./README.md).**

**Entry:** `src/index.ts`; the fragment bodies live under `src/collections/`. The
deployment-programmatic seams also live at the entry: `registerPromptFragment(s)` (add
custom fragments to the universal pool) and `registerTaskTypeDefaultFragments` /
`defaultFragmentIdsForTaskType` (`src/task-type-defaults.ts` — mark fragments as the
default for every new task of a given type, e.g. documentation or review).
