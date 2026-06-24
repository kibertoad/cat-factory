---
'@cat-factory/kernel': patch
'@cat-factory/spend': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Add Kimi K2.5 (`@cf/moonshotai/kimi-k2.5`) to the model catalog as a Cloudflare-only
entry (256K context) with its spend pricing. Cloudflare lists K2.5 at $0.60 in / $3.00
out per 1M, below the K2.6/K2.7 rate, so without an explicit price entry it would fall
back to the near-free `workers-ai` neuron rate and meter at ~0.

Default the `conflict-resolver` agent kind to Kimi K2.5 on both runtimes (Worker + Node).
The conflict-resolver rewrites conflicted hunks against the base, a focused diff-heavy
reasoning task the small default MoE handles poorly. Operators can still override via
`AGENT_MODELS`.
