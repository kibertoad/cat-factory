---
'@cat-factory/app': patch
---

Let the review/reading overlays take the whole screen instead of floating in a 1024px card.

`ResultWindowShell`'s width buckets (`3xl|4xl|5xl`) were transcribed one-for-one from each window's
pre-shell `max-w-*` during the slice-5 conversion, so nothing ever re-examined them against what the
windows actually became. The initiative plan review is the clearest case: it grew a three-column
layout — outline sidebar, the plan as a document, the review rail — and then had to fit all three
inside 1024px, leaving the plan itself about 490px wide while the two thirds of a wide display either
side of the window sat empty.

The bucket vocabulary gains **`full`**: the panel spans the viewport minus the shell's existing
gutter, which is the shape the full-bleed step reader (`AgentStepDetail`) has had all along — so this
is adopting a house pattern rather than inventing a wider modal. It is not the new default. `full` is
for a window whose body lays out in COLUMNS, where the width buys visible layout; a short verdict or a
single column of prose keeps its bucket, because stretching two paragraphs across an ultrawide reads
worse, not better. On that line: the plan review + tracker, requirements review, clarity review,
brainstorm, PR review, tester report and service spec.

**What the extra width may NOT be spent on is line length.** Continuous prose inside a `full` window
carries its own reading measure (`max-w-3xl`, the step reader's, over the same 13px `.reader-prose`
sheet), and the leftover is the document's margins.

The unit that obligation attaches to is the **paragraph, not the section**, which is the distinction
that decides where it lands: "a findings list reads better at the full span" is true of the list and
false of the prose inside each row. So the rows, badge rows, control rows, requirement tables, Gherkin
blocks, log tails and inputs take the span, while a finding's detail, a recorded answer, an
investigator's justification, a group rationale and every summary paragraph take the measure — a
finding card's answer control is STACKED under its question, so nothing in it was ever "beside"
anything, and sizing by section would have kept 200-character lines in exactly the windows this change
widened most.

`ResultWindowShell.logic.spec.ts` pins that: every window's bucket against a table naming its reason,
plus each `full` window held to the measure. The shell cannot enforce an obligation on its own slot
content, and without the guard three `full` windows had already shipped with no measure anywhere in
them.

What `full` costs is click-outside, since the backdrop is then only the shell's gutter. That is the
same trade the full-bleed reader already makes (it has no backdrop close at all), and Escape plus the
header's close button are untouched.

`PrReviewWindow` gains the most: it was still on `3xl`, the narrowest bucket, for a surface listing
per-file findings with paths, line numbers, suggested fixes and investigator justifications.
