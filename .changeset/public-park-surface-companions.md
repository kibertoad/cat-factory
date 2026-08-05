---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
---

Follow-up triage and interview-gate decisions over the public API

`/api/v1` answered every park a pipeline can carry except three. Two of those were surfaces nobody
had built (`docs/initiatives/public-api-additions.md` found them while landing the rest, and left
them unranked); this lands both, leaving `human-review` as the only ❌ row, and that one is
unanswerable by construction, since its answer is a person approving the pull request on the VCS
host rather than an API call.

**Follow-up triage** (`…/decisions/follow-ups/items/:itemId/{file,send-back,answer,dismiss}`) is the
first decision here that is not a park: the Coder streams forward-looking items while it is still
running, so the projection lists them whenever any item is `pending` rather than once the run is
`blocked`. An integration that triages as they arrive never sees the run stop at all.

**Interview gates** (`…/decisions/interview/{answer,continue,proceed}`) are ONE route set for every
interviewer, keyed by run alone: which interviewer is asking is a property of the parked step, so
the server resolves it and the decision's `stepKind` reports it. That needed a new seam: the two
built-in gates store their Q&A on entities belonging to their own features, so `InterviewGateKind`
now projects a kind-neutral `InterviewView` (the questions and the round budget, deliberately not
the brief each one converges on), reached through the narrow `InterviewGate` interface rather than
the entity-generic controller. A third interviewer implements `view` and needs no route, projection
or decision kind of its own; it does still wire its controller, since an interview gate is built
from its feature's own store rather than constructed by a registry. Registered-but-unwired is a
real state and reports as one: admission counts the park (it reads the trait), the projection lists
nothing, and the routes 503 naming the kind. Its question `status` is derived, not stored: one gate
keeps an explicit `dismissed` marker and the other has only the answer, so one derivation is what
lets a caller read both through one shape.

Worth reviewing, because it is a behaviour change rather than an addition: **an interview gate is now
a park surface the start rule can see**, read off the step kind's `interview-gate` trait. That closes
a hole in the wrong direction: an interviewer is an INLINE step, so a pipeline built out of
interview steps satisfied the inline-only rule and was reported `headlessStartable` while every run
of it stopped on the first batch of questions. No shipped preset changes hands (`pl_initiative` and
`pl_document` both carry a later human gate and were already admitted as parking on it); what
changes is that the refusal names the interview, and that a pipeline whose only park is the
interview is finally refused for a `write` key.

**Follow-up triage is deliberately NOT added to that rule**, and the trade-off is stated in
`backend/docs/public-api.md` rather than left to be discovered: the companion is on by default on
every Coder step, so counting it would make `decide` mandatory for all board work that builds
anything and take board starts away from every live `write` key at once. The park now has an answer
path, so a run that stops there is recoverable with a `decide` key instead of being app-only.

Also noted rather than fixed, in the same three places a reader would look: an unbounded human-wait
GATE a deployment registers itself is invisible to the start rule, because a gate declares
`pollExhaustion` on the object its factory builds from an engine context and nothing can read that
at HTTP request time. Such a pipeline is admitted for a `write` key and then parks with nothing on
this surface able to name it. The tracker ranks the fix (declare `pollExhaustion` at registration
and read the registry, which also retires the hand-kept `HUMAN_WAIT_GATE_KINDS` constant) as its own
slice, since it changes the `GateRegistry` seam.

Public API surface version `1.10.0`, additive: two new decision kinds (`follow-ups`, `interview`) and
seven endpoints, all `decide`-scoped.
