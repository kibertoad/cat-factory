---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/conformance': minor
'@cat-factory/app': minor
---

Make a linked design something a designer can actually start work from.

Figma has been a document source for a while, and none of it was reachable by the person it exists
for. Connecting meant minting a personal access token by hand. Attaching a design meant finding the
Integrations hub, importing the page there, going back to the board, adding a task, and attaching
it. Nothing on the board or the task form said "start from a design" at all, and every string on
the way through said requirements, RFC or PRD. Expanding a design into board structure was worse
than absent: the planner asks what architecture a document describes, which for a design is a
service per Figma page.

Four things close that.

**OAuth connect.** A source can now declare an `authorization_code` half, and one shared flow runs
it. The provider contributes four constants (two endpoints, a refresh endpoint or null, the scopes)
and nothing else: no fetch, no token parsing, no credential mapping, so the second source to gain
OAuth adds a declaration rather than a second copy of the flow. The credential bag is
platform-owned, which is what keeps the token lifecycle out of every provider — a provider's whole
share of it is noticing an access token in the bag it was handed. Declaring an OAuth half is
deliberately NOT the same as offering one: running it needs an app the deployment registered, so
the source listing answers "what this source supports" and "what this deployment can run" as two
separate fields. Folded into one, a board with no registered Figma app would render a "Connect with
Figma" button that can only 503.

**A start-from-design entry on the board.** A frame-header button, and an offer on any Add-task
description that links a page. Both ask only host-pinned sources, which is the safety property
rather than an optimisation: a host-blind parser claims a shape, so asking Notion about a Figma
link whose file key carries a UUID-shaped run gets a confident yes and stages the design into
Notion's key space. The paste is resolved before anything is created, and a reference the parser
had to WIDEN (Figma's own Copy link emits an unreadable id for any component instance, so the
parser falls back to the whole file) says so on its own line, apart from the ordinary trim: "I
attached this frame" and "I attached the entire design" otherwise render identically, and for a
designer that widening is the defect.

**Target-aware planning.** `plan` now asks one of two questions, with two different answer shapes:
what architecture a document describes, or what work it implies inside a service that already
exists. A targeted response that proposes frames is refused rather than re-read as modules, because
a model proposing services where one exists has made a mistake and re-reading it would launder that
onto the board. This is also what makes the `frameId` spawn safe to offer: flattening a board-wide
plan into a frame discarded the frame titles and types the preview rendered, so the spawn produced
something other than what was approved, while a plan authored for the target carries one frame that
IS the target. Design documents require a target for the reason above.

**Copy and a tour.** Connect copy that names designs, and a `start-from-design` tour in the launch
arc rather than the catalogue-only half, gated on a design source being connected rather than on
permission to connect one — that is the admin's job, and gating on it would withhold the tour from
exactly the persona it is written for.

Two compatibility notes. `DocumentBoardPlan` gains a required `targetFrameId`, and the OAuth
install URL is admin-tier even though it only reads: what it hands back is the first half of a
credential write, completed through a public callback where no tier can be checked.
