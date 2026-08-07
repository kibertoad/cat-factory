# Cloudflare OS Gatekeeper (reference implementation)

A Cloudflare Worker that lets a [Cloudflare OS](https://github.com/cloudflare/cloudflare-os)
workspace drive cat-factory without any agent ever seeing a credential. It is a **consumer of the
stable public surface**: it rides `/api/v1` and the outbound webhook contract through
[`@cat-factory/sdk`](../../sdk/typescript) and
[`@cat-factory/gatekeeper-bindings`](../../sdk/gatekeeper), and a cat-factory deployment that has
never heard of Cloudflare OS is byte-for-byte unchanged by it.

Like its neighbours under `deploy/`, this is a **template you copy**, not a service you install.
The artifact you want is the source, above all [`src/policy.config.ts`](./src/policy.config.ts),
which is where your deployment's actual governance decision lives.

## What it does

- **Object-capability bindings over Cap'n Web.** An OS agent holds an object whose METHODS are the
  operations policy granted it. There is no allow-list consulted per call, because there is nothing
  to consult: an operation the tier does not carry is not a method that refuses, it is absent.
- **Per-OS-user credentials.** Each actor gets their own cat-factory key, minted through
  `POST /api/v1/keys` at the tier's scope and stamped with the OS's identity for that person
  (`externalIdentity`), so a run traces back to a human and role-scoped merge policy stays real.
  The keys are minted once and cached durably; the only credential this Worker is given is the
  `admin` provisioning key, which never leaves it.
- **Approvals as an inbox, for every park.** The platform's outbound webhook delivers
  parked-decision cards here; the Worker verifies the HMAC over the raw bytes, dedupes on
  `deliveryId`, and raises a card an OS approval Gadget can answer. A run can stop on THIRTEEN
  different things (an approval gate, a requirements or clarity review, a fork, a judge verdict, a
  follow-up triage, an interview, …) and `src/decisions.ts` carries an answerer for each, keyed on
  the SDK's own kind union so a kind the platform gains fails this package's build. Answering
  re-reads the run's live decisions and posts through the caller's own `decide` key.
- **Run lifecycle without polling.** `run.started` / `run.completed` / `run.failed` land as a
  `runs_watched()` projection, and a terminal event settles that run's open cards, so an inbox
  never holds a question about a run that has ended.
- **Self-enrolment and offboarding.** The endpoint registers itself under a caller-chosen webhook
  id, hourly and idempotently, so a cold-booting Worker enrols with no create-or-discover round
  trip and cannot displace another integration's registration. `POST /admin/retire?actorId=…`
  revokes every key minted for one OS user, upstream first and then here.

## Configure

Three vars in [`wrangler.toml`](./wrangler.toml) and three secrets:

| Binding                | Kind   | What it is                                                                    |
| ---------------------- | ------ | ----------------------------------------------------------------------------- |
| `CAT_FACTORY_BASE_URL` | var    | The cat-factory deployment this Gatekeeper is paired with.                    |
| `PUBLIC_URL`           | var    | This Worker's own public origin; deliveries arrive at `<PUBLIC_URL>/webhook`. |
| `WEBHOOK_ID`           | var    | The outbound-webhook id to enrol under. Keep it stable.                       |
| `PROVISIONING_KEY`     | secret | An `admin` cat-factory API key. Mints per-actor keys; nothing else.           |
| `WEBHOOK_SECRET`       | secret | 16-200 chars. Registered with the endpoint and verified on every delivery.    |
| `OS_SHARED_TOKEN`      | secret | The bearer your Cloudflare OS deployment presents on every RPC call.          |

```sh
cd deploy/gatekeeper
wrangler secret put PROVISIONING_KEY
wrangler secret put WEBHOOK_SECRET
wrangler secret put OS_SHARED_TOKEN
pnpm deploy
curl -X POST -H "Authorization: Bearer $OS_SHARED_TOKEN" https://your-gatekeeper/admin/enroll
```

A missing binding is answered as a `503` naming it, never defaulted: there is no safe stand-in for
a credential or for the identity of the deployment it talks to.

The Worker serves five routes:

| Route                          | Auth              | What it is                                                    |
| ------------------------------ | ----------------- | ------------------------------------------------------------- |
| `POST /webhook`                | delivery HMAC     | The platform's outbound deliveries. Verified over raw bytes.  |
| `ALL /rpc`                     | `OS_SHARED_TOKEN` | The Cap'n Web endpoint your OS deployment talks to.           |
| `POST /admin/enroll`           | `OS_SHARED_TOKEN` | Re-assert the webhook registration. Also runs hourly on cron. |
| `POST /admin/retire?actorId=…` | `OS_SHARED_TOKEN` | Offboarding: revoke every key minted for one OS user.         |
| `GET /health`                  | none              | Liveness, plus whether the policy compiles.                   |

`/rpc` is bearer-gated even though the intended path is a Worker service binding, which never
traverses the internet: a Worker with a route attached is reachable by anyone who finds it, and a
capability surface whose only defence is obscurity is not one.

## Write the policy

Tiers are declared in `src/policy.config.ts` and compiled against the LIVE operation table, so a
policy that names a retired operation, or grants one above its own key's scope, fails to serve
rather than serving methods that 403. Three tiers ship as a starting point (`observer`, `operator`,
`approver`); they are examples, not defaults to keep.

```ts
approver: {
  description: 'Everything an operator can do, plus answering a run’s parked decisions.',
  keyScope: 'decide',
  // DECISION_BINDINGS is derived from the answerer table, not transcribed: a run can park on
  // thirteen different things and the surface carries more than forty operations for answering
  // them, so a hand-typed list is a tier that answers what somebody remembered.
  allow: [...DELIVERY_LOOP, ...DECISION_BINDINGS],
  mask: ['run.pullRequestUrl'],
}
```

Two rules are worth keeping whatever else you change:

- **Grant by name above `read`.** `'*'` is honest for a read-only tier and dangerous above it: a
  deployment that adds an operation ships it to every `'*'` tier on upgrade with nobody deciding to.
- **Keep `keyScope` as low as the grants allow.** It is the scope of the key minted for each actor,
  so it is the blast radius of that actor's credential.

A capability answers `withheld()` beside `bindings()`, and the two reasons are kept apart on
purpose: `denied_by_policy` is a question for you, `above_key_scope` is a question for you too but
a different one, and `not_relayable` is neither (an SSE stream or a binary blob cannot cross a
Cap'n Web call, so those operations are withheld by transport and the caller is told so).

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

`connect()` takes the identity your OS deployment authenticated, and NOTHING else the caller sends
picks a tier: an agent that could name its own tier would be its own authorization.

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

The suite runs inside real `workerd` with this Worker's real Durable Object, real WebCrypto and a
real Cap'n Web client, against a scripted cat-factory origin bound as the pool's `outboundService`.
See [`test/fake-cat-factory.mjs`](./test/fake-cat-factory.mjs) for why a scripted origin is the
right instrument here, and the initiative tracker
([`docs/initiatives/cloudflare-os-gatekeeper.md`](../../docs/initiatives/cloudflare-os-gatekeeper.md))
for what that deliberately does not cover.

## Custody, and what it does not promise

The provisioning key is a Worker secret and never leaves the platform's secret store. The per-actor
keys it mints live in the Durable Object's storage: outside every agent's reach, but at rest in
your account. If that is not acceptable for your deployment, mint per call and revoke after, at the
cost of a key row per operation.

Minting is claimed before it runs, so two concurrent first calls for one actor mint once rather
than leaving the loser's credential live upstream with nothing here recording it. Revoking the
provisioning key remains the kill switch, and it now heals: a call refused with a 401 drops the
cached key and re-mints once, so a rotation costs one request rather than requiring the Durable
Object to be wiped.

`allowedTools`-style scoping is not a substitute for the scope floor, and neither is this Worker.
What it enforces is which operations an actor may reach and on whose credential; what a run then
does inside cat-factory is governed by cat-factory's own merge policy and approvals.
