---
'@cat-factory/agents': patch
'@cat-factory/kernel': patch
'@cat-factory/sandbox': patch
'@cat-factory/conformance': patch
'@cat-factory/executor-harness': patch
'@cat-factory/app': patch
---

Render a review verdict as blocks a human can skim, and ask the reviewer to write it that way.

A companion's verdict (the architect/spec/code/doc reviewers) arrives as ONE string: `comments`
only exist where the graded output has ids to anchor to, so everything the reviewer found lands in
`summary`. Unshaped, a model writes that as a single dense paragraph numbering its points inline
("(1) … (2) …"), and the run panel then appended it to the score inside the same line
(`78% < 80% — <four hundred words>`). Nothing about that is skimmable: a reader cannot tell what
blocks the work from what is a nit without reading all of it.

Both halves move. `REVIEW_SUMMARY_LAYOUT` (agents, `prompts/shared.ts`) asks for a fixed skeleton,
a one-line verdict then `**Must fix**` / `**Should fix**` / `**Minor**` bullet groups, and is
carried by every companion (built-in and deployment-registered, since they share one prompt). It
survives a per-workspace prompt override, like the other fragments that describe how the platform
reads a reply rather than what it should look for. A reviewer that already reports structured
findings beside its summary is deliberately excluded: every judge, the `pr-reviewer` and the tester
have that array rendered as its own list, so the layout would make them write each point twice.
The SPA renders those summaries through the existing `MarkdownProse` reader instead of plain-text
dumps, and each companion round is now its own card rather than a continuation of the score line.
The same render fix reaches the reviewer prose the first markdown sweep missed: judge summary and
findings, best-practice adherence, the PR-review summary, findings and challenge verdicts, and the
tester report. It stops at the fields carrying a VALUE a human copies rather than prose (a
suggested fix, a gate's failure summary), which stay preformatted: markdown would emphasise the
`__dunder__` in a path and curl the quotes in a command.

Kernel's `extractJson` now repairs raw control characters inside a JSON string literal. A
multi-line summary is exactly what makes a model forget the `\n` escape, and refusing that reply
costs the whole verdict (a companion that returns nothing parseable fails the run) over a quoting
slip. The repair is a SECOND pass, run only once every candidate in the reply has been read as
written: a repair makes text parse that was meant to be skipped, so tried inline it would let an
example shape or a prose aside shadow the real verdict written after it. Fence bodies are now all
searched, not just the first. The harness's own reader gained the same repair (hence a runner image
bump), because it reads the reply FIRST and each refusal there costs a billed repair completion
before the engine ever sees it.

The judge prompt bumps to `judge@v2`: its summary is now rendered beside its findings, so it is
asked for a short whole-verdict paragraph that does not restate them. Scoring is untouched. A
companion kind also stops resolving to the `review` phase's prompt version — a companion runs the
companion prompt, so both the editor's baseline label and the sandbox baseline named a revision of
text the kind never sends.
