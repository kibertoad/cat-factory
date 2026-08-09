# `@cat-factory/acceptance`

**Acceptance tests against a LIVE local deployment.** Real agents, real model spend, real
repositories, real pull requests, and a real k3s cluster. They bootstrap two empty repositories
into working services, ship a feature across both onto an ephemeral Kubernetes environment, then
file the defect that feature leaves behind and let the platform investigate and fix it.

**Never run in CI**, and structurally cannot be: `test:run` (the task CI runs) points at
`vitest.config.ts`, which collects only this package's own unit tests. The acceptance specs live
under `acceptance/` behind a second config that nothing but the `acceptance` script names.

```sh
pnpm --filter @cat-factory/acceptance run acceptance
```

## What it is for

The e2e suite ([`backend/internal/e2e`](../e2e)) proves the assembled product with every external
dependency faked, and the conformance suite proves the backend port by port. Neither can answer the
question this suite exists for: **does the whole thing work when nothing is faked?** A fake agent
executor cannot tell you that a real model, handed a real brief, produces a repository whose
manifests a real apiserver accepts, whose tests a real CI gate passes, and whose defect a real
investigation finds. Everything here is the part that only exists once nothing is a stub.

The trade is deliberate and worth stating: this suite is slow, costs money, and is not
deterministic. That is why it is a hand-run acceptance pass rather than a lane.

## The scenarios

Four spec files, run in order. Each spec's output is the next one's input.

| Spec                     | What it does                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `00-preflight`           | The key, its workspace and scope; the pipeline catalog; a real probe of the k3s apiserver; the ingress template renders. Creates nothing.                          |
| `01-bootstrap`           | Connects the k3s engine, bootstraps a backend repo and a frontend repo from empty, declares each service's manifest source, and checks both are fileable services. |
| `02-feature-with-defect` | Ships a paginated catalog across both services on `pl_build`. Asserts the environment came up on the cluster, CI gated it, the merge resolved, the namespace went. |
| `03-investigate-and-fix` | Files the resulting bug as a report, runs `pl_bugfix`, answers its `clarity-review` human gate over `/api/v1`, and asserts a red-then-green reproduction proof.    |

### The defect is planted in the SPECIFICATION, not in the code

Spec 03 can only investigate a bug spec 02 actually shipped, so something has to put one there.
Telling the coder to write a bug does not survive the pipeline: `pl_build` runs a `reviewer` step,
and a deliberate defect inside one service is exactly what a reviewer is for. It would be caught,
the run would bounce, and spec 03 would find nothing wrong.

So the defect is a **contract mismatch between the two briefs**: the backend's says `offset` counts
from 1, the frontend's says it counts from 0. Each service is implemented faithfully, reviewed
against its own brief, and found correct, because it is. The defect exists only in the space
between them, which no single-repository review can see, and it shows up only when both run
together, which is what the ephemeral environment is for. It is also the most ordinary integration
bug there is.

The symptom it produces, which is what the bug report describes: page 1 lists items 1–10, page 2
starts at item 10 again, and the last page is short.

The consequence, stated because it is easy to misread as a gap: **spec 02 asserts the delivery
machinery worked, never that the product is defect-free.** By construction it is not. The claim
that the product is right is spec 03's, and it is settled by fixing the bug rather than by
asserting it away.

## Prerequisites

A local cat-factory that can really do the work, and a cluster to deploy onto.

**The deployment**

- Running in **local mode** (`@cat-factory/local-server`) with `AUTH_DEV_OPEN=true` (local mode's
  default). Three setup calls use the session-authed app API; see "The escape hatch" below.
- `ENCRYPTION_KEY` set, or `/api/v1` answers `503` on every call.
- A **VCS credential** with rights to create repositories under `ACCEPTANCE_REPO_OWNER`, and a
  container runtime for the agent jobs.
- A **model** wired that can actually build a small service. This suite is not a model benchmark,
  but a model that cannot scaffold a Fastify app will fail spec 01 for reasons that are not the
  platform's.
- A **merge-threshold preset that permits auto-merge**. `pl_build` ends in a `merger`, and the
  suite asserts each feature run reached `done`, which the platform reaches only when the pull
  request really merged. A preset that holds everything for a person is correctly configured and
  will stop this suite; the failure says so.

**The cluster**

Any k3s/k3d you can reach. The `ServiceAccount`, RBAC and long-lived token are the ones in
[`backend/docs/local-k3s-environments.md`](../../docs/local-k3s-environments.md), **including the
cluster-wide binding** the ephemeral-environments backend needs to create per-PR namespaces.
`cat-factory k3s` (the CLI's guided setup) provisions all of it.

No deploy runner is needed. The suite uses a `raw` manifest source, which the backend applies
directly over the apiserver; a `kustomize` overlay would need `LOCAL_DEPLOY_RUNTIME=container` and
a deploy image on top. That is real product surface and is covered by the doc above, not here.

**One thing to know about images.** The bootstrapped repositories ship a workflow that builds and
pushes their image on every push, and their manifests reference the platform's `{{image}}`
placeholder. The `deployer` step runs after `coder` and `reviewer`, so the image is normally
already pushed by then; where it is not, the pods sit in `ImagePullBackOff` and Kubernetes retries
until it lands, which the environment status poll absorbs. The registry must be readable by the
cluster (a public package, or an `imagePullSecret` you have already installed).

## Configuration

| Variable                               | Required | What it is                                                                                        |
| -------------------------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `CAT_FACTORY_BASE_URL`                 | yes      | Backend origin, e.g. `http://127.0.0.1:8787`. Serves both `/api/v1` and the app API.              |
| `CAT_FACTORY_API_KEY`                  | yes      | A public-API key scoped **`admin`** (spec 03 also needs the `decide` rung it includes).           |
| `ACCEPTANCE_WORKSPACE_ID`              | yes      | The workspace the key is bound to. `GET /api/v1/me` reports it.                                   |
| `ACCEPTANCE_REPO_OWNER`                | yes      | GitHub owner the bootstrapped repositories are created under.                                     |
| `ACCEPTANCE_K3S_API_SERVER`            | yes      | Apiserver URL, e.g. `https://127.0.0.1:6443`.                                                     |
| `ACCEPTANCE_K3S_TOKEN`                 | yes      | The ServiceAccount bearer token.                                                                  |
| `ACCEPTANCE_K3S_CA_PEM`                | one of   | The cluster CA in PEM. Wins over the insecure flag when both are set.                             |
| `ACCEPTANCE_K3S_INSECURE`              | one of   | `true` to skip apiserver TLS verification. Throwaway clusters only.                               |
| `ACCEPTANCE_K3S_INGRESS_HOST_TEMPLATE` | no       | Default `{{namespace}}.127.0.0.1.nip.io`, which needs no DNS.                                     |
| `ACCEPTANCE_K3S_NAMESPACE_TEMPLATE`    | no       | Default `cf-acc-{{pullNumber}}`.                                                                  |
| `ACCEPTANCE_NAME_PREFIX`               | no       | Default `cf-acc`. Set it per-person when an org is shared: repository names collide account-wide. |
| `ACCEPTANCE_RUN_BUDGET_MS`             | no       | Per-run ceiling, default 90 min. Not a vitest timeout; see below.                                 |
| `ACCEPTANCE_STATE_DIR`                 | no       | Default `.acceptance`, relative to this package.                                                  |
| `ACCEPTANCE_RUN_ID`                    | no       | Set it to **resume** a previous pass instead of starting a new one.                               |

Missing configuration is reported **all at once**, with what each variable is for. The suite
refuses rather than guessing, because it creates real repositories.

## Resuming

A full pass costs an afternoon and real spend, so every spec records what it created in a ledger
under `ACCEPTANCE_STATE_DIR` and re-reads it on start. The run id is printed at the top of every
spec file's output:

```sh
ACCEPTANCE_RUN_ID=20260809175530 pnpm --filter @cat-factory/acceptance run acceptance
```

A resumed pass reuses the bootstrapped services (re-checking they still exist on the board, not
just in the ledger) and re-runs from the first unfinished step. `bail: 1` keeps the ledger pointing
at the step that actually broke.

**Nothing is cleaned up on failure.** The run, its pull request and any provisioned namespace are
left in place to be inspected, and the failure message says so. Successful passes reclaim their
namespaces through the pipeline's own `disposer`, which spec 02 asserts.

## The rules these specs are written to

Four, and each is load-bearing.

**1. Assert on evidence the platform COMPUTED, never on prose an agent wrote.** A test that greps a
coder's reply for "fixed the off-by-one" is testing the model's turn of phrase; change the model
and it goes red having found nothing wrong. The verification report exists because the platform
derives its verdicts in code from captured facts, so `reproduction.verdict`, `environments.proof`,
`ci.verdict` and `merge.outcome` are stable claims. `src/evidence.ts` reduces them, and is itself
unit-tested: a bug in a grader reports green and nothing else notices.

**2. Never auto-answer a decision the suite was not designed for.** `src/decisions.ts` answers
exactly two kinds and hard-fails on every other, naming it. The tempting shape is a loop that
settles whatever it finds so the run keeps moving; that produces a green suite that proves nothing,
because a `pr-review` gate auto-resolved and a `fork` auto-picked are decisions a person was
supposed to make.

**3. A wait that expires must say what it last saw.** The vitest timeout is disabled on purpose so
that `src/deadline.ts` fires first: "timed out after 5400000ms" is true and useless, where "step 3
`coder` was still working, 4/9 subtasks" separates a parked run from a wedged one from a slow one.

**4. Every failing claim is reported, not just the first.** A run that both skipped its environment
and failed CI is one story, and learning the second half on tomorrow's re-run wastes a day per bug.

## The escape hatch

The suite drives `/api/v1` through the **published TypeScript SDK**, the same artifact an
integrator installs, so a surface change that would break an integration breaks this suite at
compile time. Three setup calls have no public counterpart and go to the session-authed app API,
each documented at the top of [`src/appApi.ts`](./src/appApi.ts):

1. **Bootstrapping a repository** (`POST /workspaces/:ws/bootstrap/jobs`). `/api/v1` can create a
   service against an existing repository but has nothing that makes one.
2. **Connecting the k3s engine** (`POST /workspaces/:ws/environments/handlers`).
3. **Declaring a service's manifest source** (`PATCH /workspaces/:ws/blocks/:blockId`).

All three are deployment SETUP, deliberately absent from a surface frozen forever. The acceptance
narrative itself (file work, watch it run, answer what it asks, read what it proved) is entirely
public. If a future change makes one of these reachable from `/api/v1`, delete it from there.

## Where things live

| Path                         | What                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `acceptance/*.acceptance.ts` | The four specs, in order. `fixtures.ts` builds the harness.                     |
| `src/config.ts`              | Environment → config, reporting every problem at once. Pure; unit-tested.       |
| `src/world.ts`               | The resumable ledger.                                                           |
| `src/publicApi.ts`           | SDK client, run observation, the polling waits.                                 |
| `src/runDriver.ts`           | Start a task and drive it to terminal, answering parks under one shared budget. |
| `src/decisions.ts`           | The two decision kinds this suite answers, and the refusal for everything else. |
| `src/evidence.ts`            | The report reductions the specs assert on. Pure; unit-tested.                   |
| `src/instructions.ts`        | The briefs, and the reasoning behind the planted defect.                        |
| `src/k3s.ts`                 | The engine connection and the per-service manifest source.                      |
| `src/bootstrap.ts`           | Starting a bootstrap and reporting its structured failure.                      |
| `src/appApi.ts`              | The three setup calls `/api/v1` does not serve.                                 |
| `src/deadline.ts`            | Waiting, with the observation the expiry needs.                                 |

**See also:** [`backend/internal/e2e`](../e2e) (the faked-externals product suite),
[`backend/internal/sdk-smoketest`](../sdk-smoketest) (the same SDK against a booted backend),
[`backend/docs/public-api.md`](../../docs/public-api.md),
[`backend/docs/local-k3s-environments.md`](../../docs/local-k3s-environments.md).
