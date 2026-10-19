---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/workspaces': minor
'@cat-factory/server': minor
'@cat-factory/conformance': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/worker': minor
---

A runner pool can now be set once per ACCOUNT, and every board of the account that has no pool of
its own dispatches to it. A deployment declares it with `seedAccountRunnerPool` on the Node
`start()`: a callback `(account) => { config, secrets } | undefined`, called for personal and org
accounts alike. The server inserts the result for each account that has none, at boot and when a
board is created. At boot it also replaces an account's pool when the callback's answer differs from
the stored one (config, or the decrypted secrets), so a rotated token reaches every account on the
next boot; board creation never replaces. On stock Node, where a runner pool is the only
executor, a new board then runs an agent with no Infrastructure step. A legacy board with no account
gets nothing.

A board resolves its pool through one resolver: its own live row, then its account's row, then none.
The new workspace setting `inheritAccountRunnerPool` (default `true`) is the explicit "none" marker.
`DELETE /workspaces/:id/runner-pool/connection` now sets it to `false` unless the call carries
`fallBackToAccount=true`, so removing a board's own pool no longer silently re-routes its work to the
account's pool. The query parameter and the setting are additive.

The seed is validated like an admin registration (backend kind registered, URL safe, referenced
secrets present) through a shared `RunnerPoolConnectionService.validate`. A seed that fails is logged
at `error` naming the account on every boot, and a failed read never fails board creation.

New storage, mirrored on both runtimes: the `account_runner_pools` table (D1 migration 0110 and a
Drizzle migration) with an `AccountRunnerPoolRepository` kernel port (`insertIfAbsent`, and
`replace` for a changed seed), a unique key making the insert race safe, `AccountRepository.listAll`, and the `inherit_account_runner_pool` settings column. The
account repository is on the mothership allow-list for reads; mothership nodes and `startLocal()` do
not seed. The Worker does not take the option: there a pool is an optional target beside the built-in
containers.
