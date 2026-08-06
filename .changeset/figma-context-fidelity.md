---
'@cat-factory/integrations': minor
---

A linked design now reaches the agent as a design, not as a list of frame names

Four fidelity holes made the Figma context file thinner than the design it described, and the
worst of them was silent.

A whole-file link fetched `/files/:key?depth=2`, which returns the pages and their top-level frames
with NO children. The renderer builds each frame's layout from those children, so a whole-file
import degenerated to frame names and sizes: no layout, no text, nothing an implementer could
build from. Only a node link (one frame) ever produced real content. The file endpoint cannot fix
this by asking for more depth, because it jumps from "no children" straight to "the entire
document", which blows the response cap on any real file. So the `depth=2` read became an OUTLINE
read and the frames it names are fetched as subtrees, chunked so an oversize response costs its own
frames rather than every frame. A frame whose chunk fails still renders from the outline, and both
the frame cap and the failed reads are named in a new `### Notes` section: a bounded import must
not read as the whole design. The per-frame node cap now sits under an import-wide budget, because
a per-frame cap alone bounds nothing about an import that fans out over a dozen frames.

Each cap gets its OWN note, because they are not interchangeable. A DEPTH cut is local to one
branch and the walk must carry on; a node or text budget is exhaustion and must stop. Conflating
the two is what made a branch nested past the cap drop every later sibling of every ancestor, so a
frame whose first branch was deep rendered as that branch alone (auto-layout nests past six levels
routinely, so this hit ordinary frames). The caps also ask the reader for different things: link a
sub-frame, or import fewer frames. A depth cut now names how many nodes it left below, so it cannot
read as a leaf, and one cut leaves ONE marker instead of one per unwinding ancestor.

Text caps are stated too, in the section as well as the notes. The renderer DROPS an empty section,
so a frame whose text the import budget refused was byte-for-byte a frame that contains no text:
the exact silence the rest of this change exists to break. Components and tokens are bounded as
well, since both grow with the design SYSTEM rather than with the frames imported and the layout
budget says nothing about them. The component cap ranks by instance count, computed from what was
observed, so what survives is what the design leans on; the token cap sorts by the rendered order
first, so "N not listed" points at the tail the reader can actually see is missing.

The layout tree carried name, type and size only, so every colour, type ramp, radius and stack
direction was left for the model to invent. Each node's line now carries those facts in brackets,
bounded by the tree's own caps because they are the same lines.

Tokens came only from the variables API, which is Enterprise-gated. On every other plan the 403 was
swallowed and the section simply vanished, which reads exactly like a design that defines no
tokens. The published styles the file already ships (the `styles` map joined to the fills and text
styles of the nodes referencing them) are now the fallback, and `DesignContext.tokenOrigin` states
which source produced the section. The two are never merged: a merged section could not say where a
value came from, and the plan gate itself is now stated even when neither source produced anything.
Zeplin's own best-effort token read reports its failures the same way, for the same reason.

Components were a bare list of names. An instance is now named by its component SET, since a
variant's own component name is its property assignment ("Size=Large") and identifies nothing on
its own, and every variant and property the design uses folds onto that component's note. That is
the signal "reuse the existing component" needs to match against repo code.

Zeplin's screens read asks for one more screen than it renders, so that a project with more screens
than we import is detectable at all: asking for exactly the render cap makes a full page and a
truncated one identical, which silently dropped the cap note in the one case it exists for.

Watch the corpus budget when reviewing: richer renders mean larger bodies, and linked-context
delivery is load-bearing (`context_documents_over_budget`). The cap constants carry the arithmetic
that sizes them against it, so raising one means redoing that arithmetic rather than picking a
bigger number. Every cap states what it dropped rather than shortening in silence.
