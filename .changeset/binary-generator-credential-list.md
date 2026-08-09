---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
---

Let a generative binary integration declare SEVERAL credentials, for the vendors whose account is not one string.

`BinaryGeneratorDefinition.credential` becomes `credentials`, a list. The shape that broke the single
field is HTTP Basic over a key/secret pair (Scenario, and a long tail of REST APIs that authenticate
the same way): the only way to declare it was to colon-join the two halves into one variable, which
rotates them together, offers the operator one credential-checklist row where their vendor console
issues two values, and turns a mis-joined value into a 401 indistinguishable from a wrong key.

Nothing about the model changed to allow this, which is the argument for it. Every other layer the
value travels through was already plural: the kernel `ToolSecretResolver` port takes `keys`, a tool
server declares `credentials`, the checklist keys its rows by `(subject, id, key)`, and the job body
carries pairs. The single field was the one singular link in that chain.

**A deployment registering an integration must rename `credential: {…}` to `credentials: [{…}]`.**
Definitions are code, so the break arrives as a typecheck failure at the composition root rather than
as a run that quietly authenticates with nothing.

Two rules ship with it. Injection names must be distinct within a definition, refused at boot and
compared case-folded (the fold the reserved-key floor already applies, since two spellings are one
variable wherever the environment ignores case), because the job body is keyed by the variable each
value arrives as and a collision would silently deliver one value and drop the other. And the brief NAMES a multi-credential set before its parts, so
an agent handed two paragraphs does not read them as two independent keys and try the first alone.
That set line states its joint rule over the REQUIRED members only: "never call it with a subset of
them" is right for a Basic pair and contradicts an optional member's own line, which says to call
anyway when that one is missing.

Across DEFINITIONS the same injection name is refused only where the lookup key behind it differs.
Two integrations on one vendor account legitimately share a variable, since both resolve the same
value; two that mean different values by it have no right arbitration, because serving the first sets
the variable the second integration's brief tells the agent to read. Boot refuses that
(`binary_generator_injection_name_collision`), and dispatch, which a mothership node reaches with
definitions it never boot-validated, withholds the value from every claimant instead of picking one.

There is deliberately no auth-scheme field and no platform-side header assembly: the agent writes the
request, each credential's `usage` is where it is told how that value is presented, and a scheme enum
would need a new member for the first vendor with a signed request or a rotating timestamp.

A mothership-mode node REFUSES a generator reply that carries no `credentials`, where the sibling
capability axis absorbs the same absence. The asymmetry is deliberate: an empty capability
declaration is a documented reading ("only the coarse facts are known"), while an empty credential
list reads as "this integration is unauthenticated" and the brief would tell the agent exactly that
about a deployment that configured a key. So a node needs a mothership new enough to serve the plural
field and fails loudly against one that is not, rather than reporting a 401 against an integration
nobody gave credentials to.

Also states, in the capability vocabulary itself, the rule a closed-enumeration endpoint kept turning
into a judgement call: a capability says the request can CARRY a value, never which values are
accepted. An endpoint offering a closed list of exact `WxH` sizes is handed pixel dimensions and
still rounds, so it declares `aspect-ratio` (whose meaning already covers a set it rounds to) and not
`exact-size`, whose test is whether an ARBITRARY pair can be asked for. Where no coarser member
exists, an endpoint that accepts an option only at values it fixes declares nothing and says what it
does in `guidance`: declaring the accepted values instead would be the stale per-integration table
the design record refuses, and for an upscaler with no factor to enumerate it would be a fabricated
one, admitting a step that asked for 4x and serving it an enlargement at an unknown multiple.
