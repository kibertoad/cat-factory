# Custom binary artifact stores

A deployment can put the bytes of the platform's binary artifacts (the UI Tester's screenshots and
the reference design images they are reviewed against) wherever it likes, by implementing one
interface and registering it in code. This is the extension seam for storage the platform does not
ship: Google Cloud Storage, Azure Blob, an internal object service, a content-addressed store.

The platform ships five backends (`fs`, `db`, `s3`, `r2`, `memory`), and until this seam existed
those five were the whole world. `BinaryBlobBackend` was implementable but unreachable: nothing
sat between an implementation and each facade's own `switch`, so a deployment on any other store
had to fork the facade it was already depending on.

## What you implement

The kernel `BinaryBlobBackend` port, unchanged: three methods over opaque bytes keyed by a string.
Artifact METADATA always lives in the runtime's own database (so it is listed, joined and pruned
like any other row); a store holds only the bytes.

```ts
import { defaultBinaryStoreRegistry, type BinaryBlobBackend } from '@cat-factory/node-server'

const binaryStoreRegistry = defaultBinaryStoreRegistry()

binaryStoreRegistry.register({
  id: 'gcs',
  name: 'Cloud Storage',
  summary: 'The org bucket (europe-west1).',
  create: ({ accountId }) => new GcsBlobBackend({ bucket: process.env.GCS_BUCKET, accountId }),
})

await start({ binaryStoreRegistry })
```

`create` is called on a cache miss, once per account, and its result is memoised until the
account's storage config changes, so a client built there survives across requests. It may return
`null` for "this deployment cannot serve the store right now" (an unset credential, an
un-provisioned bucket); the resolver then reads as storage-unavailable, exactly as it does for a
backend a runtime does not support, and logs which store declined.

Import the seam from the FACADE you already depend on (`@cat-factory/node-server`,
`@cat-factory/local-server`, `@cat-factory/worker`), never from `@cat-factory/kernel` directly: a
`workspace:*` dependency publishes as an exact version, so reaching below the facade can resolve a
second physical copy and register into the one nothing reads.

## How a store is selected

Registration only OFFERS a store. An account picks it in the deployment settings panel, where each
registered store is its own option beside `fs` / `s3` / `db` / `r2` / off, and the selection is
stored as `contentStorage: { backend: 'custom', custom: { storeId: 'gcs' } }`. A `custom` selection
naming no store is refused where it is written, because it is the one storage config that cannot
mean anything.

The registered id is stamped onto every artifact row's `storage` column, which is why the id has
to be stable across releases: it is the column that says which store to ask for those bytes. The
value written is the REGISTRATION's id, not whatever `kind` the returned backend declares, so one
implementation registered twice (a bucket per region, say) still files its rows under two names.

An account pointed at a store this build does not register resolves to no storage, and says so
three times over rather than silently: a warning log naming the id and the registered set, the
store id in the settings summary, and a line in the settings panel naming the store the account is
configured with and that this deployment does not register.

## Per-process, deliberately

The seam is an option on `start()` / `startLocal()` and a `createWorker({ overrides })` entry, and
it has no mothership `Source` sibling, unlike the generative-integration registry it otherwise
resembles.

A generator definition is DATA a run resolves (ids, content types, a credential's name), so a
mothership-mode node reading its own copy can disagree with the picker the mothership fed, and the
set has to cross `/internal/binary-generators`. A store is the opposite kind of thing: it is a live
client holding credentials, and only the process about to write the bytes can construct one. The
process that answers the settings picker is therefore the process that stores, on a mothership node
exactly as on a standalone one, and there is nothing for a machine API to carry. Register your
stores on every process that serves requests, mothership node included.

## What a store owes the retention sweeps

Nothing beyond `delete`. The per-workspace retention sweep, the re-import reclaim and the
workspace-delete purge all resolve the account's store and delete the bytes before dropping the
metadata rows, so a store that implements `delete` is reclaimed like any built-in backend. A
`delete` that throws is tolerated for one object and its metadata row is RETAINED, so a later
sweep retries rather than orphaning the bytes.

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
