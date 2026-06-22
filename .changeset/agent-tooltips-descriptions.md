---
'@cat-factory/app': patch
---

Explain what each agent does on hover. Hovering an agent step now surfaces its
catalog description as a tooltip everywhere a step is rendered — the pipeline
builder palette + assembled draft chain, the board task card's build-step rows
(`TaskPipelineMini`), and the "Default models for agents" window. The shared
`AgentKindIcon` carries the tooltip (label + description) so any current/future
renderer that goes through it gets the explanation for free. All default agents
(palette archetypes + engine system kinds) already carry a populated
`description` in the frontend catalog.
