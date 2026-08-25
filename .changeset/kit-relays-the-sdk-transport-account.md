---
'@cat-factory/acceptance-kit': minor
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
