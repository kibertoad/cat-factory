---
'@cat-factory/executor-harness': patch
'@cat-factory/local-server': patch
'@cat-factory/agents': minor
'@cat-factory/consensus': patch
'@cat-factory/server': patch
---

Cut the pr-reviewer's token burn, and fix slice progress reading 0% for a whole review.

**Slice progress.** The harness derived progress from tool names the Claude Code CLI no longer
emits: subagent dispatch is `Agent` (the shipped `sdk-tools.d.ts` has no `TaskInput` at all), and
the plan arrives as `TaskCreate`/`TaskUpdate` rather than `TodoWrite`. Both matchers missed, so a
437-turn parallel review reported no slices and no progress. The slice tracker now matches `Agent`
alongside the legacy `Task`, and a new `progress.ts` reads both plan vocabularies — `TaskCreate`
needs the tool result too, since the CLI mints the task id there.

**Token burn.** Measured on a ~450-file review: 437 turns, 39.5M cache-read tokens. Cost is
turns × context, so anything loaded early is re-paid on every later turn.

- Agent kinds can now declare `standardsDelivery: 'context-files'`: their resolved best-practice
  standards are NOT folded into the system prompt. `pr-reviewer` takes this and writes them as
  one `.cat-context/standard-<id>.md` file each. Folding charged the parent for every standard on
  every turn (~3.7M tokens) while the slice subagents that actually review the code never received
  them and worked from the parent's paraphrase — so `fragmentAdherence` was rated from a summary
  rather than the standard's text. The reviewer's adherence guidance now points at those files
  (not "folded into this prompt above"), and if the standards preOp couldn't run (GitHub unwired)
  the engine falls back to folding so a review never loses its standards through both channels.
  `composeBlockSystemPrompt`'s delivery argument is now required, so no call site (consensus
  included) can silently re-fold a `context-files` kind's standards. Two standard ids that
  sanitize to the same filename no longer collide (a short id hash disambiguates), so the harness
  can't drop one.
- `pr-diff.md` now leads with a change-shape rollup and a deterministic suggested slicing
  (`planSlices`, size-capped), and inlines patches only when the whole diff fits one pass. A
  partially-inlined large diff was carried on every turn and bypassed anyway — the slice subagents
  ran 141 git calls and referenced it once.
- Existing review comments are grouped by file under a path index, so a slice greps its own
  threads instead of the parent reading all of them into context.
- The reviewer prompt now states the context discipline explicitly (ranged reads, never re-read,
  never dump a whole file, don't read a slice you are about to delegate, keep slices small) and
  tells it to dispatch slice subagents on a cheaper model.
