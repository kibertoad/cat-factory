---
'@cat-factory/app': minor
---

Ask which job you do on a first launch, and give a designer a board with only the work on it.

The SPA already narrows twice (the basic/advanced interface tier, the agent tier), but both narrowings
assume one audience: someone who will eventually want the platform underneath. A designer handing work
to the factory does not. They mount no repos, wire no models, author no pipelines, and read no operator
rollups; what they do is look at the services already on the board, watch what is in flight, and start
new work from a design, a ticket, or nothing at all. Basic mode still puts eleven configuration
destinations in front of them.

So there is now a ROLE, picked once at first launch: `engineer`, `product-manager` or `designer`.
Engineer and product-manager resolve to the same `full` surface today (they do the same job in this
app) and are separate members so one can diverge without a migration; `designer` resolves to `intake`,
which keeps the board, the tasks, the three ways to bring work in, the walkthroughs, and the way back
out of the role. It caps the interface tier at basic, so no `isAdvanced` reader inside a surface can
disagree with the narrowed nav.

Two design decisions worth reviewing. The narrowing is **opt-in per nav destination** (`intake: true`,
three entries today, each with a stated reason a spec pins) rather than opt-out: a destination added
later then defaults to the roles that configure the platform, so the failure mode is one missing flag
rather than a persona that silently stopped being simple. And the role is **client-side only, with no
deployment env pin**, unlike `NUXT_PUBLIC_UI_MODE`: which tier a fleet shows is an operator's call,
but which job the person at the keyboard does is not something a build can know. It is not
authorization either, and never becomes one: workspace RBAC still gates everything the surface offers,
which is why the switcher out of a narrowed role is reachable from inside it.
