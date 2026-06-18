---
'@cat-factory/app': patch
---

Board UX: optimistic task start, clearer failure surfacing, and readable agent
work on a task's focus view.

- **Optimistic "Start"** — the task card's Start button flips to a spinning
  "Starting…" state the instant it's clicked, before the server confirms. If the
  start call faults it reverts and shows an error toast; otherwise the run's
  `in_progress` push naturally replaces the button.
- **Failed runs stop pretending to work** — a task whose run has failed now renders
  the shared failure banner + retry (`AgentFailureCard`) instead of a stuck progress
  bar, so a terminated run never looks like it's still running or "awaiting a
  decision".
- **Subtask todo breakdown on zoom** — a running step's per-todo list (status icon,
  struck-through when done) now renders under the subtask count in `PipelineProgress`,
  matching how the bootstrap card shows its subtasks.
- **Readable agent prose** — in a task's focus view, every pipeline agent is listed
  and clicking one (architect, researcher, reviewer, …) expands the full prose it
  produced instead of a three-line teaser.
