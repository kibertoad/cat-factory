# Initiative: a delivery surface shaped like the job

**Status:** in progress, slice 1 in review · **Owner:** frontend · **Started:** 2026-10-11 ·
**Decision:** [#2258](https://github.com/kibertoad/cat-factory/issues/2258)

> Durable source of truth for a multi-PR initiative. Read it first before picking up the next
> slice; update the checklist at the end of each PR.

## Goal and rationale

New users call the SPA overwhelming. A UX assessment against the jobs people hire it for (hand off
work, see what needs me, trust and merge, get the platform to green, tune agents), and against
Devin, Copilot coding agent, Codex, Jules, Cursor and Factory, found that the problem is not the
number of features. It is that the working surface shows how the engine works, and the user's jobs
are spread thin across it:

- The home is a canvas at about 34% zoom. "What needs me?" is answered in four places (a lane per
  frame, a toolbar counter, the bell, card badges), each counting a different subset.
- Creating one task asks 12 decisions and shows 10 task types. Every benchmark asks for a sentence
  and a repository.
- The first minute shows setup banners, two AI-provider dialogs, three health advisories, a role
  question and a tour offer before the board.
- The inbox's only verb on a parked decision is "Mark read", while its title already opens the
  decision.

The full report, its method and the wireframes are on branch `ux-assessment`
(`docs/initiatives/ux-jtbd-assessment.md`). The pieces of a job-shaped product already exist (the
lane model, the outcome summary, the assistant, the basic tier); the initiative makes them primary.

**The decision (#2258):** the queue is the default entry point and the board stays as a view. They
are two views of one board, and each person opens on the view they used last.

## Target pattern

The pilot is slice 1, the queue view. The rules it sets for every later slice:

- **No second model of a task.** The queue reads the same lane verdict the frame swimlanes do,
  through the one classifier both share (`useTaskLaneClassifier`), and only regroups it. A surface
  that classified tasks its own way would let two views disagree about one task.
- **No copied actions.** A card's Start, Resolve and Merge are the board card's
  (`useTaskActions`).
- **Compose existing probes and surfaces; add none.** The setup checklist reads what each banner
  already reads and opens what each banner already opens.
- **Additive, one proposal per PR.** Each slice is something the maintainer can say yes or no to
  on its own; nothing is hidden behind a shared switch.

## Checklist

| #   | Slice                                                                                   | Status       | PR                                                          |
| --- | --------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------- |
| 1   | Queue view beside the board, last-used view remembered, queue for a new person          | 🟡 in review | [#2325](https://github.com/kibertoad/cat-factory/pull/2325) |
| 2   | Inbox cards carry their verb ("Answer", "Review", ...), "Mark read" secondary           | 🟡 in review | [#2341](https://github.com/kibertoad/cat-factory/pull/2341) |
| 3   | Setup checklist: every prerequisite for "a task can run and merge" in one list          | 🟡 in review | [#2342](https://github.com/kibertoad/cat-factory/pull/2342) |
| 4   | Describe new work: one sentence, a service, feature or bug; overrides behind one toggle | 🟡 in review | [#2343](https://github.com/kibertoad/cat-factory/pull/2343) |
| 5   | Decide whether the setup checklist replaces the setup banners and startup dialogs       | ⬜ todo      |                                                             |
| 6   | Decide the role prompt at first launch (two of its three answers map to one surface)    | ⬜ todo      |                                                             |
| 7   | Deep links to a task, so the queue can be shared (needs `global-search-and-deep-links`) | ⬜ todo      |                                                             |
| 8   | One failure block per task view: a one-line cause, one action, details behind a toggle  | ⬜ todo      |                                                             |
| 9   | Vocabulary by surface: outcome words on the delivery surface, engine names elsewhere    | ⬜ todo      |                                                             |
| 10  | Settings grouped by decision, label plus one line, operator settings in one place       | ⬜ todo      |                                                             |

Slice 4 (#2343) is stacked on slice 1 (#2325), because it reuses `useStartPipelineResolver` from
`useTaskActions`. Retarget it to `main` before slice 1's branch is deleted.

## Withdrawn approaches

- **The queue REPLACES the home.** The first prototype of #2325 made the queue the home and moved
  the canvas behind it. Withdrawn: different people do different jobs (someone who reviews all day
  wants the list, someone who plans the next service wants the map), so the two are views and the
  person chooses.
- **A preview switch bundling every change.** The same prototype put the queue, the setup page,
  the intake and the inbox verbs behind one per-browser switch, and switching it on also silenced
  the banners and the first-run prompts. Withdrawn: it made one large yes-or-no out of four
  independent proposals, and none of the four depends on which view is open.

## Gotchas

- **The e2e suite opens on the canvas on purpose.** A person who has not chosen lands on the
  queue, but nearly every spec drives the canvas, so `pinWorkspace` records `view: 'board'`. A
  spec about the queue passes `view: 'queue'` or clears the `workView` cookie.
- **The queue view sits over the canvas, which stays mounted.** It keeps the canvas's camera, and
  it means a `toBeVisible()` on a canvas element passes while the queue covers it; a click on it
  does not.
- **Banners render in the page flow on the queue view** (`BoardTopOverlays` with `in-flow`), so
  they push the columns down instead of covering the queue header; the canvas toolbar does not
  render there.
- **Queue card actions are `soft`, as on the board card.** The queue lists many cards, so a solid
  action on each would put many primaries in one view. `check-frontend-variants.mjs` cannot see
  this: it counts sibling buttons, and a `v-for` counts as one.
- **The queue card does not carry `data-block-id`.** The canvas measures dependency arrows through
  that attribute (`utils/blockRects.ts`) and the e2e `taskCard()` helper selects by it, so a second
  element with it gives the arrows a rect off the canvas and the helper two matches. The queue card
  uses `data-queue-task`.
- **Every tour walks the canvas.** Starting a tour on the queue view switches to the board view,
  which is then the view used last, and Board basics has a step on the two views. A tour about the
  queue itself (answer a decision from it) is a later idea; it would need its own view declared.
- **The toolbar counter counts decisions only**, while the queue's "need you" count also holds
  approvals, failures and parks, so the number changes after the click. Kept on purpose for now:
  the counter names its subset ("1 decision"), and the e2e suite reads it as the "a decision is
  pending" signal. One count for both is an open question for a later slice.
- **The demo backend reports no runner.** On the e2e backend the setup checklist truthfully says
  that no runner is configured, though runs work, because the agents are faked.
