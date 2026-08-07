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
- **Approvals as an inbox.** The platform's outbound webhook delivers parked-decision cards here;
  the Worker verifies the HMAC over the raw bytes, dedupes on `deliveryId`, and raises a card an
  OS approval Gadget can answer. Answering re-reads the run's live decisions and posts through the
  caller's own `decide` key.
- **Self-enrolment.** The endpoint registers itself under a caller-chosen webhook id, hourly and
  idempotently, so a cold-booting Worker enrols with no create-or-discover round trip and cannot
  displace another integration's registration.

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

## Write the policy

Tiers are declared in `src/policy.config.ts` and compiled against the LIVE operation table, so a
policy that names a retired operation, or grants one above its own key's scope, fails to serve
rather than serving methods that 403. Three tiers ship as a starting point (`observer`, `operator`,
`approver`); they are examples, not defaults to keep.

```ts
approver: {
  description: 'Everything an operator can do, plus answering a run’s parked decisions.',
  keyScope: 'decide',
  allow: ['tasks_start', 'decisions_list', 'decisions_approve_step', /* … */],
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
// Path and query parameters at the top level, the request body under `body` — the same flattened
// convention the MCP projection uses, so the two describe one call shape.
await cat.tasks_start({ taskId: 'blk_4', body: { pipelineId: 'pl_standard_build' } })

for (const card of await cat.approvals_list()) {
  await cat.approvals_answer(card.cardId, { action: 'approve' })
}
```

`connect()` takes the identity your OS deployment authenticated, and NOTHING else the caller sends
picks a tier: an agent that could name its own tier would be its own authorization.

`approvals_answer` returns one of three statuses, and collapsing them is the mistake to avoid:
`answered` (the gate settled), `recorded` (the approval counted but the gate needs more, so the run
is still parked), and `stale` (the run no longer holds the decision this card named, with the run's
own `unanswerable` wait quoted so you know where to escalate).

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

`allowedTools`-style scoping is not a substitute for the scope floor, and neither is this Worker.
What it enforces is which operations an actor may reach and on whose credential; what a run then
does inside cat-factory is governed by cat-factory's own merge policy and approvals.
