---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Run an environment dry run on the model the workspace picked, and hand it what the tester will get

An agent dry run was dispatched on a model no workspace had chosen. Its facades read the deployment's
env routing for the tester kinds once, at wiring, and pinned the prober to it for the process
lifetime, so a workspace running everything on its Claude preset had its dry run dispatched at the
Node family's Qwen default. The LLM proxy then refused it for having no key configured (`502`), after
the run had already created a branch and stood a real environment up. The subscription that would
have served it was never asked for, because the flow only ever knew the proxy branch: a
subscription-routed model was refused at WIRING, which disabled the whole capability for exactly the
deployments that had one.

The model is now resolved per dispatch, under the same precedence a pipeline step gets (the frame's
own pin, then the workspace's model preset entry for the prober's kind, then env routing), through
the shared `ModelRouter`. The credential that opens it comes from the same `ContainerJobAuthResolver`
the step executor uses, so a dry run can run on a pooled subscription, a personal one, or the
developer's own CLI in native local mode. A personal credential is only leasable with its owner's
unlock, so the start route gates on it exactly as a run start does (428 `credential_required`, minted
against the run id the dispatch leases against) rather than provisioning an environment and failing
at the lease. `provision` mode spends no model call and stays ungated.

The dry run also now predicts what a tester step will be handed, which is the only thing it was ever
claiming. Both are rendered by one module: the frame's test credentials as a three-state brief
(configured / the platform could not open its own store / this deployment has no store), the
environment access scheme including the two states the tester's own section used to drop, and one
list of where to look in the repository for how to operate the service. The tester side of each was
weaker: a sealed store that would not open reached it as an absent section, which reads as "this
service has none configured" and sends someone to re-enter secrets that are already there, and an
unopenable store took the whole dispatch down rather than costing the credentials.

One rule the two held halves of moved with them: the shapes of a success nobody observed (a 200
carrying an error body, a login page where JSON was expected, a command that printed failures and
exited 0, a suite that ran zero tests). The prober named the HTTP ones; the tester, whose greenlight
is what merges a change, had the principle and none of the shapes. Grading and writing deliberately
did NOT move, because a prober never does either and the second is a security property its dispatch
shape enforces.

Watch for one behaviour change: a dry run used to run on the deployment's `tester-api` /
`tester-ui` env routing, and now runs on whatever the workspace's preset names for
`environment-prober-api` / `environment-prober-ui`, falling back to that same env routing when the
preset names neither. A deployment that wants a specific model for dry runs sets it on those two
preset entries. The proxyable check moved with the resolution: it is asked of the RESOLVED model at
dispatch instead of disabling the capability deployment-wide over a routing entry no workspace had
chosen.
