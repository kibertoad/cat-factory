---
'@cat-factory/acceptance': patch
---

Name the cause when an acceptance prerequisite probe throws, instead of reporting `fetch failed` or
a bare status.

A probe fails in two fundamentally different ways and the gate rendered both as the same sentence,
because the catch that turns a thrown probe into an `unknown` verdict read `error.message`.

It never got an answer: on Node a transport failure is a bare `TypeError: fetch failed` with the
informative link (`connect ECONNREFUSED 127.0.0.1:8787`, a DNS miss, an untrusted certificate) one
`.cause` down, so a deployment that was simply not started reported those two words under a remedy
listing three causes it had not distinguished, two of them about a credential a refused connection
never sent. The new `src/probeFailure.ts` classifies the chain through kernel's
`describeConnectionFailure`, the platform's one producer of connection verdicts, and relays its
per-cause remedy rather than paraphrasing it.

It got an answer and the answer was a refusal: the SDK throws a typed `CatFactoryApiError` carrying
the status, the machine-readable `code` and the `X-Request-Id`, and reading it as `error.message`
threw all three away. A prerequisite driving an operation the running deployment is too OLD to serve
reported `the check threw: 404 unknown: HTTP 404`, whose fix nothing in the message pointed at. An
envelope-less 404 is now read as an unmatched route (a deployment behind the suite, or a base URL
naming the SPA, which answers the same shape), separately from a `not_found` that names a real
resource, and the request id travels with every refusal.

`DeploymentApi` names the failing request while keeping the thrown value as the `cause` so the
classification still reaches it. `configure`, the journal and the deployment root reads read the chain
through kernel's `getErrorMessage`. `runPreflight`'s third parameter is now an options object
(`{ probe, onResult }`), carrying what the probes reach so a remedy can name the address.
