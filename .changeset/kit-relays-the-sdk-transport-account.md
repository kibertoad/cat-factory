---
'@cat-factory/acceptance-kit': minor
'@cat-factory/kernel': minor
---

Read the SDK's composed transport account once, and split it between the two readers of a failed
poll. The published clients now assemble a connection failure's message from a verdict, the origin
history only that client holds, and the runtime's chain verbatim, so walking the chain again under it
printed the errno twice, and a 200-character observation of it cut the chain off entirely: against a
deployment URL of any real length an expiry that used to end in `connect ECONNREFUSED 203.0.113.42:443`
named neither the errno nor the host. A prerequisite refusal now relays the account whole,
`transportChainText` gives a per-poll observation the runtime's chain alone, and both are pinned by
fixtures driven through a real client rather than written by hand.

`fileAndDrive` also names what a create that never completed left behind: a failure no origin
accepted created nothing, while a reset, a timeout or an unreadable answer may have filed a task no
ledger can name, and those need opposite actions from an operator before the next pass runs.

The create-side classification is bounded by what the REQUEST was rather than by what the callback
threw, which is two narrowings. Only a failure the SDK raised about a call it made is classified, so
a brief over the description cap and a bug in the suite are reported as themselves instead of as a
task that may be sitting on a board. And a body composed from an evidence read gets a `prepareTask`
stage that runs before the window opens, keeping the laziness that put those reads in the create
callback without the misreport. A 502 or a 504 is treated as unsettled rather than as a refusal the
deployment stated: nobody at the deployment writes those, and a gateway that gave up on the upstream
says nothing about whether the upstream had already acted. What the attached account PROVES is now
said per cause, since an origin history is a claim only the connection error carries.

kernel gains `errorChainDiagnosisText`: the chain read as a diagnosis, with undici's contentless
`fetch failed` wrapper dropped so the real cause leads. `describeConnectionFailure` had that
reduction inlined and now shares it, which is what lets a reader holding the cause class already
take the chain alone.
