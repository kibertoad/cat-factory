---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

Close the review findings on the start-from-design work, two of which made shipped features
unreachable.

**The document-source OAuth callback was default-denied.** `/documents` was not in the session
gate's public allowlist, so Figma's browser redirect was refused before the callback could exchange
its code: a vendor navigation carries no `Authorization` header, so the receiver was not gated but
unreachable, and the whole OAuth connect worked only under `AUTH_DEV_OPEN`. The same omission was
already live for the Linear callback at `/tasks`, which is why the fix is not another string in the
list: the provider-facing receivers are now one exported list beside the workspace controllers, and
a test derives both sides and refuses a mount that is missing from the allowlist. This class of bug
reads correctly at the mount, at the handler, and in review, and shows up only against the live
vendor on a redirect nobody can retry.

**A grant with no stated expiry was treated as expired at the epoch.** `Number('')` is `0`, not
`NaN`, so the guard meant to skip a credential bag that recorded no deadline never fired. Every
resolution of a personal-access-token connection logged a permanent-outage warning, and every
resolution of an OAuth grant whose token response omitted `expires_in` spent a refresh round trip
and a write, on a path that runs for each step of every run.

**A targeted spawn duplicated the modules it was told to reuse.** The targeted planner is shown the
frame's existing module names and asked to reuse them; the write then created a new module per
planned module regardless, so a plan that obeyed the instruction produced a second "Checkout" beside
the first. The reuse is now computed rather than requested, matched case- and whitespace-insensitively
because the thing being asked is a language model. A reused module is reported separately from a
created one: folding them together would claim a write that did not happen, and dropping the count
would report "0 modules" against a preview that showed three.

Also: two stale-response races (the spawn preview's re-plan when the target frame is switched
mid-request, and the pasted-link offer in the task form, where accepting a superseded offer attached
a document no longer named in the description); a blur that swallowed the first click on
**Continue** in the start-from-design modal, because clicking the button re-resolved the link and
disabled the button before mouseup; and the OAuth spec/descriptor pairing a comment claimed was
asserted, which is now actually asserted at registration, in both directions and over the scopes,
since a half-declared source is silently either unreachable or a dead button.
