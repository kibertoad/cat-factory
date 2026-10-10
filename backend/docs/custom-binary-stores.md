# Custom binary artifact stores

> **Writing a provider is on the website**:
> [Custom Providers](https://www.catfactory.ai/extend/custom-providers.html) owns the code
> seams a deployment implements, this store among them. This page is the cache and
> resolution DESIGN behind it.

A deployment can put the bytes of the platform's binary artifacts (the UI Tester's screenshots and
the reference design images they are reviewed against) wherever it likes, by implementing one
interface and registering it in code. This is the extension seam for storage the platform does not
ship: Google Cloud Storage, Azure Blob, an internal object service, a content-addressed store.

The platform ships five backends (`fs`, `db`, `s3`, `r2`, `memory`), and until this seam existed
those five were the whole world. `BinaryBlobBackend` was implementable but unreachable: nothing
sat between an implementation and each facade's own `switch`, so a deployment on any other store
had to fork the facade it was already depending on.

## What you implement

The kernel `BinaryBlobBackend` port: three methods over opaque bytes keyed by a string. Artifact
METADATA always lives in the runtime's own database (so it is listed, joined and pruned like any
other row); a store holds only the bytes. The registration example, the four rules that go with it
(bytes-only, registration only OFFERS, a stable id, implement `delete`) and the `create`-returns-null
case are on the website's
[Custom Providers](https://www.catfactory.ai/extend/custom-providers.html#example-a-custom-binary-artifact-store).

Two facts sit under that page. **Import the seam from the FACADE you already depend on**
(`@cat-factory/node-server`, `@cat-factory/local-server`, `@cat-factory/worker`), never from
`@cat-factory/kernel` directly: a `workspace:*` dependency publishes as an EXACT version, so
reaching below the facade can resolve a second physical copy and register into the one nothing
reads. And **`create` is memoised per account** until that account's storage config changes, so the
client you build there survives across requests rather than being rebuilt per resolve.

## How a store is selected

The registered id is stamped onto every artifact row's `storage` column, and the value written is
the REGISTRATION's id, not whatever `kind` the returned backend declares. So one implementation
registered twice (a bucket per region, say) files its rows under two names, which is the behaviour
that makes the id load-bearing rather than cosmetic. A `custom` selection naming no store is refused
where it is written, because it is the one storage config that cannot mean anything.

An account pointed at a store this build does not register resolves to no storage, and says so
three times over rather than silently: a warning log naming the id and the registered set, the store
id in the settings summary, and a line in the settings panel naming the store the account is
configured with and that this deployment does not register.

## Per-process, deliberately

The seam is an option on `start()` / `startLocal()` and a `createWorker({ overrides })` entry, and
it has no mothership `Source` sibling, unlike the generative-integration registry it otherwise
resembles. That asymmetry is the design decision worth recording.

A generator definition is DATA a run resolves (ids, content types, a credential's name), so a
mothership-mode node reading its own copy can disagree with the picker the mothership fed, and the
set has to cross `/internal/binary-generators`. A store is the opposite kind of thing: it is a live
client holding credentials, and only the process holding the bytes can construct one. There is
nothing for a machine API to carry, and no second copy that could disagree with a first.

What follows for a deployment (register on every process that HANDLES the bytes, which on a
mothership is both the node and the mothership) is on the website's page above. A mothership-mode
node says so at boot, naming the ids it registered.

On the Worker the registration is process-wide rather than held on the app
(`infrastructure/binaryStores.ts`), because that runtime builds a container per entry point and
the entry points that need a store take no options: the durable driver that stores a
visual-confirmation screenshot, the queue consumers, and the retention cron, which builds its
store resolver outside the container entirely. `createWorker({ overrides: { binaryStoreRegistry } })`
registers on your behalf, so a deployment using the documented seam needs to know none of that.

## What a store owes the retention sweeps

`delete`, and a registration on the process that sweeps (above). The per-workspace retention sweep,
the re-import reclaim and the workspace-delete purge all resolve the account's store and delete the
bytes before dropping the metadata rows, so a store that implements `delete` is reclaimed like any
built-in backend. A `delete` that throws is tolerated for one object and its metadata row is
RETAINED, so a later sweep retries rather than orphaning the bytes.

A sweep that cannot BUILD the store skips the workspace, which is also what it does for the far
more common account that configured no storage at all. The two are told apart where the difference
is knowable: the resolver logs the account and the store id it could not build, once per account
per configuration rather than once per resolve, so the line that names a misconfiguration is not
buried under its own repetitions.

## Where the pieces live

| Piece                                   | Where                                                          |
| --------------------------------------- | -------------------------------------------------------------- |
| The port you implement                  | `kernel/src/ports/binary-artifacts.ts`                         |
| The registry                            | `kernel/src/domain/binary-store-registry.ts`                   |
| Per-account resolution + the capability | `server/src/persistence/binaryArtifactStore.ts`                |
| The account's selection (wire shape)    | `contracts/src/accountSettings.ts`                             |
| Cross-runtime assertions                | `internal/conformance/src/content-storage-resolution-suite.ts` |

Related: [`storage-and-retention.md`](./storage-and-retention.md) for what is retained and for how
long, [`@cat-factory/provider-s3`](../packages/provider-s3/README.md) for a worked implementation
of the same port, and
[`binary-output-foundational-storage.md`](../../docs/initiatives/binary-output-foundational-storage.md)
for the DIFFERENT feature next door: a generated product asset goes to the org's own foundational
service, not here. This store holds run EVIDENCE.
