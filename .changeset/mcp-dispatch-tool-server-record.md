---
'@cat-factory/contracts': patch
'@cat-factory/kernel': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/app': patch
---

Record on the run which MCP tool servers a dispatch wired, and why the others were dropped

A deployment can register MCP tool servers and attach them to agent kinds, and a dispatch drops any
it cannot wire: the harness speaks no MCP, a credential did not resolve, the declaration named a key
the platform owns, nobody has connected the workspace's OAuth grant. Each of those is a different
fix. Until now the decision reached exactly two readers, and neither was the person who could act on
it: the agent's own prompt, in prose telling it to plan around the missing tool, and a backend `warn`
line. The operator-visible symptom of a missing credential was an agent that simply never used the
tool it was given.

That resolution is now a record on the run. One list, wired entries included, is written at dispatch
onto the step and onto the agent-context telemetry snapshot, and rendered as chips on the step's
metadata card and in the observability panel, each drop naming what to change. The list is whole on
purpose: "two of three wired" and "two of two" are the two answers the surface exists to tell apart,
and a drops-only field states neither. It is absent, never empty, when the kind declared no servers,
so a stock deployment's runs say nothing at all.

Three decisions worth knowing about. It rides the DISPATCH handle rather than the poll, because
servability depends on the resolved harness, the facade-wired secret resolver and this workspace's
grants, none of which is in scope by the time the durable poll path rebuilds the handle from the
step. On the snapshot it is a typed COLUMN rather than one more key in the `extras` bag, which the
panel renders as a JSON dump: debris belongs in a dump, and a fact someone opens the panel to find
does not. And the drop-reason vocabulary is mirrored from kernel into `@cat-factory/contracts` with a
conformity test pinning the two member lists, since the SPA has to name each reason and cannot see
kernel.

Compatibility: internal only, and one break to flag. The snapshot's `extras.toolServers` and
`extras.unavailableToolServers` keys are gone rather than dual-written, so a tool that read them
reads the typed field instead. Existing snapshot rows are unaffected and correct: the new column
defaults to the empty list, which is exactly what a dispatch declaring no tool servers records.

Still open, and named in the tracker: what the agent's own MCP client actually reached inside the
container. This records what the platform DECIDED before a byte reached the server, so a server
wired into the config and then failing its handshake mid-run still reads as wired. Closing that needs
the harness to report its client's view back, and therefore a runner-image bump.
