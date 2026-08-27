# ADR 0061: The reset a suite cannot get right by copying

- **Status:** Accepted (implemented)
- **Date:** 2026-08-27
- **Context layer:** `@cat-factory/acceptance-kit`, with `backend/internal/acceptance` as its in-repo
  consumer.

## Context

[ADR 0058](./0058-acceptance-kit-consumer-gaps.md) recorded the first report from a deployment
building its own acceptance suite on the published kit. [ADR 0060](./0060-headless-caller-diagnosability.md) recorded
the second. This is the third, one finding rather than thirteen
([issue #2117](https://github.com/kibertoad/cat-factory/issues/2117)), from the same consumer
(`lokalise/cat-factory-wrapper`, `packages/acceptance`) and about the same kind of gap: what they had
to re-derive from reading our source.

The kit shipped every small seam a `reset` command needs and not the reset. `SuiteIdentity.resetCommand`,
`suiteCommand`, `listPasses`, `readLatestPointer`, `latestPointerPath`, `PassOnDisk`, `LatestPointer`,
`scrubbed`, `describeThrown` and `OperatorRefusal` were all exported and all the right shape. The
reasoning layer above them was not: `parseResetArgs`, `planReset`, `applyReset`, `formatResetPlan`,
`formatResetReport`, `resetSucceeded` and the `ResetClient` port lived in the private
`backend/internal/acceptance` package, so a second suite copied roughly 1,360 lines to get a command
whose SHAPE is obvious and whose rules are not.

Verified against HEAD: the finding is exact, and it is version-independent. `reset.ts` has never
existed in the kit under any published version (0.1.0 through 0.5.5), so nothing about it turns on
which release the consumer measured, which is why the missing provenance in the report cost nothing
here.

Four of the rules a copy has to re-make fail QUIETLY when they are made wrong, which is what
separates this from ordinary duplication:

1. **Write order.** The frame delete refuses while an unfinished task sits under it, deliberately, so
   a caller that did not mean to discard work in flight cannot. Those tasks go first. Finished tasks
   must NOT be deleted individually: the frame delete cascades the subtree, and each per-task call
   costs the deployment a whole-board read for work the one frame delete does anyway.
2. **Never orphan a ledger.** A ledger removed while a frame it names is still standing is the exact
   state a reset exists to get an operator OUT of: the frame earns the same refusal on the next
   attempt, with no pass to name in the remedy and the resume id in the file just deleted.
3. **The `latest` pointer.** It goes when it names a pass being removed, and also when it names
   nothing at all: a dangling pointer outlives every ledger in the directory and then resolves a
   `latest` resume onto a state directory holding none, which is a fresh pass wearing a finished
   pass's run id.
4. **Plan, then apply the PLAN.** The preview is the safety property, and `applyReset` consuming the
   plan is what stops the preview and the apply disagreeing about the target.

Plus one disposition: a `404` is an outcome, not a failure. Something else got there first.

## Decision

`planReset` / `applyReset` and everything around them move into the kit
(`packages/acceptance-kit/src/reset.ts`), generic over a suite's own ledger fact type, the way
`LedgerStore` already is. What a suite supplies is three callbacks on `ResetInput` plus the flags it
declares to the parser:

- **`target(services)`**, answering `{ frames, blockers?, notes? }`. The frames it names carry a
  `because` PHRASE rather than a member of a closed reason vocabulary. A `blocker` is something the
  reset cannot free, which is not merely printed: it keeps every pass's files (rule 2, since whatever
  holds it is a frame no read can name) and it makes `resetSucceeded` false. A `note` is what this
  read could not SEE, printed by the plan and again by the report.
- **`ledgerServiceIds(facts)`**, which is what a NAMED pass widens the plan by and what rule 2
  matches a surviving frame against.
- **`leftovers(context)`**, given the planned frames and the passes with their ledger facts still
  attached, because deleting the ledger is what makes those facts unrecoverable.
- **`parseResetArgs(argv, { usage, flags })`**, where `--yes` and `--all` are the kit's (it acts on
  both) and anything else is handed back in a `Set`, un-interpreted.

The kit keeps the ordering, the retention rule, the pointer rule, the `404` disposition and both
formatters. `ResetClient` is four calls, not five: the repository read the platform's own questions
need is a fact about ONE suite, so it happens inside that suite's `target`.

`backend/internal/acceptance/src/reset.ts` goes from 923 lines to 277, all of them its own two
questions, its unfreeable repositories, its unlinked note and its leftovers prose. Its test drops the
machinery assertions and keeps the suite ones; the kit's new test owns the rules.

### Rejected: the reason vocabulary as a closed union

The report's proposed shape was close to what shipped, and the one place it was taken further is the
reasons. `FrameReason` was `backs-repo` / `holds-title` / `named-by-pass` / `whole-board`, and two of
those four are this suite's questions rather than any suite's: the wrapper asks about one repository
and one title, a third suite will ask about something else. Kept closed, a second consumer either
gets its reasons rendered as somebody else's vocabulary or the union grows a member per deployment.
So the kit keeps the two reasons it OWNS (`named-by-pass` from a named ledger, `whole-board` from its
own `--all`) and takes the rest as a phrase it prints after `because it `. That preserves the
platform suite's output byte for byte and costs the kit nothing it could have checked.

### Rejected: a turnkey `reset` command

The report did not ask for one and was right not to. Which questions name a frame, what else a pass
leaves behind and the leftovers prose are all per suite, and two of the three are the part an operator
takes most on trust. A command that guessed them would print a paragraph about repositories to a
deployment whose leftovers are Kargo PREnvs.

## Rationale

**This is the same shape as ADR 0058's headline finding, one layer up.** There the kit shipped a
description cap it did not apply; here it shipped every seam a reset needs and not the judgement
between them. In both cases what the consumer re-derived was the part that fails silently, and in
both cases the platform's own suite was the only thing exercising it, so nothing would have caught a
second implementation getting rule 2 backwards.

**A blocker's explanatory clause moved into its steps, and nothing was lost.** The platform's
retention sentence carried a parenthetical about an archived frame and one homed on another board
answering identically. That is a fact about `GET /api/v1/repos`, not about resets, and
`blockedRepoMessage` already states it in full in the steps printed under the blocker in the same
output. The kit's generic sentence names the rule; the suite's steps name the cause.

**The kit gains a module whose only in-repo consumer is the suite that gave it up**, which is the
ordinary case rather than ADR 0058's `resource.ts` problem: this code has been running against real
deployments, and the platform's suite still drives every line of it.

## Consequences

- `@cat-factory/acceptance-kit` gains a `@cat-factory/sdk` dependency it already had, and its
  published surface grows by one module. Additive: nothing exported before changed shape.
- An internal break for the one consumer outside this repo: the wrapper suite deletes its copy and
  supplies three callbacks instead. Internals are pre-1.0, so there is no shim and no dual path; the
  changeset names it and the disposition list on the issue names the version.
- `planReset` now reads `services` before a suite's own reads rather than in parallel with them,
  because the suite's targeting is handed the services list so two reads of it cannot disagree. One
  serialized round trip on a cleanup command, which is the right side of that trade.
- A suite that answers no leftovers gets a sentence saying so rather than an empty section. An empty
  section reads exactly like a reset that reclaimed everything, which is the one reading the
  paragraph exists to prevent.
