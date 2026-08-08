---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/worker': minor
'@cat-factory/app': minor
---

Let a deployment define its own binary artifact stores in code. Implement the kernel
`BinaryBlobBackend` port, register it on the new app-owned `BinaryStoreRegistry`, and pass the
registry to `start()` / `startLocal()` / `createWorker({ overrides })`: each registered store then
appears in the account-settings storage picker beside the platform's `fs` / `db` / `s3` / `r2`
backends, and the per-account resolver builds it when an account selects it. The registered id is
stamped onto every artifact row, an account naming a store this build does not register resolves to
no storage and is named in the log and the settings panel, and the retention sweeps reclaim through
a custom store like any built-in one.

Internal break: `ContentStorageCapability` gains a required `customStores` and `ContentStorageSummary`
a required `customStoreId`, so a facade or test building either literal must add them (the compile
error is the point). `BinaryArtifactStorageKind` is now open at the type level, since a registered
store's id is a legitimate value of the `storage` column.
