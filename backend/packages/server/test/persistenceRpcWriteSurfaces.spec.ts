import { describe, expect, it } from 'vitest'
import { ACCOUNT, OTHER_ACCOUNT, remoteRegistry } from './persistenceRpc.harness.js'

// The mothership-mode persistence RPC, SERVICE + VCS half: the org-catalog write path (service
// CRUD and the mount cascade that finishes a frame deletion) and the VCS installation +
// projection surface, reads and the sync/repo-write writes alike.
//
// Split from `persistenceRpcSurfaces.spec.ts` when the completed surface pushed that file past
// its size budget. These belong together: both are about state a node WRITES on behalf of an org
// rather than reads for a panel, and both introduced a scope rule whose second half exists to stop
// a caller reaching another tenant's row (`serviceInsert`'s frame block, `serviceUpdate`'s stored
// service).

describe('service CRUD surface (the frame-creation write path)', () => {
  // `registerServiceForFrame` runs `insert` on EVERY top-level frame creation, so until this
  // landed a mothership-mode node could not create a service frame at all. The `serviceInsert`
  // rule binds the DECLARED account and the frame block the row claims — and the frame block is
  // the half that matters: `getByFrameBlock` resolves by frame block id alone, so a service
  // planted on another org's frame can redirect that org's runs at a repo the caller controls.

  const service = (over: Record<string, unknown> = {}) => ({
    id: 'svc_new',
    accountId: ACCOUNT,
    frameBlockId: 'blk_new',
    installationId: null,
    repoGithubId: null,
    directory: null,
    createdAt: 0,
    ...over,
  })

  it('forwards an insert whose frame block does not exist yet (the ordinary creation order)', async () => {
    // The service row is written BEFORE its block, so an absent block is the normal case, not an
    // anomaly. Block ids are server-minted, so admitting an unknown one grants nothing.
    await expect(remoteRegistry().serviceRepository!.insert!(service())).resolves.toBeUndefined()
  })

  it('forwards an insert onto an EXISTING frame block in the same account', async () => {
    await expect(
      remoteRegistry().serviceRepository!.insert!(service({ frameBlockId: 'blk_in' })),
    ).resolves.toBeUndefined()
  })

  it("rejects an insert that plants a service on another org's frame block (404)", async () => {
    // blk_out homes in ws_out (OTHER_ACCOUNT). Admitted, this row would make
    // `getByFrameBlock(blk_out)` ambiguous and could point that org's runs at this caller's repo.
    await expect(
      remoteRegistry().serviceRepository!.insert!(service({ frameBlockId: 'blk_out' })),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects an insert declaring an account the token does not hold (404)', async () => {
    await expect(
      remoteRegistry().serviceRepository!.insert!(service({ accountId: OTHER_ACCOUNT })),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it("rejects an insert whose declared account differs from the frame block's (404)", async () => {
    // Both halves can be individually in scope for a MULTI-account token, so the rule requires
    // equality rather than merely in-scope-ness.
    await expect(
      remoteRegistry([ACCOUNT, OTHER_ACCOUNT]).serviceRepository!.insert!(
        service({ accountId: OTHER_ACCOUNT, frameBlockId: 'blk_in' }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects an insert with no account or a non-object record (fails closed)', async () => {
    await expect(
      remoteRegistry().serviceRepository!.insert!(service({ accountId: null })),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      remoteRegistry().serviceRepository!.insert!(undefined as unknown as object),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('forwards an update of an in-scope service and refuses an out-of-scope one', async () => {
    await expect(
      remoteRegistry().serviceRepository!.update!('svc_in', { directory: 'apps/web' }),
    ).resolves.toBeUndefined()
    await expect(
      remoteRegistry().serviceRepository!.update!('svc_out', { directory: 'apps/web' }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects an update that re-homes a service into an account the token lacks (404)', async () => {
    // A service's account decides whose org catalog offers it for mounting, so an unbound patch
    // would push an attacker-authored frame into another org's mountable set.
    await expect(
      remoteRegistry().serviceRepository!.update!('svc_in', { accountId: OTHER_ACCOUNT }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it("rejects an update that clears a service's account (404)", async () => {
    // An account-less service is the legacy/unscoped row; no scoped token may create one.
    await expect(
      remoteRegistry().serviceRepository!.update!('svc_in', { accountId: null }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('forwards the deletes for in-scope services and refuses foreign ones', async () => {
    await expect(remoteRegistry().serviceRepository!.delete!('svc_in')).resolves.toBeUndefined()
    await expect(
      remoteRegistry().serviceRepository!.deleteMany!(['svc_in']),
    ).resolves.toBeUndefined()
    await expect(remoteRegistry().serviceRepository!.delete!('svc_out')).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(
      remoteRegistry().serviceRepository!.deleteMany!(['svc_in', 'svc_out']),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('shared-service mount management surface', () => {
  // `serviceRepository.get(serviceId)` binds via the `service` scope kind (single serviceId →
  // owning account, the single-id form of `serviceList`). svc_in lives under ACCOUNT, svc_out
  // under OTHER_ACCOUNT.
  it('forwards serviceRepository.get for an in-scope service', async () => {
    await expect(remoteRegistry().serviceRepository!.get!('svc_in')).resolves.toMatchObject({
      id: 'svc_in',
    })
  })

  it('rejects serviceRepository.get for an out-of-scope service (404, no leak)', async () => {
    await expect(remoteRegistry().serviceRepository!.get!('svc_out')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('rejects serviceRepository.get for an unknown service (fails closed)', async () => {
    await expect(remoteRegistry().serviceRepository!.get!('svc_missing')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('rejects serviceRepository.get for a non-string arg (fails closed)', async () => {
    await expect(
      remoteRegistry().serviceRepository!.get!(undefined as unknown as string),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  // The workspaceId-keyed mount methods (arg0 = workspaceId → the `workspace` rule): `get` echoes
  // the workspaceId, the void writes `update`/`remove` just resolve.
  const WORKSPACE_METHODS: Array<{ method: string; args: unknown[]; echoes?: boolean }> = [
    { method: 'get', args: ['svc_in'], echoes: true },
    { method: 'update', args: ['svc_in', { position: { x: 1, y: 2 } }] },
    { method: 'remove', args: ['svc_in'] },
  ]

  for (const { method, args, echoes } of WORKSPACE_METHODS) {
    it(`forwards workspaceMountRepository.${method} for an in-scope workspace`, async () => {
      const result = await remoteRegistry().workspaceMountRepository![method]!('ws_in', ...args)
      if (echoes) expect(result).toMatchObject({ ws: 'ws_in' })
      else expect(result).toBeUndefined()
    })

    it(`rejects workspaceMountRepository.${method} for an out-of-scope workspace (404)`, async () => {
      await expect(
        remoteRegistry().workspaceMountRepository![method]!('ws_out', ...args),
      ).rejects.toMatchObject({ code: 'not_found' })
    })
  }

  // The real-time fan-out's per-publish read. Unlike the rest of this repo's surface it is not a
  // management call: `FanOutEventPublisher` makes it on EVERY event, so an un-listed method here
  // didn't merely lose a frame — it rejected the publish, and the rejection reached the run-state
  // emit. arg0 is the ORIGIN workspaceId, so it takes the plain `workspace` rule.
  it('forwards workspaceMountRepository.listWorkspaceIdsMountingBlock for an in-scope workspace', async () => {
    await expect(
      remoteRegistry().workspaceMountRepository!.listWorkspaceIdsMountingBlock!('ws_in', 'blk_1'),
    ).resolves.toEqual(['ws_in:blk_1'])
  })

  it('rejects workspaceMountRepository.listWorkspaceIdsMountingBlock for an out-of-scope workspace (404)', async () => {
    await expect(
      remoteRegistry().workspaceMountRepository!.listWorkspaceIdsMountingBlock!('ws_out', 'blk_1'),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  // `upsert(mount)` binds on the mount's `workspaceId` FIELD via the `serviceMount` rule: the mount
  // is placed onto exactly `mount.workspaceId` (out-of-scope → refused before any write) AND the
  // mounted `serviceId` must be owned by the SAME account as that workspace (the cross-org mount
  // invariant, enforced at the RPC layer — not only in the bypassed service layer).
  it('forwards workspaceMountRepository.upsert when the mount targets an in-scope workspace', async () => {
    await expect(
      remoteRegistry().workspaceMountRepository!.upsert!({
        workspaceId: 'ws_in',
        serviceId: 'svc_in',
      }),
    ).resolves.toBeUndefined()
  })

  it('rejects workspaceMountRepository.upsert when the mount targets an out-of-scope workspace (404)', async () => {
    await expect(
      remoteRegistry().workspaceMountRepository!.upsert!({
        workspaceId: 'ws_out',
        serviceId: 'svc_in',
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects workspaceMountRepository.upsert when the mount has no workspaceId field (404)', async () => {
    await expect(
      remoteRegistry().workspaceMountRepository!.upsert!({ serviceId: 'svc_in' }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects workspaceMountRepository.upsert when the mount has no serviceId field (404)', async () => {
    await expect(
      remoteRegistry().workspaceMountRepository!.upsert!({ workspaceId: 'ws_in' }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects workspaceMountRepository.upsert when the mounted service is unknown (404)', async () => {
    await expect(
      remoteRegistry().workspaceMountRepository!.upsert!({
        workspaceId: 'ws_in',
        serviceId: 'svc_missing',
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  // The cross-org mount invariant under a MULTI-account token (a user in several orgs). Both
  // ACCOUNT and OTHER_ACCOUNT are in scope, so a workspace-only check would let one org's service
  // be mounted onto another org's board. The `serviceMount` rule's same-account requirement blocks
  // it: svc_out (OTHER_ACCOUNT) cannot be mounted onto ws_in (ACCOUNT) even though both are in scope.
  it('rejects a cross-org mount upsert even when both accounts are in the token scope (404)', async () => {
    await expect(
      remoteRegistry([ACCOUNT, OTHER_ACCOUNT]).workspaceMountRepository!.upsert!({
        workspaceId: 'ws_in',
        serviceId: 'svc_out',
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('forwards a same-account mount upsert for a workspace in a secondary in-scope account', async () => {
    // A multi-account token can still mount WITHIN each org: svc_out onto ws_out (both OTHER_ACCOUNT).
    await expect(
      remoteRegistry([ACCOUNT, OTHER_ACCOUNT]).workspaceMountRepository!.upsert!({
        workspaceId: 'ws_out',
        serviceId: 'svc_out',
      }),
    ).resolves.toBeUndefined()
  })

  it('forwards the batched cascade reads a frame deletion runs', async () => {
    // `listByServiceIds`/`removeByServices` finish a service delete: without them a node deletes a
    // frame and leaves every OTHER board in the org mounting a service that no longer exists.
    await expect(
      remoteRegistry().workspaceMountRepository!.listByServiceIds!(['svc_in']),
    ).resolves.toEqual([])
    await expect(
      remoteRegistry().workspaceMountRepository!.removeByServices!(['svc_in']),
    ).resolves.toBeUndefined()
  })

  it('rejects the batched cascade reads for an out-of-scope service (404)', async () => {
    await expect(
      remoteRegistry().workspaceMountRepository!.removeByServices!(['svc_out']),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('VCS / GitHub projection read surface (workspace-scoped)', () => {
  // The projection READS the SPA's VCS board panels display (repos/branches/PRs/issues), served
  // straight from the local projections by `GitHubService` — no GitHub API call, so they run
  // unchanged over the remote-sourced projection repos. Each takes the workspaceId as arg0 (the
  // `workspace` rule); `args` are the trailing arguments after it (a `listByRepo` also carries the
  // repoGithubId, which the scope check ignores — only the workspace binds). The installation
  // `getByWorkspace` is the run path's FIRST read (`resolveRepoTarget` resolves the installation
  // before walking the `github_repos` projection), also workspace-scoped on arg0.
  const READS: Array<{ repo: string; method: string; args: unknown[] }> = [
    { repo: 'githubInstallationRepository', method: 'getByWorkspace', args: [] },
    { repo: 'repoProjectionRepository', method: 'list', args: [] },
    { repo: 'repoProjectionRepository', method: 'get', args: [42] },
    { repo: 'branchProjectionRepository', method: 'listByRepo', args: [42] },
    { repo: 'pullRequestProjectionRepository', method: 'listByWorkspace', args: [] },
    { repo: 'pullRequestProjectionRepository', method: 'listByRepo', args: [42] },
    { repo: 'issueProjectionRepository', method: 'listByWorkspace', args: [] },
    { repo: 'issueProjectionRepository', method: 'listByRepo', args: [42] },
    { repo: 'commitProjectionRepository', method: 'listByRepo', args: [42] },
    { repo: 'checkRunProjectionRepository', method: 'listBySha', args: [42, 'deadbeef'] },
  ]

  // The WRITE half, which moved with the reads: a node whose delegated GitHub client just opened a
  // PR must be able to project it, or the panel shows a repo with no PR the run created. Each is
  // workspace-keyed on arg0 like its read siblings.
  const WRITES: Array<{ repo: string; method: string; args: unknown[] }> = [
    { repo: 'repoProjectionRepository', method: 'upsertMany', args: [[]] },
    { repo: 'repoProjectionRepository', method: 'tombstoneMissing', args: [11, [], 0] },
    { repo: 'repoProjectionRepository', method: 'setMonorepo', args: [42, true] },
    { repo: 'branchProjectionRepository', method: 'upsertMany', args: [[]] },
    { repo: 'pullRequestProjectionRepository', method: 'upsertMany', args: [[]] },
    { repo: 'issueProjectionRepository', method: 'upsertMany', args: [[]] },
    { repo: 'commitProjectionRepository', method: 'upsertMany', args: [[]] },
    { repo: 'checkRunProjectionRepository', method: 'upsertMany', args: [[]] },
  ]

  for (const { repo, method, args } of WRITES) {
    it(`forwards ${repo}.${method} for an in-scope workspace`, async () => {
      await expect(remoteRegistry()[repo]![method]!('ws_in', ...args)).resolves.toBeUndefined()
    })

    it(`rejects ${repo}.${method} for an out-of-scope workspace (404, no leak)`, async () => {
      await expect(remoteRegistry()[repo]![method]!('ws_out', ...args)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
  }

  for (const { repo, method, args } of READS) {
    it(`forwards ${repo}.${method} for an in-scope workspace`, async () => {
      const result = await remoteRegistry()[repo]![method]!('ws_in', ...args)
      // Each stub echoes the workspaceId, proving the call reached the bound workspace.
      expect(Array.isArray(result) ? result[0] : result).toMatchObject({ ws: 'ws_in' })
    })

    it(`rejects ${repo}.${method} for an out-of-scope workspace (404, no leak)`, async () => {
      // ws_out belongs to OTHER_ACCOUNT; the token is scoped to ACCOUNT only.
      await expect(remoteRegistry()[repo]![method]!('ws_out', ...args)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
  }

  it('still refuses the two reads no rule can bind (cron + mint-side)', async () => {
    // `listStale` (the reconcile cron, cross-tenant) and `listByInstallation` (the delegation
    // mint's own repo-scoping read, unscoped across an installation's workspaces) stay
    // mothership-internal, as does the argument-less cron `listActive`.
    const repos = remoteRegistry()
    await expect(repos.repoProjectionRepository!.listStale!(0)).rejects.toThrow(/not callable/)
    await expect(repos.repoProjectionRepository!.listByInstallation!(11)).rejects.toThrow(
      /not callable/,
    )
    await expect(repos.githubInstallationRepository!.listActive!()).rejects.toThrow(/not callable/)
  })

  // The `installation` rule: a call carrying only an installation id is bound by that binding's
  // own account — its stored `accountId` for an App install, its connector workspace's for a PAT
  // binding (which stores none).
  it('forwards the installation-keyed reads for an in-scope binding', async () => {
    const repos = remoteRegistry()
    await expect(
      repos.githubInstallationRepository!.getByInstallationId!(11),
    ).resolves.toMatchObject({ installationId: 11 })
    await expect(
      repos.githubInstallationRepository!.listWorkspacesForInstallation!(11),
    ).resolves.toEqual(['ws_of_11'])
  })

  it('binds a PAT binding through its connector workspace (it stores no account)', async () => {
    // Installation 22 has `accountId: null` and homes in ws_in. Reading it as out of scope would
    // make every per-workspace PAT connection unreachable from the node that created it.
    await expect(
      remoteRegistry().githubInstallationRepository!.getByInstallationId!(22),
    ).resolves.toMatchObject({ installationId: 22 })
  })

  it('rejects an installation bound to another account (404, no leak)', async () => {
    await expect(
      remoteRegistry().githubInstallationRepository!.getByInstallationId!(33),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects an unknown installation on a POINT read (404)', async () => {
    // Unlike the batched annotation read below, a point read names ONE row: an id with no binding
    // is a caller addressing something no rule can bind.
    await expect(
      remoteRegistry().githubInstallationRepository!.getByInstallationId!(999),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('admits an UNBOUND id in the batched connect-page annotation, but not a foreign one', async () => {
    // "Which of the ids the provider just offered are already connected here" is unanswerable if an
    // unbound id is refused — and an unbound id discloses nothing the caller did not send.
    await expect(
      remoteRegistry().githubInstallationRepository!.listByInstallationIds!([11, 999]),
    ).resolves.toHaveLength(1)
    await expect(
      remoteRegistry().githubInstallationRepository!.listByInstallationIds!([11, 33]),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('refuses the connect/disconnect WRITES outright (admin-tier, not scope-bound)', async () => {
    // `upsert`/`softDelete` are `integrations.manage` in the service layer, and the machine token
    // scopes accounts rather than roles: no scope rule can stand in for the role check the RPC
    // bypasses, so the methods are simply not callable. `not callable` rather than the 404 a scope
    // denial gives, because the refusal is about the METHOD, not about which row was named.
    const repos = remoteRegistry()
    await expect(
      repos.githubInstallationRepository!.upsert!({
        installationId: 777,
        workspaceId: 'ws_in',
        accountId: ACCOUNT,
      }),
    ).rejects.toThrow(/not callable/)
    await expect(repos.githubInstallationRepository!.softDelete!(11, 0)).rejects.toThrow(
      /not callable/,
    )
  })

  // `linkedWorkspaces` binds its CANDIDATE list, not the repo id: the answer is a subset of the
  // input, so an out-of-scope candidate is refused rather than filtered (which would make the read
  // a probe for "which boards link this repo").
  it('forwards linkedWorkspaces for in-scope candidates and refuses a foreign one', async () => {
    await expect(
      remoteRegistry().repoProjectionRepository!.linkedWorkspaces!(42, ['ws_in']),
    ).resolves.toEqual(['ws_in'])
    await expect(
      remoteRegistry().repoProjectionRepository!.linkedWorkspaces!(42, ['ws_in', 'ws_out']),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('binds the sync cursors through their installation', async () => {
    await expect(
      remoteRegistry().repoProjectionRepository!.getCursor!(11, 42, 'pulls'),
    ).resolves.toMatchObject({ installationId: 11 })
    await expect(
      remoteRegistry().repoProjectionRepository!.setCursor!(33, 42, 'pulls', {}),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  // The second opened installation read: the ACCOUNT-scoped list the repo-sourced libraries
  // (fragments / skills) resolve their GitHub credential through. It exists because its global
  // sibling `listActive` can never be exposed — see the refusal asserted just above.
  it('forwards githubInstallationRepository.listActiveForAccount for an in-scope account', async () => {
    const result =
      await remoteRegistry().githubInstallationRepository!.listActiveForAccount!(ACCOUNT)
    expect((result as Array<{ accountId: string }>)[0]).toMatchObject({ accountId: ACCOUNT })
  })

  it('rejects githubInstallationRepository.listActiveForAccount for another account (404)', async () => {
    await expect(
      remoteRegistry().githubInstallationRepository!.listActiveForAccount!(OTHER_ACCOUNT),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})
