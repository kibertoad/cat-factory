---
'@cat-factory/acceptance': patch
'@cat-factory/kernel': minor
---

Name the cause when an acceptance prerequisite probe throws, instead of reporting `fetch failed` or
a bare status.

A probe fails in three fundamentally different ways and the gate rendered all of them as the same
sentence, because the catch that turns a thrown probe into an `unknown` verdict read `error.message`.
The verdict is now a discriminated one, so the reader cannot be conflated: nothing about a transport
failure is representable on an answered one.

It never got an answer: on Node a transport failure is a bare `TypeError: fetch failed` with the
informative link (`connect ECONNREFUSED 127.0.0.1:8787`, a DNS miss, an untrusted certificate) one
`.cause` down, so a deployment that was simply not started reported those two words under a remedy
listing three causes it had not distinguished, two of them about a credential a refused connection
never sent. The new `src/probeFailure.ts` classifies the chain through kernel's
`describeConnectionFailure`, the platform's one producer of connection verdicts, and relays its
per-cause remedy rather than paraphrasing it. One class the chain cannot reach is corrected: the SDK
aborts its own deadline with a marker NAMED `AbortError` (that is how the transport tells its
deadline from a caller's cancellation), so a hung or firewalled deployment classified as `aborted`
and was told to run the test again instead of being pointed at dropped packets. Kernel gains
`connectionFailureHint`, the same per-cause sentence for a cause the caller classified, so the fix is
a relay and not a second copy.

It got an answer and the answer was a refusal: the SDK throws a typed `CatFactoryApiError` carrying
the status, the machine-readable `code` and the `X-Request-Id`, and reading it as `error.message`
threw all three away. A prerequisite driving an operation the running deployment is too OLD to serve
reported `the check threw: 404 unknown: HTTP 404`, whose fix nothing in the message pointed at. An
envelope-less 404 is now read as an unmatched route (a deployment behind the suite, or a base URL
naming the SPA, which answers the same shape), separately from a `not_found` that names a real
resource, and the request id travels with every refusal. The two unauthenticated ROOT reads answer
here too: `DeploymentApi` throws a typed `DeploymentAnswerError` carrying the status, where a plain
`Error` fell through to the unclassified branch and reported "no HTTP status came back, so suspect the
check itself" one line under a detail quoting the 404. Their remedy is its own, because neither route
takes a credential: what a status narrows there is which LAYER answered.

Something answered and it was not the deployment: a 2xx whose body is not the JSON the route
documents is neither a refusal nor a transport fault, and it is the only answered failure that
reopens the address. The SPA (which serves a `/health` of its own), a login portal and an intercepting
gateway all land here, from either surface: the root reads, and the SDK's `CatFactoryDecodeError`.

Three smaller corrections of the same kind. Every remedy states how to RESUME rather than claiming a
re-run starts clean, since the gate runs in every spec's `beforeAll` and a resumed pass reaches it
with services adopted. A step promising "the command below" or "the request id below" is emitted only
when that line is. And the base URL is scrubbed and shell-quoted wherever a remedy prints it, because
userinfo is legal in one and no URL policy rejects it.

`issue-credential` is the one prerequisite whose calls leave the deployment, so it now describes its
provider-facing failures where it makes them (through the same kernel describer, with the provider's
own address named) and its body read no longer escapes the check; the runner's single probe context
cannot be true for two hosts. `configure`, the journal and the deployment root reads share one
`describeThrown` for the whole chain plus the one fallback for a chain that said nothing.
