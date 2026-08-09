# @cat-factory/gatekeeper-worker

## What it is

The Cloudflare Worker machinery behind a cat-factory **Gatekeeper**: a credential-holding front
end that lets a [Cloudflare OS](https://github.com/cloudflare/cloudflare-os) workspace drive
cat-factory without an agent ever seeing a credential. Agents hold an object-capability whose
methods are exactly what policy granted; the keys stay in Worker secrets and Durable Object
storage.

It serves TWO doors onto the same rooms, and which one a caller comes in by decides how it is
authorized:

| Door                              | Who comes in by it                                               | Authorization       |
| --------------------------------- | ---------------------------------------------------------------- | ------------------- |
| The `GatekeeperVendor` entrypoint | A Cloudflare OS workspace, over a `GATEKEEPER_*` service binding | Holding the binding |
| `ALL /rpc` (Cap'n Web over HTTP)  | Any other agent runtime that speaks Cap'n Web                    | `OS_SHARED_TOKEN`   |

The published Cloudflare OS contract reaches a gatekeeper over native Workers RPC to a
`WorkerEntrypoint` export named `GatekeeperVendor`; Cap'n Web is that workspace's browser-to-backend
and gadget-side protocol, which shares the semantics and not the wire. So `/rpc` is the door for
everything that is NOT a Cloudflare OS deployment, and nothing here is Cloudflare-OS-only.

It is the machinery half of the Gatekeeper family:

| Piece                                                                                                | What it is                                                                     | How you take it                       |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------- |
| [`@cat-factory/gatekeeper-bindings`](https://www.npmjs.com/package/@cat-factory/gatekeeper-bindings) | the generated operation table this package compiles policy against             | comes in as a dependency              |
| `@cat-factory/gatekeeper-worker` (this package)                                                      | the capability surface, key broker, webhook receiver, approval inbox, state DO | install, and write only a policy      |
| [`deploy/gatekeeper`](https://github.com/kibertoad/cat-factory/tree/main/deploy/gatekeeper)          | the deployment template: policy, wrangler bindings, three lines of wiring      | copy, and edit `src/policy.config.ts` |

You install this package and write one file. Everything a deployment differs by is the
**policy**; everything else, from the capability surface down to the Durable Object the minted
keys live in, comes from here. That split is the goal: upgrading the machinery is a version bump
rather than a merge against files you have edited, and "did you get the security-relevant fix" is
answerable from a version number.

## Purpose and goal

Its purpose is to put cat-factory behind an organization's own governance pane: per-actor
credentials so every run traces back to a person, per-tier operation grants so an agent can reach
only what its operator decided, field masking, and the platform's parked decisions surfaced as an
approval inbox instead of a polling loop.

It is a **consumer of the stable public surface**: it rides `/api/v1` and the outbound webhook
delivery contract through [`@cat-factory/sdk`](https://www.npmjs.com/package/@cat-factory/sdk) and
reaches nothing else. A cat-factory deployment that has never heard of it is byte-for-byte
unchanged.

## How to use it

The starting point is the template at
[`deploy/gatekeeper`](https://github.com/kibertoad/cat-factory/tree/main/deploy/gatekeeper): copy
it, point it at your workspace, and edit its `src/policy.config.ts`. A deployment's whole Worker
is:

```ts
import { createGatekeeperWorker } from '@cat-factory/gatekeeper-worker'
import { POLICY } from './policy.config'

// wrangler resolves `class_name` against the Worker's OWN exports, so the Durable Object class has
// to be named here even though it is implemented in this package.
export { GatekeeperState } from '@cat-factory/gatekeeper-worker'

export default createGatekeeperWorker({ policy: POLICY })
```

```ts
// policy.config.ts: the `/policy` entry point carries the vocabulary without the Worker runtime,
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

`@cloudflare/workers-types` is a **required** peer, not an optional one. Every type this package
publishes is stated in terms of the Worker globals (`ExportedHandler`, `DurableObjectNamespace`,
`Request`) and the Durable Object base class comes from `cloudflare:workers`, so a consumer without
those types cannot compile the three lines above, let alone anything else. It is a peer rather than
a dependency because the globals are ambient: two copies in one tree redeclare each other, so the
version has to be the consumer's.

## What it does

- **Object-capability bindings.** An agent holds an object whose METHODS are the operations policy
  granted it. There is no allow-list consulted per call, because there is nothing to consult: an
  operation the tier does not carry is not a method that refuses, it is absent.
- **The Cloudflare OS object model, as a facade over all of it.** `GatekeeperVendor` →
  `CatFactoryAccount` → `CatFactoryResource` → session, with `describe()`,
  `getSupportedResources()` and `getTypeScriptTypes()` all PROJECTIONS of the operation table
  rather than transcriptions of it. A resource is the paired cat-factory workspace, named by a
  URLPattern over the deployment origin: one Gatekeeper serves one workspace, because the
  provisioning key it holds is scoped to one.
- **The workspace's approval queue, in front of every call.** On the entrypoint path each read is
  authorized before its result is handed back, and each write is SUBMITTED and performed only when
  the workspace applies it. Reads that serve captured agent text are marked unshareable, actions
  carry the consequence the table states, and nothing is offered for unattended auto-approval while
  the surface annotates no write as safe. The tier policy underneath stays the floor.
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

One thing to tell whoever writes the agent on the other side: **a task filed with only a title
parks immediately**, before any agent runs. cat-factory reduces a task's own authored fields before
the first dispatch, and a missing description is a blocking finding, so `tasks_create` +
`tasks_start` with a bare title yields a run stopped on an `input-gate` decision rather than one
that is working. That park is answerable from here like any other, but the cheaper fix is filing
work that says what it wants.

## What to configure

Everything operational comes from the Worker's environment, through two mechanisms that are not
interchangeable: the vars and the Durable Object binding are written in the template's
`wrangler.toml`, and the three credentials are secrets, put with `wrangler secret put` into the
platform's secret store. A credential in a config file is a credential in a repository, so a
refusal names the mechanism its binding actually takes rather than offering both.

| Binding                | Kind           | What it is                                                                    |
| ---------------------- | -------------- | ----------------------------------------------------------------------------- |
| `CAT_FACTORY_BASE_URL` | var            | The cat-factory deployment this Gatekeeper is paired with.                    |
| `PUBLIC_URL`           | var            | This Worker's own public origin; deliveries arrive at `<PUBLIC_URL>/webhook`. |
| `WEBHOOK_ID`           | var            | The outbound-webhook id to enrol under. Caller-chosen; keep it stable.        |
| `PROVISIONING_KEY`     | secret         | An `admin` cat-factory API key. Mints per-actor keys; nothing else.           |
| `WEBHOOK_SECRET`       | secret         | 16-200 chars. Registered with the endpoint and verified on every delivery.    |
| `OS_SHARED_TOKEN`      | secret         | The bearer the paired OS deployment presents on every RPC call.               |
| `STATE`                | Durable Object | A namespace bound to `GatekeeperState`: cards, dedupe log, minted keys.       |

A missing binding is answered as a 503 naming it and how it is set, never defaulted: there is no
safe stand-in for a credential or for the identity of the deployment it talks to. `GET /health`
asks the whole table at once rather than the bindings a given request path happens to read, so a
deployment that is wired for liveness and unwired for traffic reads as what it is.

The Worker serves five routes:

| Route                          | Auth              | What it is                                                    |
| ------------------------------ | ----------------- | ------------------------------------------------------------- |
| `POST /webhook`                | delivery HMAC     | The platform's outbound deliveries. Verified over raw bytes.  |
| `ALL /rpc`                     | `OS_SHARED_TOKEN` | Cap'n Web, for an agent runtime that is not a Cloudflare OS.  |
| `POST /admin/enroll`           | `OS_SHARED_TOKEN` | Re-assert the webhook registration. Also runs hourly on cron. |
| `POST /admin/retire?actorId=…` | `OS_SHARED_TOKEN` | Offboarding: revoke every key minted for one OS user.         |
| `GET /health`                  | none              | Green only when every binding is set and the policy compiles. |

`/rpc` is bearer-gated because a Worker with a route attached is reachable by anyone who finds it,
and a capability surface whose only defence is obscurity is not one. The Cloudflare OS path does not
come through here at all: it arrives on a service binding, which never traverses the internet and
which only that deployment's operator can write, so holding it IS the authorization and a second
secret in front of it would protect nothing.

Beyond the routes, the entry module must export the four names the Cloudflare OS object model
resolves (`GatekeeperVendor`, `CatFactoryAccount`, `CatFactoryResource`, `CatFactoryVerifier`).
`/health` checks those in the same pass as the bindings: a perfectly bound Worker whose entry module
is three lines short is undiscoverable, and that failure has no request path of its own.

## What to customize: the policy

The policy is the ONE thing a deployment writes, and it is an argument
(`createGatekeeperWorker({ policy })`), never a file this package reads. A `GatekeeperPolicy` has
three fields:

- `defaultTier`: the tier an actor with no explicit grant receives, or `null` to refuse unknown
  actors (`unknown_actor`). `null` is the shipped default and the safe one: adding a person is
  then a deliberate edit.
- `tiers`: named `TierPolicy` entries, each carrying:
  - `description`: prose the OS shows beside the tier.
  - `keyScope`: the scope of the per-actor key minted for this tier (`read` / `write` /
    `decide`). It is also the ceiling on the grants; `admin` is refused outright, because
    `POST /api/v1/keys` cannot mint it and a tier asking for it is asking for the Gatekeeper's
    own provisioning secret.
  - `allow`: binding names to grant, or `'*'` for everything within `keyScope`.
  - `deny`: binding names to subtract from `allow`. Applied last, so a deny always wins; the
    template uses it to keep the debug surface (model prompts, captured output) away from a
    `'*'` read tier.
  - `mask`: dotted paths redacted from every result before it reaches the caller (see below).
- `grants`: OS actor identity (whatever the OS authenticates and passes to `connect()`) to tier
  name.

A policy is compiled against the LIVE operation table and only ever SUBTRACTS from
`bindingsWithinScope(tier.keyScope)`, so a tier cannot grant above the key backing it, and a
retired or misspelled operation is a refusal to serve (`PolicyError`) rather than a method that
403s on every call. Two rules are worth keeping whatever else you change:

- **Grant by name above `read`.** `'*'` is honest for a read-only tier and dangerous above it: a
  deployment that adds an operation ships it to every `'*'` tier on upgrade with nobody deciding to.
- **Keep `keyScope` as low as the grants allow.** It is the scope of the key minted for each actor,
  so it is the blast radius of that actor's credential.

**Masking replaces, never deletes.** A masked leaf becomes the exported `MASKED` sentinel
(`[masked by gatekeeper policy]`) rather than disappearing, because a removed key and a key the
platform had no value for read identically to the consuming agent, and they are different facts.
Paths are dotted and traverse arrays element-wise (`steps.status` masks every step's status); a
path that matches nothing is not an error, because result shapes legitimately vary by operation.

## What a caller holds

`connect({ actorId, label? })` on the `/rpc` session resolves the actor's tier and returns the
capability. `actorId` is the OS's own authenticated identity for the person, and it is the ONLY
claim the Gatekeeper trusts: nothing the caller sends picks a tier. Beyond the granted operation
methods, every capability carries seven reserved methods:

- `tier()`: who the caller is acting as (actor, tier name, description, key scope).
- `bindings()`: the granted operations, each with its scope floor, consequence (cautious default
  applied) and argument shape, so the OS can run its own approval governance per call.
- `withheld()`: every binding the deployment serves that this capability does NOT carry, with the
  reason. The four reasons are kept apart on purpose: `not_in_policy` and `denied_by_policy` are
  questions for the policy's author, `above_key_scope` is a different one (raise the tier's key,
  or accept the ceiling), and `not_relayable` is neither: an SSE stream or a binary blob cannot
  cross a Cap'n Web call, so the fix is to ask another way (poll `tasks_get_run` instead of the
  event stream).
- `approvals_list()`, `approvals_inspect(cardId)`, `approvals_answer(cardId, input)`: the
  approval inbox; see the template README for the flow and the three answer outcomes.
- `runs_watched()`: the run-lifecycle projection built from the `run.*` webhook events.

Refusals from a live Gatekeeper are `GatekeeperError`s carrying a machine-readable `reason`
(`unknown_actor`, `card_not_found`, `ambiguous_park`, …), the same role the platform's own
`details.reason` plays: an OS Gadget maps it to copy and a remedy. Operator mistakes are
`PolicyError`s raised at compile time, before any capability exists, so a misconfigured Gatekeeper
serves nothing rather than serving methods that fail.

## Custody, and what it does not promise

The provisioning key is a Worker secret and never leaves the platform's secret store. The per-actor
keys it mints live in the Durable Object's storage: outside every agent's reach, but at rest in
your account. If that is not acceptable, mint per call and revoke after, at the cost of a key row
per operation.

What this enforces is which operations an actor may reach and on whose credential. What a run then
does inside cat-factory is governed by cat-factory's own merge policy and approvals.

## Upgrading

Upgrade this package. `@cat-factory/gatekeeper-bindings` arrives as its dependency, pinned to an
exact version, so bumping this package IS how the operation table moves and there is nothing to
keep in step by hand. Do not add a direct dependency on the bindings to keep them "together": an
exact pin plus a second range installs a SECOND copy of the table, while policy still compiles
against the one resolved here. Everything a policy names is re-exported from
`@cat-factory/gatekeeper-worker/policy`, so a deployment never needs that dependency.

Version skew is reported rather than absorbed. A policy naming an operation newer than the
installed table fails with a `PolicyError` telling you to upgrade, and the ladder helpers throw on
a scope rung they do not carry, so a deployment ahead of your packages reads as skew, never as a
key with no permissions.

## Tests

The suite runs inside real `workerd` under `@cloudflare/vitest-pool-workers`, against a Worker
built from this package's own factory with a real Durable Object, real WebCrypto and a real Cap'n
Web client, talking to a scripted cat-factory origin bound as the pool's outbound service. The
credential-custody story IS "the key is a Worker secret", so a Node mock of a Worker would prove
nothing about it.

```sh
pnpm --filter @cat-factory/gatekeeper-worker test:run
```

`test/live/` is the same Worker with the scripted origin taken away. A fixture agrees with this
package by construction, so a request shape the bindings and the SDK both consider correct can only
be wrong against a real deployment: the live specs enrol on the real webhook collection, mint a real
per-actor key (and recover from its revocation), forward the everyday loop, and answer a run that
really parked, off the card the platform's own notification raises. They are run by
`@cat-factory/sdk-smoketest`, which owns the deployment they need, so this package carries no
Postgres-shaped devDependency:

```sh
DATABASE_URL=... pnpm --filter @cat-factory/sdk-smoketest run smoketest -- --only=gatekeeper
```

What that deliberately does not cover is a delivery that TRAVELLED: the platform refuses to register
a loopback endpoint, so the receiver is driven with an envelope the suite signs around the
platform's own notification object.

## References

- [`deploy/gatekeeper`](https://github.com/kibertoad/cat-factory/tree/main/deploy/gatekeeper): the
  template you copy, its configuration walkthrough and the OS-side usage example.
- [The initiative tracker](https://github.com/kibertoad/cat-factory/blob/main/docs/initiatives/cloudflare-os-gatekeeper.md):
  design notes, the decisions behind each half, and what the suite deliberately does not cover.
- [`backend/docs/public-api.md`](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/public-api.md):
  the API this rides (keys, scopes, webhooks, endpoint semantics).
- [`@cat-factory/gatekeeper-bindings`](https://www.npmjs.com/package/@cat-factory/gatekeeper-bindings):
  the generated operation table policy is compiled against.
