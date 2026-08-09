# Cloudflare OS Gatekeeper (deployment template)

## What it is

A Cloudflare Worker that lets a [Cloudflare OS](https://github.com/cloudflare/cloudflare-os)
workspace drive cat-factory without any agent ever seeing a credential. It is a **consumer of the
stable public surface**: it rides `/api/v1` and the outbound webhook contract, and a cat-factory
deployment that has never heard of Cloudflare OS is byte-for-byte unchanged by it.

Like its neighbours under `deploy/`, this is a **template you copy**, not a service you install.
What you copy is deliberately small:

| File                                             | What it is                                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| [`src/policy.config.ts`](./src/policy.config.ts) | **Your deployment's governance decision.** The one file that is really yours.            |
| [`wrangler.toml`](./wrangler.toml)               | The bindings: two origins, the webhook id, the Durable Objects, the hourly cron.         |
| [`src/index.ts`](./src/index.ts)                 | The wiring: your policy through each factory, under the names the object model resolves. |
| [`test/policy.test.ts`](./test/policy.test.ts)   | What your tiers grant, compiled against the live operation table.                        |

Everything else, the capability surface, the Cloudflare OS object model in front of it, the
per-actor key broker, the delivery receiver and its verifier, the approval inbox and the answerer
for each of the platform's thirteen park kinds, is the published
[`@cat-factory/gatekeeper-worker`](../../sdk/gatekeeper-worker), which this template installs as an
ordinary dependency. That split is the point: upgrading the machinery is a version bump rather than
a merge against files you have edited, and what a reviewer sees in your repository is your policy
rather than a fork of somebody else's Worker. What the machinery does, in full, is
[its README](../../sdk/gatekeeper-worker/README.md).

The short version of what you do with this template: **configure** the deployment (three vars and
the Durable Object bindings in `wrangler.toml`; the three credentials through
`wrangler secret put`, never in a file this repository carries), and **customize** the policy in
`src/policy.config.ts`, together with `test/policy.test.ts`, which pins what that policy grants
and is meant to move with it. Nothing else in the template is meant to be edited.

## Configure

Three vars and the Durable Object namespace go in [`wrangler.toml`](./wrangler.toml). The three
credentials are secrets: they are put into the platform's secret store and belong in no config
file, which is the point of the split.

| Binding                | Kind           | What it is                                                                    |
| ---------------------- | -------------- | ----------------------------------------------------------------------------- |
| `CAT_FACTORY_BASE_URL` | var            | The cat-factory deployment this Gatekeeper is paired with.                    |
| `PUBLIC_URL`           | var            | This Worker's own public origin; deliveries arrive at `<PUBLIC_URL>/webhook`. |
| `WEBHOOK_ID`           | var            | The outbound-webhook id to enrol under. Keep it stable.                       |
| `STATE`                | Durable Object | A namespace bound to `GatekeeperState`: cards, dedupe log, minted keys.       |
| `PROVISIONING_KEY`     | secret         | An `admin` cat-factory API key. Mints per-actor keys; nothing else.           |
| `WEBHOOK_SECRET`       | secret         | 16-200 chars. Registered with the endpoint and verified on every delivery.    |
| `OS_SHARED_TOKEN`      | secret         | The bearer a non-Cloudflare-OS caller presents on the HTTP routes.            |

```sh
cd deploy/gatekeeper
wrangler secret put PROVISIONING_KEY
wrangler secret put WEBHOOK_SECRET
wrangler secret put OS_SHARED_TOKEN
pnpm deploy
curl -X POST -H "Authorization: Bearer $OS_SHARED_TOKEN" https://your-gatekeeper/admin/enroll
```

A missing binding is answered as a `503` naming it and the mechanism it takes, never defaulted:
there is no safe stand-in for a credential or for the identity of the deployment it talks to.

The Worker serves five routes:

| Route                          | Auth              | What it is                                                    |
| ------------------------------ | ----------------- | ------------------------------------------------------------- |
| `POST /webhook`                | delivery HMAC     | The platform's outbound deliveries. Verified over raw bytes.  |
| `ALL /rpc`                     | `OS_SHARED_TOKEN` | The Cap'n Web endpoint your OS deployment talks to.           |
| `POST /admin/enroll`           | `OS_SHARED_TOKEN` | Re-assert the webhook registration. Also runs hourly on cron. |
| `POST /admin/retire?actorId=…` | `OS_SHARED_TOKEN` | Offboarding: revoke every key minted for one OS user.         |
| `GET /health`                  | none              | Green when every binding is set and the policy compiles.      |

`/rpc` is bearer-gated even though the intended path is a Worker service binding, which never
traverses the internet: a Worker with a route attached is reachable by anyone who finds it, and a
capability surface whose only defence is obscurity is not one.

## Connect a Cloudflare OS workspace

A Cloudflare OS deployment discovers this Worker through a service binding whose name carries the
`GATEKEEPER_` prefix it scans for, targeting the `GatekeeperVendor` entrypoint:

```toml
[[services]]
binding = "GATEKEEPER_CAT_FACTORY"
service = "cat-factory-gatekeeper"
entrypoint = "GatekeeperVendor"
```

Holding that binding is the authorization on this path: it is configuration only that deployment's
operator can write, and the call never leaves Cloudflare's network. `OS_SHARED_TOKEN` gates the HTTP
routes only, which is where a caller that is not a Cloudflare OS comes in.

**`wrangler.toml` must keep the `allow_irrevocable_stub_storage` compatibility flag**, which the
template carries. `createAccount()` hands the workspace a stub it PERSISTS, and workerd refuses to
store a stub whose target Worker has not opted in, so without the flag a perfectly bound Gatekeeper
is discovered and then fails on the first account anyone connects. It is not something `/health` can
report: a Worker cannot read its own compatibility flags, and the nightly OS leg is what checks it.
A `/rpc`-only deployment pays nothing for it.

Two more things on this side have to be true, and `GET /health` reports on both under `os`:

- **`src/index.ts` exports all four names the object model resolves** (`GatekeeperVendor`,
  `CatFactoryAccount`, `CatFactoryResource`, `CatFactoryVerifier`). They are resolved by name at
  runtime, so a renamed export is a Worker a workspace can never finish installing.
  `CatFactoryHookController` is resolved the same way and is reported apart from those, under
  `os.limitations`: without it the Gatekeeper installs and serves, and only the hooks refuse.
- **Your policy names an `autoProvisionedTier`.** A workspace mints one account per user with no
  identity attached, by design, so no account can ever match a `grants` entry. Naming a tier there
  is what turns discovery on. It is deliberately not `defaultTier`: sharing one knob would mean
  turning discovery on also handed a capability to every unrostered caller on `/rpc`. To raise one
  account above the tier, read its id from the account's description in the workspace and grant that
  id directly.

The template ships with discovery OFF (`autoProvisionedTier: null`), so a fresh copy answers
`{"ok": true, "os": {"discoverable": false, …}}` with that named as the blocker. That is a report
rather than a failure: the routes above all work without it. Once you have named a tier and
deployed, `os.discoverable` is what a monitor on the OS door watches.

## Write the policy

Tiers are declared in `src/policy.config.ts` and compiled against the LIVE operation table, so a
policy that names a retired operation, or grants one above its own key's scope, fails to serve
rather than serving methods that 403. Three tiers ship as a starting point (`observer`, `operator`,
`approver`); they are examples, not defaults to keep. A tier carries a `keyScope` (the scope of
the key minted for its actors, and the ceiling on its grants), an `allow` list (or `'*'`), an
optional `deny` list subtracted last (the shipped `observer` uses it to keep the debug surface's
model prompts and captured output away from a `'*'` read tier), and an optional `mask` of dotted
result paths, redacted rather than removed. The full field reference is in
[the machinery README](../../sdk/gatekeeper-worker/README.md#what-to-customize-the-policy).

```ts
approver: {
  description: 'Everything an operator can do, plus answering a run’s parked decisions.',
  keyScope: 'decide',
  // DECISION_BINDINGS is derived from the machinery's answerer table, not transcribed: a run can
  // park on thirteen different things and the surface carries more than forty operations for
  // answering them, so a hand-typed list is a tier that answers what somebody remembered.
  allow: [...DELIVERY_LOOP, ...DECISION_BINDINGS],
  mask: ['run.pullRequestUrl'],
}
```

Two rules are worth keeping whatever else you change:

- **Grant by name above `read`.** `'*'` is honest for a read-only tier and dangerous above it: a
  deployment that adds an operation ships it to every `'*'` tier on upgrade with nobody deciding to.
- **Keep `keyScope` as low as the grants allow.** It is the scope of the key minted for each actor,
  so it is the blast radius of that actor's credential.

A capability answers `withheld()` beside `bindings()`, and the four reasons are kept apart on
purpose: `not_in_policy` and `denied_by_policy` are questions for you (the first an omission, the
second a decision), `above_key_scope` is a question for you too but a different one, and
`not_relayable` is neither (an SSE stream or a binary blob cannot cross a Cap'n Web call, so those
operations are withheld by transport and the caller is told so).

## Talk to it

```js
import { newWebSocketRpcSession } from 'capnweb'

const api = newWebSocketRpcSession('wss://your-gatekeeper/rpc') // Authorization: Bearer <OS_SHARED_TOKEN>
const cat = api.connect({ actorId: 'someone@your-org.example' })

await cat.tier() // { tier: 'approver', keyScope: 'decide', … }
// Path and query parameters at the top level, the request body under `body`: the same flattened
// convention the MCP projection uses, so the two describe one call shape.
await cat.tasks_start({ taskId: 'blk_4', body: { pipelineId: 'pl_standard_build' } })

for (const card of await cat.approvals_list()) {
  // `approvals_list()` is the whole inbox: settled cards are included (the OS decides what it
  // renders), and a `notice` is a run waiting on a person in the cat-factory app rather than a
  // question this surface can settle.
  if (card.resolvedAt !== null || card.disposition !== 'decision') continue

  // What the run is parked on NOW, with the verbs that park takes, the fields each verb needs,
  // and whether this tier holds the operation behind it. Composing an answer from here rather
  // than from a doc is what keeps an agent from posting a body the platform refuses.
  const { parks } = await cat.approvals_inspect(card.cardId)
  const park = parks[0]
  if (park === undefined) continue

  if (park.kind === 'approval-gate') {
    await cat.approvals_answer(card.cardId, { action: 'approve' })
  } else if (park.kind === 'requirements-review') {
    await cat.approvals_answer(card.cardId, { action: 'reply', itemId: 'ri_1', reply: 'Postgres.' })
  }
}

await cat.runs_watched() // [{ runId, event: 'run.completed', terminal: true, run }, …]
```

Both projections can be PUSHED instead of polled, from a Cloudflare OS session (the `/rpc` door has
no approval queue to register a hook with, and says so):

```js
// The workspace holds the registration and may ask a person before enabling it, so binding is not
// receiving: nothing arrives until it is enabled.
await cat.approvals_subscribe(myCallback) // myCallback.onApprovalCard(card)
await cat.runs_subscribe(myOtherCallback) // myOtherCallback.onRunEvent(state)

// What is enabled, and what each hook has taken. `live: false` with a rising `missed` is a hook
// that stopped receiving: bind again, and read `approvals_list()` for what it missed. Binding
// again from the same gadget re-arms THAT hook and keeps its counters, rather than adding a second.
await cat.hooks_bound()
```

A hook is an accelerator over the two reads, never a replacement for them: they stay the truth, so
a workspace that missed a push has lost a notification rather than a card. That is also why the
fan-out runs behind the delivery's acknowledgement, with a deadline on each push: a workspace whose
callback hangs costs its own notification and never the platform's retry of a card already
recorded. A card is pushed on every transition it makes, including the settlement a terminal run
event gives it, so an inbox rendered from pushes alone stops offering decisions nobody can answer.

`connect()` takes the identity your OS deployment authenticated (plus an optional display
`label`), and NOTHING else the caller sends picks a tier: an agent that could name its own tier
would be its own authorization.

`approvals_answer` returns one of three statuses, and collapsing them is the mistake to avoid:

| status     | what it means                                                                          | the card |
| ---------- | -------------------------------------------------------------------------------------- | -------- |
| `answered` | the run left the park; the answer moved it                                             | settled  |
| `recorded` | the answer was taken and the park still holds (a quorum unmet, a reply not yet folded) | open     |
| `stale`    | nothing this surface can answer is holding the run, with the reason                    | open     |

A `stale` answer settles nothing, deliberately: the run may still be parked on a wait a person has
to clear, and the platform re-delivers a card under a NEW notification id, so a card settled in
error is never re-raised and the inbox loses its only pointer to that run.

A run genuinely can hold two parks at once (a follow-up triage accrues while a later step's gate is
open). Answering then needs a `kind`, because the platform lists parks in a shape order rather than
a priority order and picking the first would settle whichever the projection happened to build
first.

## Tests

```sh
pnpm --filter @cat-factory/deploy-gatekeeper test:run
```

What this package tests is its POLICY: that the shipped tiers compile, that none of them can reach
a merge or a captured model prompt, and that `approver` holds everything answering a park takes. It
is a plain Node run, because the `/policy` entry point it compiles through carries no Worker
runtime. Keep this suite when you copy the template and edit it alongside your tiers.

The machinery's own suite (real `workerd`, real Durable Object, real Cap'n Web, a scripted
cat-factory origin) lives with the machinery, in
[`sdk/gatekeeper-worker`](../../sdk/gatekeeper-worker). The design record
([ADR 0052](../../backend/docs/adr/0052-cloudflare-os-gatekeeper.md)) says what that deliberately
does not cover, and what the nightly leg against a real Cloudflare OS covers instead.

## Custody, and what it does not promise

The provisioning key is a Worker secret and never leaves the platform's secret store. The per-actor
keys it mints live in the Durable Object's storage: outside every agent's reach, but at rest in
your account. If that is not acceptable for your deployment, mint per call and revoke after, at the
cost of a key row per operation.

Minting is claimed before it runs, so two concurrent first calls for one actor mint once rather
than leaving the loser's credential live upstream with nothing here recording it. Revoking the
provisioning key remains the kill switch, and it heals: a call refused with a 401 drops the cached
key and re-mints once, so a rotation costs one request rather than requiring the Durable Object to
be wiped.

`allowedTools`-style scoping is not a substitute for the scope floor, and neither is this Worker.
What it enforces is which operations an actor may reach and on whose credential; what a run then
does inside cat-factory is governed by cat-factory's own merge policy and approvals.

## References

- [`sdk/gatekeeper-worker`](../../sdk/gatekeeper-worker/README.md): the machinery this template
  installs, its policy field reference and the capability surface.
- [`sdk/gatekeeper`](../../sdk/gatekeeper/README.md): the generated operation table and scope
  helpers policy is compiled against.
- [`backend/docs/public-api.md`](../../backend/docs/public-api.md): the API this rides (keys,
  scopes, webhooks, endpoint semantics).
- [ADR 0052](../../backend/docs/adr/0052-cloudflare-os-gatekeeper.md): the design record, the
  alternatives it was decided against, and the traps the build surfaced.
- [`docs/glossary.md`](../../docs/glossary.md): the Gatekeeper naming map (bindings vs machinery
  vs template).
