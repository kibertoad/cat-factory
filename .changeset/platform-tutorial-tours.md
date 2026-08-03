---
'@cat-factory/app': minor
---

Add four tutorial tours for the platform behind the delivery loop, and keep the launch prompt to the first-run arc.

The shipped catalog walked the delivery loop end to end and stopped there, so nothing in the product explains the machinery a board runs ON: `wire-models` (the engine every pipeline step calls, without which nothing runs at all), `design-pipeline` (that the sequence of agents is yours to assemble, not a fixed catalog), `agent-standards` (context fragments as the way to steer output instead of restating conventions in every task), and `connect-systems` (what a tracker, a document source, chat or monitors each add to a run).

Each covers ONE surface and ends there, because these surfaces open as modals over the sidebar entry that opened them, so a later step could not reach another entry anyway. Each declares exactly the permission that renders the control it clicks (`integrations-manage` / `settings-manage` / `library` join the shared requirement table), since a weaker requirement offers a tour to someone with no such control and it then reports itself abridged. Five surfaces gained the `data-testid` anchors they point at: the pipeline builder's palette, draft column and Save, the fragment library, and the integrations hub — behaviour-neutral, and named the same way `model-providers-hub` already was.

A tour may now be catalogue-only (`TutorialTour.offeredAtLaunch: false`, read through the pure `isLaunchOffer`; `useTutorialTours` exposes `offered` for the launch prompt beside `tours` for the overlay). These four gate on a permission rather than on board state, so all of them are startable on a brand-new board, and offered unfiltered they turn a two-item first-run question into a six-item list that buries the two tours a new user can act on. The default is offered, so a deployment's own tour still appears beside the built-ins and nothing can fall out of the prompt by omission; the flag thins the OFFER only — an un-offered tour is listed, counted and startable in the catalogue, one footer button away.
