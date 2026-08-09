---
'@cat-factory/gatekeeper-worker': patch
---

Drive this Worker's object model with a real Cloudflare OS, and fix what that found.

**A deployment must set the `allow_irrevocable_stub_storage` compatibility flag.** `createAccount()`
hands the workspace a stub it PERSISTS, and workerd refuses to store a stub whose target Worker has
not opted in, so without the flag a perfectly bound, perfectly configured Gatekeeper is discovered
and then fails on the first account anyone connects. `deploy/gatekeeper/wrangler.toml` now carries
it, and a deployment that copied the template earlier has to add it by hand. It is not something
`GET /health` can report, because a Worker cannot read its own compatibility flags; every gatekeeper
in the Cloudflare OS repository carries it for the same reason, and a `/rpc`-only deployment pays
nothing for it.

The leg that found it is `test/os-live/`, run nightly against a pinned partner commit
(`GATEKEEPER_OS_REF`) in a workflow of its own, so a change on their side can never block a merge
here. Cloudflare OS's own integration toolkit boots the real `workshop-backend` beside this Worker
under wrangler's test harness, which is the only thing that can exercise the three seams a hermetic
suite structurally cannot: the entrypoint NAMES the workspace resolves and never asks this package
about, the stubs handed over (the persisted account, and a Durable Object class only the workspace's
machinery can instantiate), and the transcribed protocol in `src/os/protocol.ts`, where a shape that
has fallen behind still compiles here and fails there. Nothing about the Worker is re-composed for
it: the harness boots `test/wrangler.jsonc`, the same file the other two suites use, which is why
that file is now JSONC rather than TOML.

No behaviour change in the package itself. The transcribed protocol was diffed against the published
source and is accurate; the three places it is narrower than the contract are now named at the top of
the file, so the next reader making that comparison does not re-derive it.
