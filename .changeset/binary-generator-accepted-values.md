---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
---

Let a generative binary integration declare WHICH values it accepts, not only that it accepts the option.

A capability is a yes/no, and for several real endpoints the honest answer is "yes, at one of these".
Two image APIs both declare `aspect-ratio`: one honours any ratio because it takes a width and a
height, the other offers a picklist of ten. A step asking for `7:3` is admitted against both and
served by one. Nothing reports the crop, because the modality is covered, the format is covered and
the upload succeeded. That is the silent wrong artifact the capability axis exists to prevent,
arriving through the capability axis, and no wording of a yes/no repairs it.

So a definition may also declare `accepts`: the closed SETS of values it takes, for the three options
with an enumerable domain (`aspectRatios`, `outputSizes`, `upscaleFactors`). Admission refuses a
value nothing selected accepts, naming what they do accept; the pipeline builder raises the same
refusal where the fix is a visible field; and each integration's accepted sets are stated in the
agent's brief beside its formats, since an agent holding two image APIs chooses per artifact.

**FOUR outcomes, judged over the integrations that declare the gating capability.** Nobody stating a
set is SILENT, which is the one that let this ship: it is the state every registration is in until
someone audits an endpoint, and an advisory firing there would ride nearly every step carrying an
aspect ratio. A stated set containing the value is covered; a value on no stated set with some
declarer silent is UNVERIFIABLE and reported; a value every declarer enumerated away is refused.

**`exact-size` changes meaning, and this is the part to look at.** It used to mean ARBITRARY
dimensions, which forced an endpoint whose `size` parameter offers a closed list of `WxH` values to
declare `aspect-ratio` instead: a size-taking API classified as shape-taking, with a step needing
96x96 admitted against one whose nearest listed value is 1024x1024. The capability now answers what
the REQUEST CARRIES (a shape on `aspect-ratio`, dimensions on `exact-size`, both when both) and
`accepts.outputSizes` answers which ones. Capabilities are deployment code and are never persisted,
so no data migrates and no registration breaks: a definition that declared `aspect-ratio` for its
size list keeps working unchanged and gains a more honest option.

What deliberately did NOT ship, because each is the failure this axis is about wearing a new costume.
A range (`min`/`max`/`step`/`multiple-of`) is a constraint language, and the first thing it would
have to express is "any pair up to 4 MP in multiples of 32", which is the `resolutionRange`
discriminator the design record refuses; an endpoint with a genuine range declares the capability,
states no set, and puts its limits in `guidance`. A "closest supported value" rule would turn the
refusal back into a silent substitution. And an endpoint with no parameter at all still declares
nothing: `upscale: [2]` for an upscaler that enlarges at its own fixed ratio is not a narrower
statement of the truth, it is a fabricated one.

An empty list is refused at registration, so absent stays the one spelling of "not stated". A
mothership-mode node absorbs a reply with no `accepts` (an older mothership serves none, and every
option is then judged exactly as it was before this field existed), checking only that a present one
is an object, which is the same tolerance the capability axis gets and the opposite of the credential
list's refusal.
