# @cat-factory/gatekeeper-worker

## 0.3.0

### Minor Changes

- e1e868d: Answer `GET /health` from the whole configuration, not the two bindings the request path happens
  to read

  The documentation sweep on this package claimed `/health` reported "whether the configuration and
  policy compile". It did not. The route returned `{ ok: true }` after assembling a `Gatekeeper`,
  and assembly reads exactly `CAT_FACTORY_BASE_URL`, `PROVISIONING_KEY` and the `STATE` namespace.
  A deployment that never set `WEBHOOK_SECRET`, `OS_SHARED_TOKEN`, `PUBLIC_URL` or `WEBHOOK_ID`
  answered 200 there while `/rpc` refused every call with a 503 and the receiver verified no
  delivery. That is the one answer a health route must never give: a monitor keyed on it agrees the
  deployment is fine.

  The fix was to make the code true rather than to narrow the sentence. `/health` now runs before
  the assembly, checks every binding in one pass, and is green only when the policy also compiles.
  The check is derived from `GatekeeperEnv` through an exhaustive `Record`, so a binding added to
  the interface fails to compile until it says how it is supplied: a binding this check silently
  passed over is a binding whose absence reads as a healthy Gatekeeper.

  One pass rather than the first name the path tripped on, because the operator this serves is
  wiring a deployment: naming one unset binding per redeploy fixes a half-wired Worker one restart
  at a time. Each name now carries the mechanism it actually takes, which the old refusal left
  ambiguous ("set it in wrangler.toml (a var) or with `wrangler secret put` (a credential)") and
  which both READMEs had got wrong in the same direction, telling operators that the secrets live
  in `wrangler.toml`. `wrangler secret put PROVISIONING_KEY` is the whole difference between an
  admin API key in a secret store and one in a git history, so the vars/secrets split is now stated
  once in code and cited by the docs rather than restated by each.

  Behaviour change to watch for: an existing monitor pointed at `/health` on a deployment that was
  never fully wired flips from green to a 503 naming what is unset. That is the report, not a
  regression.

## 0.2.0

### Minor Changes

- ca2a8e3: First release of the Cloudflare OS Gatekeeper machinery as an installable library: the Cap'n Web
  capability surface compiled from `@cat-factory/gatekeeper-bindings`, per-actor API-key minting, the
  verified outbound-webhook receiver and the approval inbox that answers every park a run stops on.

  A deployment supplies only its policy, through `createGatekeeperWorker({ policy })`, and gets the
  policy vocabulary from the runtime-free `@cat-factory/gatekeeper-worker/policy` entry point.
  `deploy/gatekeeper` is the template that installs it; it was previously a copy of all of the above.

  `@cloudflare/workers-types` is a required peer dependency: every type this package publishes is
  stated in terms of the Worker globals, so a consumer without them cannot compile against it.
