# @cat-factory/gatekeeper-worker

The Cloudflare Worker machinery behind a cat-factory **Gatekeeper**: a credential-holding front end
that lets a [Cloudflare OS](https://github.com/cloudflare/cloudflare-os) workspace (or any agent
runtime speaking Cap'n Web) drive cat-factory without an agent ever seeing a credential.

You install this package and write one file. Everything a deployment differs by is the **policy**;
everything else, from the capability surface down to the Durable Object the minted keys live in,
comes from here. The starting point for the file you write is the template at
[`deploy/gatekeeper`](https://github.com/kibertoad/cat-factory/tree/main/deploy/gatekeeper): copy
it, point it at your workspace, and edit its `src/policy.config.ts`.

Like [`@cat-factory/gatekeeper-bindings`](https://www.npmjs.com/package/@cat-factory/gatekeeper-bindings),
whose generated operation table it compiles policy against, this is a **consumer of the stable
public surface**: it rides `/api/v1` and the outbound webhook contract through
[`@cat-factory/sdk`](https://www.npmjs.com/package/@cat-factory/sdk) and reaches nothing else. A
cat-factory deployment that has never heard of it is byte-for-byte unchanged.

## The whole of a deployment's Worker

```ts
import { createGatekeeperWorker } from '@cat-factory/gatekeeper-worker'
import { POLICY } from './policy.config'

// wrangler resolves `class_name` against the Worker's OWN exports, so the Durable Object class has
// to be named here even though it is implemented in this package.
export { GatekeeperState } from '@cat-factory/gatekeeper-worker'

export default createGatekeeperWorker({ policy: POLICY })
```

```ts
// policy.config.ts — the `/policy` entry point carries the vocabulary without the Worker runtime,
// so this file and its tests load anywhere.
import { DECISION_BINDINGS, type GatekeeperPolicy } from '@cat-factory/gatekeeper-worker/policy'

export const POLICY: GatekeeperPolicy = {
  defaultTier: null, // no implicit access: an ungranted actor gets `unknown_actor`, not a capability
  tiers: {
    observer: { description: 'Read the board and runs.', keyScope: 'read', allow: '*' },
    approver: {
      description: 'Answer a run’s parked decisions.',
      keyScope: 'decide',
      // Derived from the answerer table, never transcribed: a run parks on thirteen different
      // things and the surface carries more than forty operations for answering them.
      allow: ['tasks_get_run', ...DECISION_BINDINGS],
      mask: ['run.pullRequestUrl'],
    },
  },
  grants: { 'someone@your-org.example': 'approver' },
}
```

Bindings the Worker reads from its environment: `CAT_FACTORY_BASE_URL`, `PUBLIC_URL`, `WEBHOOK_ID`
as vars, and `PROVISIONING_KEY` (an `admin` cat-factory key), `WEBHOOK_SECRET`, `OS_SHARED_TOKEN`
as secrets, plus a `STATE` Durable Object namespace bound to `GatekeeperState`. A missing one is
answered as a 503 naming it, never defaulted: there is no safe stand-in for a credential or for the
identity of the deployment it talks to.

## What it does

- **Object-capability bindings over Cap'n Web.** An agent holds an object whose METHODS are the
  operations policy granted it. There is no allow-list consulted per call, because there is nothing
  to consult: an operation the tier does not carry is not a method that refuses, it is absent.
- **Per-actor credentials.** Each caller gets their own cat-factory key, minted through
  `POST /api/v1/keys` at the tier's scope and stamped with your identity for that person
  (`externalIdentity`), so a run traces back to a human and role-scoped merge policy stays real.
  Minting is claimed before it runs and re-mints once on a 401, so concurrent first calls mint
  once and rotating the provisioning key heals instead of wedging.
- **Approvals as an inbox, for every park.** The platform's outbound webhook delivers
  parked-decision cards; the Worker verifies the HMAC over the raw bytes, dedupes on `deliveryId`,
  and raises a card. A run can stop on thirteen different things and each has an answerer keyed on
  the SDK's own kind union, so a park the platform adds fails this package's build rather than
  reporting `stale` forever. Answering re-reads the run's live decisions and posts through the
  caller's own key.
- **Run lifecycle without polling.** `run.started` / `run.completed` / `run.failed` land as a
  `runs_watched()` projection, and a terminal event settles that run's open cards.
- **Self-enrolment and offboarding.** The endpoint registers itself under a caller-chosen webhook
  id, hourly and idempotently. `POST /admin/retire?actorId=…` revokes every key minted for one
  person, upstream first and then here.

The Worker serves `POST /webhook` (delivery HMAC), `ALL /rpc` (`OS_SHARED_TOKEN`),
`POST /admin/enroll`, `POST /admin/retire?actorId=…` and `GET /health`. `/rpc` is bearer-gated even
though the intended path is a Worker service binding, which never traverses the internet: a Worker
with a route attached is reachable by anyone who finds it, and a capability surface whose only
defence is obscurity is not one.

## Writing the policy

A policy is compiled against the LIVE operation table and only ever SUBTRACTS from
`bindingsWithinScope(tier.keyScope)`, so a tier cannot grant above the key backing it, and a
retired or misspelled operation is a refusal to serve rather than a method that 403s on every call.
Two rules are worth keeping whatever else you change:

- **Grant by name above `read`.** `'*'` is honest for a read-only tier and dangerous above it: a
  deployment that adds an operation ships it to every `'*'` tier on upgrade with nobody deciding to.
- **Keep `keyScope` as low as the grants allow.** It is the scope of the key minted for each actor,
  so it is the blast radius of that actor's credential. `admin` is refused outright, because the
  key endpoint cannot mint it: a tier asking for it is asking for the Gatekeeper's own provisioning
  secret.

A capability answers `withheld()` beside `bindings()`, and the reasons are kept apart on purpose:
`not_in_policy` and `denied_by_policy` are questions for you, `above_key_scope` is a different one,
and `not_relayable` is neither (an SSE stream or a binary blob cannot cross a Cap'n Web call).

## Custody, and what it does not promise

The provisioning key is a Worker secret and never leaves the platform's secret store. The per-actor
keys it mints live in the Durable Object's storage: outside every agent's reach, but at rest in
your account. If that is not acceptable, mint per call and revoke after, at the cost of a key row
per operation.

What this enforces is which operations an actor may reach and on whose credential. What a run then
does inside cat-factory is governed by cat-factory's own merge policy and approvals.

## Tests

The suite runs inside real `workerd` under `@cloudflare/vitest-pool-workers`, against a Worker
built from this package's own factory with a real Durable Object, real WebCrypto and a real Cap'n
Web client, talking to a scripted cat-factory origin bound as the pool's outbound service. The
credential-custody story IS "the key is a Worker secret", so a Node mock of a Worker would prove
nothing about it.

```sh
pnpm --filter @cat-factory/gatekeeper-worker test:run
```

Design notes, the decisions behind each half and what the suite deliberately does not cover:
[the initiative tracker](https://github.com/kibertoad/cat-factory/blob/main/docs/initiatives/cloudflare-os-gatekeeper.md).
The API this rides is documented in
[`backend/docs/public-api.md`](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/public-api.md).
