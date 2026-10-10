import type { PersistenceMethodTable } from './rpc.js'

// The VCS half of the mothership-mode persistence allow-list: the installation bindings and the
// six GitHub/GitLab read-model projections. Split out of `rpc-allowlist.ts` when the sync +
// repo-write surface landed, because that file had reached its size budget and this is the one
// cohesive block inside it: every entry here is about a repository host rather than about the
// board, and they share one argument shape (a workspaceId, or an installation id) and one
// question ("may this node write what its GitHub client just read?").
//
// Spread into `REMOTE_PERSISTENCE_METHODS`; the drift guard reads the merged table, so an entry
// here is indistinguishable from one there to everything downstream.

/**
 * The VCS installation + projection surface a mothership-mode node may reach.
 *
 * **Why the WRITE half is open now.** The projection writes were parked on "the mothership owns
 * GitHub sync, since the App and the webhooks live there", and the specific fear was that opening
 * `repoProjectionRepository.get` alone would let a repo-write endpoint perform the real GitHub
 * write and then fail on the un-remoted `upsertMany` refresh. That is an argument for opening the
 * two TOGETHER, which is what happens here: token delegation (`/internal/github/installation-token`)
 * gave a node a real GitHub client, so create-branch / open-PR / merge / comment already run there,
 * and their projection refresh is the only half still failing.
 *
 * A node still does not RECEIVE webhooks (a delivery reaches the deployment holding the public URL)
 * and does not run the reconcile cron, so `listStale` and the fan-out reads stay mothership-internal.
 * What is open is the refresh a node's OWN write earns, plus the incremental-sync cursors that keep
 * it from re-fetching what the mothership already fetched.
 *
 * Scope rules: everything workspace-keyed takes the plain `workspace` rule on arg0, which is what
 * the projections are indexed by. The installation-keyed methods take the `installation` rule
 * (installation id → the binding's account, resolved server-side) and `linkedWorkspaces` binds its
 * CANDIDATE list (`workspaceList`).
 */
export const VCS_PERSISTENCE_METHODS: PersistenceMethodTable = {
  // --- Installation bindings -------------------------------------------------------
  // `getByWorkspace` is the run path's first read: `resolveRepoTarget` runs it on EVERY
  // container-agent dispatch (installation → then the `github_repos` projection). The
  // installation-keyed reads back the binding surface around it: `listByInstallationIds` annotates
  // a list of candidate ids, `getByInstallationId` recovers GitHub's stateless setup redirect, and
  // `listWorkspacesForInstallation` is the sync fan-out's "which boards does this installation
  // reach" (bound by the installation's own account, and it answers with workspace ids of that
  // account only, so it discloses nothing the account's roster does not).
  //
  // Still OFF, and permanently:
  //
  // - `listActive`, the cron's every-tenant read. It takes no argument, so no rule can bind it,
  //   which is exactly why `listActiveForAccount` exists beside it.
  // - `upsert` / `softDelete`, the connect and disconnect WRITES. Both are `integrations.manage`
  //   in the service layer (`GitHubController` / `GitLabController` mount that permission), and
  //   the machine token scopes ACCOUNTS, not roles: a plain member of an account holds one, so
  //   opening these would let them rebind or tear down the org's VCS connection. That is the same
  //   reason `emailConnectionRepository.upsert`/`softDelete` and the invitation writes are
  //   excluded, and no scope rule can substitute for the role check the RPC bypasses.
  //
  //   The binding they would write is also not something a node can compose. App connect probes
  //   the installation through an app-JWT call, and a node's `DelegatedAppTokenSource` refuses
  //   every app-JWT path by design (the App key never leaves the mothership); the GitLab PAT
  //   connect seals its token with the LOCAL `SecretCipher`, so a node-sealed row is one the
  //   mothership cannot open. Connect stays where the App and the key are.
  githubInstallationRepository: {
    getByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
    listActiveForAccount: { scope: { kind: 'account', arg: 0 } },
    getByInstallationId: { scope: { kind: 'installation', arg: 0 } },
    listByInstallationIds: { scope: { kind: 'installationList', arg: 0 } },
    listWorkspacesForInstallation: { scope: { kind: 'installation', arg: 0 } },
  },
  // --- Repo projection -------------------------------------------------------------
  // `list` is the SPA's repos panel and the run path's projection walk. `get` is the repo-WRITE
  // facade's resolve step, and `upsertMany`/`tombstoneMissing` the refresh that follows a write or
  // a seed; `setMonorepo` is the board-owned flag `addServiceFromRepo` sets when a frame is linked
  // to a subdirectory. `linkedWorkspaces` binds its candidate list rather than the repo id: the
  // answer is a subset of what the caller passed in, so an out-of-scope candidate is refused
  // instead of quietly filtered, which would turn the read into a probe.
  //
  // The cursors are keyed by installation + repo (a repo is fetched once per org and fanned out),
  // so they take the `installation` rule. Without them a node's own sync would re-fetch every
  // page the mothership already has, which is the rate-limit budget this table exists to protect.
  //
  // Still OFF: `listStale` (the reconcile cron's cross-tenant read) and `listByInstallation` (the
  // delegation mint's own repo-scoping read, unscoped across an installation's workspaces).
  repoProjectionRepository: {
    list: { scope: { kind: 'workspace', arg: 0 } },
    get: { scope: { kind: 'workspace', arg: 0 } },
    upsertMany: { scope: { kind: 'workspace', arg: 0 } },
    tombstoneMissing: { scope: { kind: 'workspace', arg: 0 } },
    setMonorepo: { scope: { kind: 'workspace', arg: 0 } },
    linkedWorkspaces: { scope: { kind: 'workspaceList', arg: 1 } },
    getCursor: { scope: { kind: 'installation', arg: 0 } },
    setCursor: { scope: { kind: 'installation', arg: 0 } },
  },
  // --- Entity projections ----------------------------------------------------------
  // The four read models the SPA's VCS panels display and the sync ingest writes, all keyed by
  // workspace on arg0. Reads and writes move together for the reason stated above: a node whose
  // GitHub client just opened a PR must be able to project it, or the panel shows a repo that has
  // no PR the run just created.
  branchProjectionRepository: {
    listByRepo: { scope: { kind: 'workspace', arg: 0 } },
    upsertMany: { scope: { kind: 'workspace', arg: 0 } },
  },
  pullRequestProjectionRepository: {
    listByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
    listByRepo: { scope: { kind: 'workspace', arg: 0 } },
    upsertMany: { scope: { kind: 'workspace', arg: 0 } },
  },
  issueProjectionRepository: {
    listByWorkspace: { scope: { kind: 'workspace', arg: 0 } },
    listByRepo: { scope: { kind: 'workspace', arg: 0 } },
    upsertMany: { scope: { kind: 'workspace', arg: 0 } },
  },
  commitProjectionRepository: {
    listByRepo: { scope: { kind: 'workspace', arg: 0 } },
    upsertMany: { scope: { kind: 'workspace', arg: 0 } },
  },
  // The check-run projection the `ci` gate's precheck reads by head SHA. Its absence was a run-path
  // gap, not only a panel one: a gate that cannot read the projection falls back to the provider on
  // every poll.
  checkRunProjectionRepository: {
    listBySha: { scope: { kind: 'workspace', arg: 0 } },
    upsertMany: { scope: { kind: 'workspace', arg: 0 } },
  },
}
