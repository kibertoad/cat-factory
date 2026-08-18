---
name: kaizen-sweep
description: Drain a cat-factory deployment's Kaizen backlog into `docs/internal/kaizen-tracker.md` and open the PR. Takes the path to a `.env` holding the deployment's public-API key. Use when asked to sweep, pull or triage Kaizen entries or gradings ("what have the graders been saying", "file the kaizen recommendations", "run a kaizen sweep against ~/.cat-factory.env", "update the kaizen tracker").
---

# Kaizen sweep

After every run, the Kaizen agent grades each completed agent step and says what would have made
the interaction better. Those gradings pile up on the deployment as a backlog nobody reads: the app
shows them one board at a time, newest first, and there has never been anywhere for a
recommendation to LAND. So the same complaint is graded, shown, and forgotten, once per run.

This sweep is the other half of that loop. It pulls the backlog through `/api/v1/kaizen/entries`,
matches every recommendation against what has already been filed, adds what is new to
[`docs/internal/kaizen-tracker.md`](../../../docs/internal/kaizen-tracker.md), and opens the PR.

**It files; it never fixes.** Acting on an item is a separate PR that links back to the item. A
sweep that also edited prompts would be a diff nobody can review: half of it is evidence, half is a
change of behaviour, and the two need different reviewers.

Hold one posture throughout: **a grading is a CLAIM, not a finding.** It was produced by a model
judging one run, days ago, against a prompt version this repo may already have moved past. Your job
is to file claims with their evidence, deduplicated and checked against HEAD, not to adopt them. An
item that says "the grader wants X, and X is already true since v6" is a good item. An item that
files X as work when the tree already does X wastes the next reader's afternoon and teaches them to
skim the tracker.

## What you need

A `.env` (path given by whoever asked; usually outside the repo) holding:

| Variable               | Purpose                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `CAT_FACTORY_BASE_URL` | the deployment's origin, e.g. `https://cat-factory.example.com`                     |
| `CAT_FACTORY_API_KEY`  | a public-API key, `read` scope to sweep, `write` only for the optional closing step |

Same two variables the acceptance suite reads, so an existing `.env` from
`pnpm --filter @cat-factory/acceptance run configure` works as-is.

**The key never leaves the request.** Do not print it, echo the `.env`, paste it into a commit, a
comment, a PR body or the tracker, or copy the file into the repo. If the path given is inside the
repo, check it is gitignored (`git check-ignore -v <path>`) and say so before going on. The scripts
below read it, send it in one header, and drop it.

## 1. Pull the backlog

```bash
node .claude/skills/kaizen-sweep/pull-entries.mjs --env <path/to/.env> --out /tmp/kaizen-sweep.json
```

It resolves the key (`GET /api/v1/me`, which names the workspace and the scope for the sweep log),
follows the keyset cursor to the end, and writes one JSON file. Read its stdout before anything
else: it reports how many entries were read, how many carry recommendations, how many are settled
gradings the grader had nothing to say about, and whether it stopped at the page ceiling.

Three things in that output change what you do:

- **`truncated: true`** means older entries were never read. Re-run with a larger `--max-pages`, or
  finish the sweep and say so in the sweep log's `Truncated` column. Never leave it unstated: a
  partial pull that reads as complete puts "nothing new" in the tracker over a backlog nobody
  reached.
- **`counts.inFlight`** counts gradings still running. They are read and reported, never filed, and
  never enter the ledger; they belong to the next sweep.
- **`counts.oldestUnsettledCreatedAt`** is the ceiling for any future ledger watermark. Carry it
  into the sweep log if it is non-null.

The pull defaults to `acknowledged=false`. If the deployment has been acknowledging entries by hand
and the tracker is behind, pass `--acknowledged all` once and let the ledger do the deduplication.

## 2. Read the tracker before you read a single entry

Open `docs/internal/kaizen-tracker.md` and hold three things from it:

1. **The ledger** (its last section): every entry id already swept. This is an exact, mechanical
   check, and it comes first because it decides most of the pull without any judgement.
2. **The open items and their themes**, so a recurrence attaches to the item that already exists.
3. **The dismissed items**, so a recommendation this repo has already declined is not re-proposed
   with fresh evidence and a straight face.

## 3. Sort what the ledger did not already answer

Drop every entry whose id is in the ledger. For each one that is left, decide which of these it is.
Only the first two become repo items.

| The entry                                                                                          | What it is                                                                                                                    | What to do                                                                           |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `recommendations` non-empty, combo key has no `\|v`/`\|w` suffix                                   | a claim about the prompts and platform this repo ships                                                                        | file it (step 4)                                                                     |
| `status: failed`                                                                                   | a DEPLOYMENT problem: the grader had nothing to judge (prompt recording off) or nothing to judge with (no grader model wired) | one item under **Deployment-level failures** per distinct cause, never one per entry |
| `recommendations` empty, `grade` 4 or 5                                                            | the grader found nothing                                                                                                      | ledger only, counted as "no finding"                                                 |
| `recommendations` empty, `grade` 3 or lower                                                        | read the `summary`: it sometimes names a cause it did not turn into a recommendation                                          | file only if the summary names something concrete; else ledger only                  |
| `comboKey` carries `\|w<N>` or `\|v<id>@<fp>`                                                      | the step ran a WORKSPACE-edited prompt or a deployment-registered variant, so the text graded is not text this repo ships     | **Handed to the workspace**, with the suffix quoted as the reason                    |
| the recommendation is about the task's own inputs (vague description, missing acceptance criteria) | a workspace authoring problem                                                                                                 | **Handed to the workspace**                                                          |
| the recommendation contradicts a rule in `CLAUDE.md` or an ADR                                     | a claim this repo declines                                                                                                    | **Dismissed**, citing the rule or ADR                                                |

The combo-key suffixes are the trap worth reading twice. `agentKind|model|promptVersion` alone is
the shipped prompt; `|w<N>` means a workspace rewrote that kind's prompt and `|v<id>@<fp>` means a
deployment registered a variant (`kaizen.logic.ts`, `comboKeyFor`). Filing either as a repo change
proposes editing text the graded step never ran.

## 4. Match against the tracker before opening anything new

**An item is a THEME, not an entry.** The grader words the same complaint differently every run, so
two recommendations are the same item when they ask for the same change to the same thing, however
differently they say it. When they match, add the entry to that item's evidence, bump the
occurrence count and the window, and add the combo if it is new. Do not open a second item.

When you genuinely cannot tell whether it is the same theme, prefer joining the existing item and
saying what is different in one line. Two items saying the same thing is the failure that stops the
tracker from being a deduplication surface at all, and it is unrecoverable by the next sweep, which
will then match against both.

Open a new item only when nothing here covers it. Number it with the next free `KZ-NNNN`, checking
every section including Dismissed: a number reused across two sweeps breaks every link into the
file.

## 5. Verify each candidate against HEAD

Every item, new or joined, states a **Verdict against HEAD**, and you cannot write one from the
grading alone. Two checks, both cheap:

- **Has the prompt moved?** The entry's `promptVersion` is what ran. The shipping version is in
  `backend/packages/agents/src/agents/kinds/versions.ts` (`PROMPT_VERSIONS`, resolved per kind by
  `promptIdForKind`; a kind with no numbered prompt reports 1). If the number has moved since, read
  the current text before filing: the recommendation is often already addressed, and the honest
  verdict is "already addressed in `build@v6`", filed as history, not as work.
- **Is the combo still being graded?** `combo.verified === true` means the pairing crossed the
  streak threshold and the engine STOPPED grading it. Its recommendations are historical. File them
  only if they still reproduce against HEAD, and say which they are.

State the verdict in the tree's own vocabulary, with the file or rule that settles it. "Still
reproduces" with nothing behind it is not a verdict.

## 6. Write the tracker

Follow the item shape in the comment under `## Open items`. Then:

- Add one row to the **Sweep log**, including the `Truncated` column and the workspace id the pull
  reported. A sweep that filed nothing still gets a row: silence and a gap read identically, and
  only the row says which happened.
- Append **every** entry id read, filed or not, to the ledger's fenced block, replacing `(empty)` on
  the first sweep. In-flight entries do not go in.
- Leave the compaction comment alone unless the ledger has genuinely grown past a few thousand ids,
  and if you compact, obey the watermark ceiling stated there.

### Model-authored text crosses into a rendered surface here

Recommendations and summaries are written by a model, and both the tracker and the PR body are
parsed markdown on a host that auto-links. The same rules kernel's `hostMarkdown` enforces in code
apply to you writing this by hand:

- Neutralise `#123`, `@name` and `!123` inside quoted text (`issue 123`, `name`), and never let a
  closing keyword survive next to an issue reference. `fixes #12` in a PR body CLOSES issue 12 on
  merge, and the sweep would be closing somebody else's work with a model's sentence.
- Collapse raw newlines inside a table cell and balance every code fence you open. An unbalanced
  fence swallows the rest of the section, including the ledger.
- Run quoted text past `redactSecrets`'s job by eye: a recommendation can quote a command line or a
  prompt. Nothing token-shaped goes into the tracker.
- Quote, never sharpen. If a recommendation is vague, file it as vague and say so in the verdict.

## 7. Open the PR

Branch off `main` as `kaizen/sweep-YYYY-MM-DD`, and commit only the tracker plus the changeset:

```bash
git checkout -b kaizen/sweep-$(date +%Y-%m-%d)
# docs-only, so the changeset is empty: CI enforces that one exists.
printf -- '---\n---\n\n<one paragraph: what this sweep found>\n' > .changeset/kaizen-sweep-$(date +%Y-%m-%d).md
node scripts/check-doc-links.mjs && node scripts/check-doc-anchors.mjs
git add docs/internal/kaizen-tracker.md .changeset
git commit -F - <<'EOF'
docs: kaizen sweep <date>

<what was read, what was filed, what was dismissed>
EOF
git push -u origin HEAD
```

Then open the PR (`gh pr create`, or this session's GitHub tooling). The description is a reviewer
briefing, not a restated diff: what the graders are converging on, which items are new versus
recurring, what was dismissed and why, and anything the pull could not read. Name the numbers that
decide whether the sweep is trustworthy (entries read, filed, truncated or not). No em-dashes, per
`CLAUDE.md`.

**No code changes in this PR**, not even an obvious one-line prompt fix an item asks for. It goes in
the PR that closes the item, which is where a reviewer expects to argue about it.

## 8. Optional closing step: acknowledge what was filed

Only when whoever asked for the sweep says so. This WRITES to their deployment, and the tracker
already deduplicates without it.

Write the ids you appended to the ledger in step 6 to a file, one per line, and hand that file to
the script. In-flight entries are not in it, so they stay on the backlog where they belong.

```bash
node .claude/skills/kaizen-sweep/acknowledge-entries.mjs --env <path/to/.env> \
  --ids /tmp/swept-ids.txt --note "swept into docs/internal/kaizen-tracker.md (PR 123)" --dry-run
```

Drop `--dry-run` to write. Order is not negotiable: **file first, acknowledge second.** An entry
acknowledged before the tracker holds it is off the backlog with nothing recording what it said,
and the acknowledgement is what a person six weeks later reads as "somebody dealt with this".

It needs a `write`-scope key; a `read` key gets a 403 naming exactly that. A 409 means a grading
settled after the pull, so that entry belongs to the next sweep. Neither failure invalidates the
tracker: the ledger holds the ids either way, so nothing is filed twice.

## What the sweep is not for

- **Not a run investigation.** A single bad run belongs in
  [`investigate-telemetry`](../investigate-telemetry/SKILL.md), which reads the actual tool-call
  loop. Kaizen grades the interaction; it does not diagnose a failure.
- **Not a prompt benchmark.** Whether a model is better at a role is what
  [`benchmark`](../benchmark/SKILL.md) measures, on a fixed matrix. A grading is one sample with no
  control.
- **Not a place to grade the grader.** If the recommendations themselves are consistently poor, that
  is a finding about `kaizen@vN` and it is filed as an item like any other.
