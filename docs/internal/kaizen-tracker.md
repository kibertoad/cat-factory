# Kaizen tracker

**What the platform's own graders have said about the agents this repo ships, filed once.**

After every run, the Kaizen agent grades each completed agent step on how smooth or chaotic the
interaction was and says what would have made it better, keyed by the `(agentKind, model,
promptVersion)` combo the step ran on. Those gradings live on a deployment as a backlog
(`GET /api/v1/kaizen/entries`, [public-api.md](../../backend/docs/public-api.md#kaizen-entries-apiv1kaizenentries)).
This file is where the ones worth acting on land, so a recommendation the grader made in July is
still findable in October and is not re-litigated every time it recurs.

Produced by the [`kaizen-sweep`](../../.claude/skills/kaizen-sweep/SKILL.md) skill, which pulls the
backlog, matches each recommendation against what is already here, and opens the PR that adds what
is new. **The sweep files; it never fixes.** Acting on an item is its own PR, and the item is where
that PR links from.

## How to read this

An item is a THEME, not an entry. The grader files near-identical recommendations across many runs,
so one item collects every entry that says the same thing and counts them: recurrence is the signal
that separates a one-run irritation from something the agents keep hitting.

Each item carries:

- **Status**: `open` (nobody has acted), `in progress` (a PR is up, linked), `done` (landed, with
  the PR), `dismissed` (with the reason, which is the part worth writing).
- **Combos**: the `agentKind | model | prompt@vN` pairings the entries came from. A theme that only
  ever appears under one model is a model-selection finding; the same theme across four is a prompt
  or platform finding.
- **Occurrences**: how many entries say it, and the window they span.
- **What the grader says**: the recommendations, quoted, with the auto-linking characters
  neutralised (see the writing rules in the skill). Never paraphrased into something stronger than
  what was said.
- **Verdict against HEAD**: what is true in the tree TODAY. A grading describes a run that already
  happened, on a prompt version this repo may since have moved past, so every item states whether
  it still reproduces. This is the field that decides whether an item is work or history.
- **Evidence**: the entry ids, and one `runId` to start from.

Three sections below hold items that are not repo work, and they exist so those entries are
answered rather than silently skipped:

- **Handed to the workspace** is for recommendations about a deployment's own configuration or a
  task's authored inputs. Nothing in this repo changes for them.
- **Deployment-level failures** is for `failed` gradings, which name a deployment problem (prompt
  recording off, no grader model wired) rather than a run problem. One item per distinct cause, not
  one per entry.
- **Dismissed** is for recommendations this repo declines, each with the rule or design record it
  contradicts. A dismissal is what stops the next sweep from re-proposing it.

## Sweep log

One row per sweep, so a gap in the record is visible as a gap rather than as silence. `Read` counts
every entry the pull returned, `filed` the ones that became or joined an item, and `no finding`
the settled entries the grader had nothing to say about, which are real and are why the ledger
exists.

| Sweep        | Deployment / workspace | Read | Filed | No finding | Truncated | Notes |
| ------------ | ---------------------- | ---- | ----- | ---------- | --------- | ----- |
| _(none yet)_ |                        |      |       |            |           |       |

## Open items

_None yet. The first sweep fills this in._

<!-- Item shape, kept here so every sweep writes the same one:

### KZ-0001: <one line naming the change, not the symptom>

- **Status**: open
- **Combos**: `coder | anthropic:claude-... | build@v6`
- **Occurrences**: 4 entries, 2026-08-02 to 2026-08-17
- **What the grader says**: "<quoted recommendation>" (and 3 more saying the same)
- **Verdict against HEAD**: still reproduces; `build@v6` is the shipping version and says nothing
  about <the thing>.
- **Evidence**: entries `kz_...`, `kz_...`; run `exec_...`
-->

## Handed to the workspace

_None yet._

## Deployment-level failures

_None yet._

## Dismissed

_None yet._

## Swept entry ledger

**The authoritative dedupe key.** Every entry id the sweep has READ is here, including the ones
that produced no finding, and an id in this list is never filed again. It has to hold the
no-finding entries too: without them, an entry the grader had nothing to say about would be
re-read, re-judged and re-argued on every sweep, and "we looked and there was nothing" would be
indistinguishable from "we never looked".

The ledger, not the sweep dates, is what makes a sweep incremental. Acknowledging entries on the
deployment (the sweep's optional closing step) shrinks the backlog the pull returns, but it is not
what prevents duplicates here: a tracker whose repo is restored from an older commit, or a
deployment whose acknowledgements were cleared, still dedupes correctly off this list.

**Watermark**: none. Nothing has been swept yet.

<!-- Compaction, for when this list grows past a few thousand ids:

Replace the ids created at or before a stamp with `**Watermark**: <ISO> (<epoch ms>), <n> entries
swept`, and pass `--since <epoch ms>` on the next pull. The stamp may only be a value strictly
BELOW the oldest entry any sweep has seen still being graded (`counts.oldestUnsettledCreatedAt` in
the pull's output), because an entry that was in flight when a sweep ran settles later while
keeping its original `createdAt`: a watermark above it would hide it forever. When no sweep has
seen an unsettled entry, the ceiling is the oldest `createdAt` in the current pull. -->

```text
(empty)
```
