# Initiative: linked + auto-generated condensed briefs for best-practice standards

## Goal & rationale

An implementer kind (`coder` / `fixer` / `ci-fixer` / `conflict-resolver` — the `brief-standards`
trait) re-sends its **whole system prompt on every turn** of a long agentic loop. Every
best-practice standard folded into that prompt is therefore paid for again and again, which is
exactly why the two-tier `body` / `brief` split exists: those kinds fold a standard's condensed
`brief` when it has one, and everyone else keeps the full text.

Two gaps made that split almost inert in practice:

1. **Only the built-in tier could carry a brief at all.** `prompt_fragments` had no `brief`
   column, so every managed standard — hand-authored, repo-sourced, or a living Confluence /
   Notion page — folded in full, **including one that OVERRIDES a built-in id**. A tenant could
   not supply a short version even when they had one.
2. **Nothing produced a brief for a standard that lacked one.** A team's actual engineering
   guidelines are long: they are the standards where per-turn cost matters most, and they are
   precisely the ones with no hand-written condensation.

This initiative closes both: a tenant can **link** a short version, and a long standard with none
gets one **generated once and reused**, **regenerated whenever the standard's body changes**.

## Confirmed decisions

- **Two sources, in precedence order: AUTHORED then GENERATED.** A `brief` column on
  `prompt_fragments` carries the linked short version (the library editor's field, or a
  repo-sourced file's `brief:` frontmatter key); a `fragment_briefs` table carries the
  model-generated condensation. A linked brief always wins — a human's condensation of their own
  standard beats any we could synthesize, and linking one is also how a curator OPTS OUT of
  generation.
- **A threshold, not "always condense".** `FRAGMENT_BRIEF_MIN_BODY_CHARS` (1,500 chars ≈ 375
  tokens) is the point where re-sending the full standard across a 50-turn loop is worth one
  condensation call. Below it the full body is folded for every kind — byte-for-byte the
  pre-feature behaviour. Calibration check: **no shipped built-in reaches it** (the longest is
  1,444 chars, and it already carries a hand-written brief), so the built-in catalog is
  unchanged and the feature acts only on tenant-scale standards.
- **Generated briefs are a TABLE OF THEIR OWN, not columns on `prompt_fragments`.** They are
  derived data with their own lifecycle (regenerated, never authored, safe to drop). Three
  things fall out of the separation: a **built-in / deployment-registered** fragment — which has
  no managed row at all — can carry one; the tier merge's shadow / tombstone / reseed semantics
  are untouched (relevant to `docs/initiatives/fragment-definitions-reseed.md`, which persists
  built-ins as marked rows); and pruning is a delete rather than a nulling update.
- **Staleness is a FINGERPRINT of the condensed body, not a change feed.** Each row stores a
  length-prefixed digest of the body it condensed; a mismatch against the body resolved at run
  time means the standard moved and the brief is regenerated. This is what makes "regenerate
  when the source document changes" cover all three ways a body moves — a library edit, a repo
  resync, and a **living document re-resolved at run time** — with one mechanism.
- **Resolution happens on the RUN path, in `resolveBodiesForRun`, not on the write path.** The
  document-backed case is decisive: a Confluence/Notion body is re-resolved at dispatch, so
  there is no write to hook. Resolving here also makes generation **demand-driven** — only the
  standards an implementer actually receives are ever condensed, rather than the whole catalog
  on the chance someone folds it.
- **Only a `brief`-verbosity dispatch resolves briefs.** `AgentContextBuilder` computes
  `standardsVerbosityFor(kind)` at the same chokepoint that resolves the bodies and passes it
  down, so a reviewer's dispatch never pays for text it would discard — and a brief is always
  produced for the body that actually won the tier merge (the "brief travels WITH its body"
  rule).
- **Scope is the WINNING tier's owner; a built-in is scoped to the ACCOUNT.** A row is bound to a
  tenant exactly like the fragment it condenses, which is what lets the persistence RPC bind it
  with the existing `owner` rule. A `builtin`-tier entry owns no row, so its condensation is
  paid for once per account rather than once per board.
- **Every failure folds the FULL BODY.** No model wired, an unreadable store, a refused or
  over-long condensation — all land on the pre-feature behaviour. A brief is an optimisation of
  how a standard is STATED; nothing here may change what it REQUIRES.

## Status

**Shipped** in one slice. The pieces:

| Layer         | What landed                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| kernel domain | `domain/fragment-brief.ts` — the threshold, the body fingerprint, and `resolveFragmentBrief`'s four outcomes         |
| kernel ports  | `PromptFragmentRecord.brief`, `ResolvedCatalogEntry.briefScope`, `FragmentBriefRepository`, `FragmentBriefGenerator` |
| contracts     | `create`/`updatePromptFragmentSchema` accept `brief` (`''` unlinks); `PromptFragment.brief` doc corrected            |
| agents        | `FragmentBriefService` (resolve + generate + persist), `LlmFragmentBriefGenerator`, `prompts/fragment-brief.ts`      |
| agents        | `mergeCatalog` carries a managed row's `brief` + each entry's `briefScope`; `brief:` frontmatter for repo files      |
| orchestration | `fragmentBriefRepository` / `fragmentBriefGenerator` deps; verbosity threaded from `AgentContextBuilder`             |
| persistence   | D1 `0069_fragment_briefs.sql` ⇄ Drizzle `fragment_briefs` + `prompt_fragments.brief`, both repositories              |
| mothership    | `fragmentBriefRepository` allow-listed `remote` under the `owner` / `ownerField` rules, with refusal tests           |
| conformance   | generate → reuse → regenerate-on-change, the linked brief, and "a full-verbosity kind never condenses"               |
| SPA           | the library editor's short-version field, gated by `showOverrideField` (hidden while unset in basic mode)            |

## Conventions & gotchas

- **The prompt is the safety property.** A brief REPLACES the body for the kinds that write the
  code, so a condensation that drops a rule silently lowers the bar those agents are held to.
  `FRAGMENT_BRIEF_SYSTEM_PROMPT` leads with "keep every obligation, drop only the elaboration"
  and instructs the model to return the text near its original length rather than lose a rule.
  Editing that prompt changes what every implementer is held to — treat it like a versioned
  agent prompt.
- **An over-long generation is REFUSED, never truncated.** A brief cut mid-sentence is a standard
  whose last rule trails off, which is worse than folding the full body — so `cleanBrief` returns
  empty above the cap and the caller degrades.
- **A store-read failure must not read as "nothing generated yet."** It would re-condense every
  oversized standard on every dispatch for as long as the store is down. `loadStored` distinguishes
  the two and folds full bodies on an outage.
- **The generated brief is deliberately NOT on the wire shape.** `entryToFragment` emits only the
  AUTHORED brief: surfacing generated text in the curator's editor would read as something they
  wrote. What the agent actually received is already visible per dispatch in the agent-context
  snapshot (the observability panel), which is the honest place for it.
- **`AgentRunContext.block.resolvedFragments` did not declare `brief`** before this change — the
  built-in's brief reached the composer only through structural typing. It is declared now; a
  resolver that stops supplying it is a typecheck failure rather than a silently fuller prompt.
- **Cost shape.** One small completion per `(fragment, body version)`, on the first implementer
  dispatch that folds it. In the steady state the run path adds at most **two** batched reads (one
  per distinct owner scope) and no model call.
