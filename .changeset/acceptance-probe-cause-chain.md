---
'@cat-factory/acceptance': patch
---

Name the cause when an acceptance prerequisite probe throws, instead of reporting `fetch failed`.

Every check in the gate reaches the deployment over HTTP, where a transport failure is a bare
`TypeError: fetch failed` and the informative link (`connect ECONNREFUSED 127.0.0.1:8787`, a DNS
miss, an untrusted certificate) hangs off `.cause`. The catch that turns a thrown probe into an
`unknown` verdict read `error.message`, so all of those rendered as the same two words under a remedy
listing the three causes it had not distinguished, two of them about a credential that a refused
connection never sent.

The new `src/probeFailure.ts` classifies the chain through kernel's `describeConnectionFailure`, the
platform's one producer of connection verdicts, and relays its per-cause remedy rather than
paraphrasing it. The credential guesses stay for the `unknown` class, where the throw is as likely to
be a request that WAS answered and then refused. `DeploymentApi` now names the failing request while
keeping the thrown value as the `cause` so the classification still reaches it, and `configure`, the
journal and the deployment root reads read the chain through kernel's `getErrorMessage`.

`runPreflight`'s third parameter is now an options object (`{ probe, onResult }`), carrying what the
probes reach so a remedy can name the address.
