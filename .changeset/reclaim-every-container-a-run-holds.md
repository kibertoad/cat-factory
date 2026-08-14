---
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/orchestration': minor
'@cat-factory/consensus': patch
'@cat-factory/worker': patch
'@cat-factory/local-server': patch
'@cat-factory/integrations': patch
---

Reclaim EVERY container a run holds, and stop losing the variant on the way to the container.

Routing a step to the UI-tester image gave a run a SECOND container, and four of the paths that
address a run's container by name were still written for a world with exactly one.

`AsyncAgentExecutor.stopJob` is now `reclaimRun`, taking a `RunReclaimTarget` instead of a job
handle. It could not be fixed as it stood: the engine synthesised a handle with no `agentKind`, so
the ref carried no image and every terminal, cancel and supersede path released the ordinary
container and left the browser one running to its maximum lifetime. Supplying the kind would not
have been enough either, since a run holds one container per IMAGE and that API reclaims one. The
engine now hands over every kind the run DISPATCHED (read off the persisted `step.dispatches`, so a
gate's helper and a replayed reclaim both count) and the executor maps them to the distinct images
it started.

Three more places the qualified key was mishandled. The Apple `container` adapter's name sanitiser
folded `ui:<runId>` onto a name its own inverse read back as a run called `ui-run-1`, so the boot
orphan sweep classed a live UI container as belonging to no run and deleted it mid-step; the
variant now round-trips through the name, and `RunContainerSpec.runId` is renamed `containerKey`
because reading it as a run id is what produced an encoding nothing could reverse.
`runIdFromContainerKey` stripped ANY prefix before a colon rather than a known variant, which
truncates a key it never produced into a run id that matches no run: the same data-destroying
misread it exists to prevent. And the local transport's stop-escalation evicted its cache entry
under the run id while destroying the container it had resolved under the qualified one, leaving a
cached handle pointing at a container that no longer exists (`resolve` returns a cached entry
without probing liveness).

Two refusals were also less total than they read. The local transport tested only for `ui`, so a
`deploy` ref silently ran on the agent image where the Worker names the registration mistake; it is
now exhaustive over the variant union, with the `default:` arm routed through a helper taking
`never` so a new variant fails the build. And the Cloudflare reaper resolved a row's container class
BEFORE removing the row, so a `ui` row whose class is no longer bound re-threw on every sweep pass
for ever: an unbound class is not a transient failure, so that row is dropped, counted apart from
the kills as `unreachable`, and named once with the binding to restore.

Watch for: `reclaimRun` replaces `stopJob` on the executor port (internal, no migration), and the
`live_containers` sweep now returns `{ reaped, unreachable }`.
