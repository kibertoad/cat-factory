---
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

SDK clients: a request body with no required field is now a parameter you may OMIT, and
`POST /api/v1/notifications/:id/act` carries the reviewer-effort tag.

Fourteen operations have a body whose every field is optional, and until now all four clients
rendered it as a required positional parameter, so a caller with nothing to say still had to type
an empty object. That was also what kept `act` body-less: giving it the app's `reviewEffort` field
would have rewritten `act(id)` as `act(id, body)` in four published clients. Teaching the emitters
an omittable body fixes both at once, and the emitters read "omittable" off the spec (`required: []`
on the body schema) rather than a per-operation list.

`act` now takes `{ "reviewEffort": "none" | "minor" | "major" | null }`, so confirming a merge and
recording what reviewing it cost is ONE headless request rather than two, matching the app's one-tap
confirm-and-tag. A `merge_tag_request` card becomes actionable too, but only when a tag is supplied:
recording one is its entire side-effect, so a bare `act` answers 409 with
`details.reason: "review_effort_required"` instead of resolving the nudge and writing nothing. The
route's other 409 now says `no_automated_action`, so the two causes are told apart by a machine.

**Wire compatibility is unaffected.** `act` mounts `optionalJsonBody`, so an integration that has
been calling it with no body at all keeps working; every client sends `{}` when the argument is
omitted, because the route's validator still requires a body to parse.

**Source compatibility, per language.** TypeScript and Java are unchanged for every existing caller:
the body gets a default, and Java gets a real overload. Two need a mechanical edit:

- **Go** takes an all-optional body by pointer, so `Start(ctx, id, body)` becomes
  `Start(ctx, id, &body)` and `Act(ctx, id)` becomes `Act(ctx, id, nil)`. Both are compile errors,
  not silent changes.
- **Python** makes `timeout` keyword-only on every operation. `act(id, timeout=5)` is unchanged;
  a positional `act(id, 5.0)` is now a `TypeError`. That is the point of the change: leaving it
  positional would have bound `5.0` to the new body and sent the timeout as the payload.
