import { describe, expect, it } from 'vitest'
import type { PersistenceRegistry } from '../src/persistence/rpc.js'
import { createRemoteRepositoryRegistry } from '../src/persistence/remoteRepositories.js'
import {
  ACCOUNT,
  inProcessClient,
  makeRegistry,
  OTHER_ACCOUNT,
  remoteRegistry,
  USER,
} from './persistenceRpc.harness.js'

// The mothership-mode persistence RPC, WORKSPACE-SCOPED surface half: one table per allow-listed
// surface, each asserting that every method it names is forwarded for an in-scope subject and
// refused (404, no leak) for an out-of-scope one — the drift guard that keeps
// `REMOTE_PERSISTENCE_METHODS` and the scope rules honest as new repository methods land.
//
// The surfaces bound by a TENANT identity instead (an accountId, a library `(ownerKind, ownerId)`
// pair, or a spend-ledger row's account/user rollup keys) are in
// `persistenceRpcTenantSurfaces.spec.ts`, because what those prove is a cross-ACCOUNT refusal. The
// round-trip mechanics these ride on live in `persistenceRpc.spec.ts`; the shared fixtures in
// `persistenceRpc.harness.ts`.

describe('board-load read surface (workspace-scoped)', () => {
  // Every newly-allow-listed read. `args` are the trailing arguments AFTER the workspaceId
  // (which the helper prepends), so the table reflects each method's real signature.
  const READS: Array<{ repo: string; method: string; args: unknown[] }> = [
    { repo: 'workspaceMountRepository', method: 'listByWorkspace', args: [] },
    { repo: 'workspaceSettingsRepository', method: 'get', args: [] },
    { repo: 'riskPolicyRepository', method: 'list', args: [] },
    { repo: 'modelPresetRepository', method: 'list', args: [] },
    { repo: 'agentPromptRepository', method: 'listHeads', args: [] },
    { repo: 'agentPromptRepository', method: 'listRevisions', args: ['coder'] },
    // The sandbox's batched projection read — it lists the workspace's own prompts for the whole
    // sandbox catalog, so it is on the board-load surface rather than an admin one.
    { repo: 'agentPromptRepository', method: 'listRevisionsByKinds', args: [['coder']] },
    // The run-path read: an unrouted `head` would fail every agent dispatch in mothership mode
    // with `unknown_method`, not merely leave the builder's badges blank.
    { repo: 'agentPromptRepository', method: 'head', args: ['coder'] },
    { repo: 'workspaceAgentSettingsRepository', method: 'list', args: [] },
    // Also a run-path read: an unrouted `get` would fail every agent dispatch in mothership
    // mode with `unknown_method` rather than merely leaving the builder's budget field blank.
    { repo: 'workspaceAgentSettingsRepository', method: 'get', args: ['doc-researcher'] },
    { repo: 'serviceFragmentDefaultsRepository', method: 'get', args: [] },
    { repo: 'pipelineScheduleRepository', method: 'list', args: [] },
    { repo: 'pipelineScheduleRepository', method: 'getByBlock', args: ['blk_1'] },
    { repo: 'trackerSettingsRepository', method: 'get', args: [] },
    { repo: 'workspaceMemberRepository', method: 'listByWorkspace', args: [] },
    { repo: 'kaizenGradingRepository', method: 'get', args: ['grade_1'] },
    { repo: 'notificationRepository', method: 'listOpen', args: [] },
    { repo: 'bootstrapJobRepository', method: 'listByWorkspace', args: [] },
    { repo: 'executionRepository', method: 'listRecent', args: [{ limit: 10 }] },
    { repo: 'executionRepository', method: 'exists', args: ['exec_1'] },
    // The run→block reverse link. It is on the DISPOSAL path of a run whose row cannot be decoded,
    // so an unrouted method would leave a mothership-mode board's card wedged `in_progress` for
    // good, with the run row settled and nothing on screen to say so.
    { repo: 'blockRepository', method: 'getByExecution', args: ['exec_1'] },
    { repo: 'tokenUsageRepository', method: 'totalsSinceForWorkspace', args: [0] },
    { repo: 'requirementReviewRepository', method: 'getByBlock', args: ['blk_1'] },
    { repo: 'clarityReviewRepository', method: 'getByBlock', args: ['blk_1'] },
    {
      repo: 'brainstormSessionRepository',
      method: 'getByBlockStage',
      args: ['blk_1', 'discovery'],
    },
  ]

  for (const { repo, method, args } of READS) {
    it(`forwards ${repo}.${method} for an in-scope workspace`, async () => {
      const result = await remoteRegistry()[repo]![method]!('ws_in', ...args)
      // Each stub echoes the workspaceId, proving the call reached the bound workspace.
      const echoed = Array.isArray(result) ? result[0] : result
      expect(echoed).toMatchObject({ ws: 'ws_in' })
    })

    it(`rejects ${repo}.${method} for an out-of-scope workspace (404, no leak)`, async () => {
      // ws_out belongs to OTHER_ACCOUNT; the token is scoped to ACCOUNT only.
      await expect(remoteRegistry()[repo]![method]!('ws_out', ...args)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
  }

  it('still refuses a non-allow-listed method on an allow-listed board repo', async () => {
    // `deleteByWorkspace` is wired on the fake mount repo but absent from the allow-list.
    await expect(
      remoteRegistry().workspaceMountRepository!.deleteByWorkspace!('ws_in'),
    ).rejects.toThrow(/not callable/)
  })

  // The public API's in-flight concurrency cap. Not in the table above because it returns a
  // NUMBER, not an echoing row — which is also why it is safe: a workspace-scoped SQL COUNT
  // carries no row content across the machine API.
  it('forwards blockRepository.countActiveInternal for an in-scope workspace, and 404s otherwise', async () => {
    await expect(remoteRegistry().blockRepository!.countActiveInternal!('ws_in')).resolves.toBe(3)
    await expect(
      remoteRegistry().blockRepository!.countActiveInternal!('ws_out'),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  // The container-resize child translation. Not in the table above because it takes FOUR args:
  // the point of the round trip is that the numeric delta survives the wire, since a dropped
  // `dx`/`dy` would resize the box and leave its contents behind rather than fail.
  it('forwards blockRepository.shiftChildPositions with its delta, and 404s out of scope', async () => {
    await expect(
      remoteRegistry().blockRepository!.shiftChildPositions!('ws_in', 'blk_auth', -40, -30),
    ).resolves.toEqual({ ws: 'ws_in', parentId: 'blk_auth', dx: -40, dy: -30 })
    await expect(
      remoteRegistry().blockRepository!.shiftChildPositions!('ws_out', 'blk_auth', -40, -30),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  // Run admission control's capacity read, the same COUNT-returns-a-number shape. It sits on the
  // run-START path, so an unrouted method would take every mothership-mode run start down.
  it('forwards executionRepository.countActiveByWorkspace for an in-scope workspace, and 404s otherwise', async () => {
    await expect(
      remoteRegistry().executionRepository!.countActiveByWorkspace!('ws_in'),
    ).resolves.toBe(2)
    await expect(
      remoteRegistry().executionRepository!.countActiveByWorkspace!('ws_out'),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('cross-service + entity-id read surface (board composition)', () => {
  // The `serviceList`-scoped reads: arg0 is `serviceIds[]`, resolved to each service's account.
  const SERVICE_READS: Array<{ repo: string; method: string }> = [
    { repo: 'serviceRepository', method: 'listByIds' },
    { repo: 'blockRepository', method: 'listByServices' },
    { repo: 'executionRepository', method: 'listByServices' },
    { repo: 'bootstrapJobRepository', method: 'listByServices' },
    { repo: 'pipelineScheduleRepository', method: 'listByServices' },
    { repo: 'workspaceMountRepository', method: 'countByServiceIds' },
  ]

  for (const { repo, method } of SERVICE_READS) {
    it(`forwards ${repo}.${method} when every service is in scope`, async () => {
      const result = await remoteRegistry()[repo]![method]!(['svc_in'])
      expect(result).toBeDefined()
    })

    it(`rejects ${repo}.${method} when any service is out of scope (404)`, async () => {
      // svc_out belongs to OTHER_ACCOUNT; one out-of-scope id fails the whole call closed.
      await expect(remoteRegistry()[repo]![method]!(['svc_in', 'svc_out'])).rejects.toMatchObject({
        code: 'not_found',
      })
    })

    it(`rejects ${repo}.${method} for an unknown service id (fails closed)`, async () => {
      // A service that does not resolve cannot be scope-bound, so it is refused (no leak).
      await expect(remoteRegistry()[repo]![method]!(['svc_missing'])).rejects.toMatchObject({
        code: 'not_found',
      })
    })

    it(`allows ${repo}.${method} with an empty list (no service to scope)`, async () => {
      // An empty input is a no-op read; it binds no service, so it is not a scope violation.
      await expect(remoteRegistry()[repo]![method]!([])).resolves.toBeDefined()
    })
  }

  it('forwards serviceRepository.listByAccount for an in-scope account', async () => {
    await expect(
      remoteRegistry().serviceRepository!.listByAccount!(ACCOUNT),
    ).resolves.toMatchObject([{ accountId: ACCOUNT }])
  })

  it('rejects serviceRepository.listByAccount for an out-of-scope account (404)', async () => {
    await expect(
      remoteRegistry().serviceRepository!.listByAccount!(OTHER_ACCOUNT),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects serviceRepository.listByAccount for the null (unscoped) listing', async () => {
    // The auth-disabled `null` org listing must never be reachable over a scoped machine token.
    await expect(remoteRegistry().serviceRepository!.listByAccount!(null)).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  // The account-wide credential floor (`allowInitiatorPat`) is read on the RUN path, so an
  // unrouted read would not merely blank a panel — a mothership node would stop enforcing an
  // account admin's decision that runs may not use members' personal tokens, silently.
  it('forwards accountSettingsRepository.getConfigByAccount for an in-scope account', async () => {
    await expect(
      remoteRegistry().accountSettingsRepository!.getConfigByAccount!(ACCOUNT),
    ).resolves.toMatchObject({ accountId: ACCOUNT })
  })

  it('rejects accountSettingsRepository.getConfigByAccount for another account (404)', async () => {
    await expect(
      remoteRegistry().accountSettingsRepository!.getConfigByAccount!(OTHER_ACCOUNT),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('still refuses accountSettingsRepository.getByAccount — the sealed secrets stay off the wire', async () => {
    // The config read being routable must not drag its sibling along: `getByAccount` returns
    // `secretsCipher`, and the machine token scopes accounts rather than roles, so proxying it
    // would let any account member pull the account's secret blob. Refused client-side by the
    // allow-list (`not callable`) rather than scope-refused server-side, so the request for the
    // secret blob never leaves the node at all.
    await expect(
      remoteRegistry().accountSettingsRepository!.getByAccount!(ACCOUNT),
    ).rejects.toThrow(/not callable/)
  })

  it('forwards workspaceRepository.listByAccount for an in-scope account', async () => {
    await expect(
      remoteRegistry().workspaceRepository!.listByAccount!(ACCOUNT),
    ).resolves.toMatchObject([{ id: 'ws_in', accountId: ACCOUNT }])
  })

  it('rejects workspaceRepository.listByAccount for an out-of-scope account (404)', async () => {
    await expect(
      remoteRegistry().workspaceRepository!.listByAccount!(OTHER_ACCOUNT),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects workspaceRepository.listByAccount for the null (unscoped) listing', async () => {
    // The port types accountId as a string, but the wire does not: a forged null must never
    // bind to "every account", exactly like `serviceRepository.listByAccount` above.
    await expect(remoteRegistry().workspaceRepository!.listByAccount!(null)).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('forwards blockRepository.findById for a block homed in an in-scope workspace', async () => {
    const found = (await remoteRegistry().blockRepository!.findById!('blk_in')) as {
      workspaceId: string
    }
    expect(found.workspaceId).toBe('ws_in')
  })

  it('rejects blockRepository.findById for a block homed out of scope (404)', async () => {
    // blk_out homes in ws_out (OTHER_ACCOUNT).
    await expect(remoteRegistry().blockRepository!.findById!('blk_out')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('rejects blockRepository.findById for an unknown block (fails closed)', async () => {
    await expect(remoteRegistry().blockRepository!.findById!('blk_missing')).rejects.toMatchObject({
      code: 'not_found',
    })
  })
})

describe('agent-context run-path + lazy-seed surface (workspace-scoped)', () => {
  // The reads `AgentContextBuilder` issues for EVERY agent step (linked docs/tasks + the block's
  // provisioned environment), the run-start model-preset read, and the completion notification
  // dedup/raise — plus the workspaceId-trailing args of each. All reuse the `workspace` rule.
  const READS: Array<{ repo: string; method: string; args: unknown[] }> = [
    { repo: 'modelPresetRepository', method: 'getDefault', args: [] },
    { repo: 'documentRepository', method: 'listByBlock', args: ['blk_1'] },
    { repo: 'documentRepository', method: 'get', args: ['notion', 'ext_1'] },
    { repo: 'documentRepository', method: 'getByUrl', args: ['https://example.com/spec'] },
    { repo: 'taskRepository', method: 'listByBlock', args: ['blk_1'] },
    { repo: 'taskRepository', method: 'get', args: ['jira', 'KEY-1'] },
    { repo: 'taskRepository', method: 'getByUrl', args: ['https://example.com/issue'] },
    { repo: 'environmentRegistryRepository', method: 'getByBlock', args: ['blk_1'] },
    { repo: 'environmentRegistryRepository', method: 'get', args: ['env_1'] },
    {
      repo: 'notificationRepository',
      method: 'findOpenByBlock',
      args: ['blk_1', 'pipeline_complete'],
    },
    { repo: 'notificationRepository', method: 'findOpenByType', args: ['platform_health'] },
    { repo: 'notificationRepository', method: 'upsertOpenForBlock', args: [{ id: 'n_1' }] },
    // Block-less raises + inbox act/dismiss/escalate transitions route through `upsert`.
    { repo: 'notificationRepository', method: 'upsert', args: [{ id: 'n_1' }] },
  ]

  for (const { repo, method, args } of READS) {
    it(`forwards ${repo}.${method} for an in-scope workspace`, async () => {
      const result = await remoteRegistry()[repo]![method]!('ws_in', ...args)
      const echoed = Array.isArray(result) ? result[0] : result
      expect(echoed).toMatchObject({ ws: 'ws_in' })
    })

    it(`rejects ${repo}.${method} for an out-of-scope workspace (404, no leak)`, async () => {
      await expect(remoteRegistry()[repo]![method]!('ws_out', ...args)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
  }

  // The lazy default-preset seeds a board load triggers (`*PresetService` ensure-default writes).
  // They return void, so assert they forward in scope and are scope-rejected out of scope.
  const SEED_WRITES: Array<{ repo: string; method: string; arg: unknown }> = [
    { repo: 'riskPolicyRepository', method: 'upsert', arg: { id: 'p_1' } },
    { repo: 'modelPresetRepository', method: 'upsert', arg: { id: 'p_1' } },
    // The BATCHED model-preset seed, whose payload is an array rather than a row: it is the call a
    // first board load actually makes, so an unrouted one fails the load itself.
    { repo: 'modelPresetRepository', method: 'upsertMany', arg: [{ id: 'p_1' }] },
  ]
  for (const { repo, method, arg } of SEED_WRITES) {
    it(`forwards ${repo}.${method} for an in-scope workspace`, async () => {
      await expect(remoteRegistry()[repo]![method]!('ws_in', arg)).resolves.toBeUndefined()
    })

    it(`rejects ${repo}.${method} for an out-of-scope workspace (404)`, async () => {
      await expect(remoteRegistry()[repo]![method]!('ws_out', arg)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
  }
})

describe('kaizen grading read surface (workspace-scoped)', () => {
  // The reads the Kaizen screen drives (`KaizenService.getOverview` / `listForExecution`): the
  // grading history + verified-combo library + a run's per-step gradings. Each takes the
  // workspaceId as arg0 (the `workspace` rule); `args` are the trailing arguments after it.
  const READS: Array<{ repo: string; method: string; args: unknown[] }> = [
    { repo: 'kaizenGradingRepository', method: 'listByWorkspace', args: [200] },
    { repo: 'kaizenGradingRepository', method: 'listByExecution', args: ['ex_1'] },
    { repo: 'kaizenVerifiedComboRepository', method: 'listByWorkspace', args: [] },
  ]

  for (const { repo, method, args } of READS) {
    it(`forwards ${repo}.${method} for an in-scope workspace`, async () => {
      const result = await remoteRegistry()[repo]![method]!('ws_in', ...args)
      expect(Array.isArray(result) ? result[0] : result).toMatchObject({ ws: 'ws_in' })
    })

    it(`rejects ${repo}.${method} for an out-of-scope workspace (404, no leak)`, async () => {
      await expect(remoteRegistry()[repo]![method]!('ws_out', ...args)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
  }
})

describe('settings, preset & schedule management surface (workspace-scoped writes)', () => {
  // The management methods a mothership-mode SPA drives to SAVE settings/presets/schedules (the
  // matching reads were already exposed for the board load). Each takes the workspaceId as arg0
  // and reuses the `workspace` rule; `args` are the trailing arguments after it. Value-returning
  // methods (`echoes: true`) echo the workspaceId so we prove the call reached the bound
  // workspace; void writes just resolve.
  const WRITES: Array<{ repo: string; method: string; args: unknown[]; echoes?: boolean }> = [
    { repo: 'workspaceSettingsRepository', method: 'upsert', args: [{ storeAgentContext: true }] },
    { repo: 'trackerSettingsRepository', method: 'merge', args: [{}, {}, 1], echoes: true },
    { repo: 'serviceFragmentDefaultsRepository', method: 'set', args: [['frag_1']] },
    { repo: 'riskPolicyRepository', method: 'get', args: ['preset_1'], echoes: true },
    { repo: 'riskPolicyRepository', method: 'remove', args: ['preset_1'] },
    { repo: 'modelPresetRepository', method: 'get', args: ['preset_1'], echoes: true },
    { repo: 'modelPresetRepository', method: 'remove', args: ['preset_1'] },
    {
      repo: 'agentPromptRepository',
      method: 'append',
      args: [{ agentKind: 'coder', revision: 1, text: 'be terse', createdAt: 1 }],
    },
    {
      repo: 'workspaceAgentSettingsRepository',
      method: 'upsert',
      args: [{ agentKind: 'doc-researcher', maxOutputTokens: 24000, updatedAt: 1 }],
    },
    { repo: 'workspaceAgentSettingsRepository', method: 'remove', args: ['doc-researcher'] },
    { repo: 'pipelineScheduleRepository', method: 'get', args: ['sched_1'], echoes: true },
    { repo: 'pipelineScheduleRepository', method: 'upsert', args: [{ id: 'sched_1' }] },
    { repo: 'pipelineScheduleRepository', method: 'remove', args: ['sched_1'] },
    { repo: 'pipelineScheduleRepository', method: 'insertRun', args: [{ id: 'run_1' }] },
    {
      repo: 'pipelineScheduleRepository',
      method: 'updateRun',
      args: ['run_1', { status: 'done' }],
    },
    { repo: 'pipelineScheduleRepository', method: 'listRuns', args: ['sched_1'], echoes: true },
  ]

  for (const { repo, method, args, echoes } of WRITES) {
    it(`forwards ${repo}.${method} for an in-scope workspace`, async () => {
      const result = await remoteRegistry()[repo]![method]!('ws_in', ...args)
      if (echoes) {
        const echoed = Array.isArray(result) ? result[0] : result
        expect(echoed).toMatchObject({ ws: 'ws_in' })
      } else {
        expect(result).toBeUndefined()
      }
    })

    it(`rejects ${repo}.${method} for an out-of-scope workspace (404, no leak)`, async () => {
      // ws_out belongs to OTHER_ACCOUNT; the token is scoped to ACCOUNT only.
      await expect(remoteRegistry()[repo]![method]!('ws_out', ...args)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
  }
})

describe('agent-run control surface (retry/stop entry — workspace-scoped)', () => {
  // `AgentRunController` (retry/stop a run) resolves the run's KIND via `getRef(workspaceId, id)`
  // before dispatching to the matching service; it takes the workspaceId as arg0 → the `workspace`
  // rule. Exposing it makes the execution-run retry/stop path functional in mothership mode.
  it('forwards agentRunRepository.getRef for an in-scope workspace', async () => {
    const ref = await remoteRegistry().agentRunRepository!.getRef!('ws_in', 'ex_1')
    // The ref round-trips with its kind, proving the controller can branch on it over the RPC.
    expect(ref).toMatchObject({ ws: 'ws_in', id: 'ex_1', kind: 'execution' })
  })

  it('rejects agentRunRepository.getRef for an out-of-scope workspace (404, no leak)', async () => {
    // ws_out belongs to OTHER_ACCOUNT; the token is scoped to ACCOUNT only.
    await expect(
      remoteRegistry().agentRunRepository!.getRef!('ws_out', 'ex_1'),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('still refuses the sweeper-only agentRunRepository.listStale (off the allow-list)', async () => {
    // `listStale` is wired on the fake repo but sweeper-internal — never remotely callable.
    await expect(remoteRegistry().agentRunRepository!.listStale!(0)).rejects.toThrow(/not callable/)
  })
})

describe('bootstrap / reference-arch / env-config-repair / env-test management surface (workspace-scoped)', () => {
  // The workspace-scoped reads/updates/deletes (arg0 = workspaceId → the `workspace` rule) that
  // make the bootstrap flow (start / board-card poll / retry / stop), the reference-architecture
  // library, and the env-config-repair retry/stop functional in mothership mode. Value-returning
  // methods (`echoes: true`) echo the workspaceId so we prove the call reached the bound workspace;
  // void writes just resolve.
  const WORKSPACE_METHODS: Array<{
    repo: string
    method: string
    args: unknown[]
    echoes?: boolean
  }> = [
    { repo: 'bootstrapJobRepository', method: 'get', args: ['boot_1'], echoes: true },
    { repo: 'bootstrapJobRepository', method: 'update', args: ['boot_1', { status: 'failed' }] },
    { repo: 'referenceArchitectureRepository', method: 'get', args: ['arch_1'], echoes: true },
    { repo: 'referenceArchitectureRepository', method: 'listByWorkspace', args: [], echoes: true },
    { repo: 'referenceArchitectureRepository', method: 'update', args: ['arch_1', { name: 'x' }] },
    { repo: 'referenceArchitectureRepository', method: 'softDelete', args: ['arch_1', 0] },
    { repo: 'envConfigRepairJobRepository', method: 'get', args: ['repair_1'], echoes: true },
    {
      repo: 'envConfigRepairJobRepository',
      method: 'update',
      args: ['repair_1', { status: 'failed' }],
    },
    // The ephemeral-environment self-test run store: the poll/stop reads + the guarded
    // stage patches and the snapshot's in-flight-runs read, all workspaceId-arg0 scoped
    // like the repair jobs.
    { repo: 'environmentTestRunRepository', method: 'get', args: ['envtest_1'], echoes: true },
    {
      repo: 'environmentTestRunRepository',
      method: 'updateIfRunning',
      args: ['envtest_1', { stage: 'tearing_down' }],
    },
    {
      repo: 'environmentTestRunRepository',
      method: 'listRunningByWorkspace',
      args: [],
      echoes: true,
    },
  ]

  for (const { repo, method, args, echoes } of WORKSPACE_METHODS) {
    it(`forwards ${repo}.${method} for an in-scope workspace`, async () => {
      const result = await remoteRegistry()[repo]![method]!('ws_in', ...args)
      if (echoes) {
        const echoed = Array.isArray(result) ? result[0] : result
        expect(echoed).toMatchObject({ ws: 'ws_in' })
      } else {
        expect(result).toBeUndefined()
      }
    })

    it(`rejects ${repo}.${method} for an out-of-scope workspace (404, no leak)`, async () => {
      // ws_out belongs to OTHER_ACCOUNT; the token is scoped to ACCOUNT only.
      await expect(remoteRegistry()[repo]![method]!('ws_out', ...args)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
  }

  // The record-based `insert(record)` methods bind on the job/record's `workspaceId` FIELD (the
  // `workspaceField` rule): the row is stored under exactly `record.workspaceId`, so an
  // out-of-scope workspace in the record is refused before any repo write, and a missing/non-object
  // arg fails closed.
  const INSERTS = [
    'bootstrapJobRepository',
    'referenceArchitectureRepository',
    'envConfigRepairJobRepository',
    'environmentTestRunRepository',
  ]

  for (const repo of INSERTS) {
    it(`forwards ${repo}.insert when the record targets an in-scope workspace`, async () => {
      await expect(
        remoteRegistry()[repo]!.insert!({ workspaceId: 'ws_in' }),
      ).resolves.toBeUndefined()
    })

    it(`rejects ${repo}.insert when the record targets an out-of-scope workspace (404)`, async () => {
      await expect(
        remoteRegistry()[repo]!.insert!({ workspaceId: 'ws_out' }),
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    it(`rejects ${repo}.insert when the record has no workspaceId field (404, fail-closed)`, async () => {
      await expect(remoteRegistry()[repo]!.insert!({})).rejects.toMatchObject({ code: 'not_found' })
    })
  }
})

describe('post-release-health settings surface (observability / release-health / incident)', () => {
  // The workspace-scoped reads/deletes (arg0 = workspaceId → the `workspace` rule). Value-returning
  // methods (`echoes: true`) echo the workspaceId so we prove the call reached the bound workspace;
  // void deletes just resolve.
  const WORKSPACE_METHODS: Array<{
    repo: string
    method: string
    args: unknown[]
    echoes?: boolean
  }> = [
    { repo: 'observabilityConnectionRepository', method: 'get', args: [], echoes: true },
    { repo: 'observabilityConnectionRepository', method: 'delete', args: [] },
    { repo: 'releaseHealthConfigRepository', method: 'getByBlock', args: ['blk_1'], echoes: true },
    { repo: 'releaseHealthConfigRepository', method: 'listByWorkspace', args: [], echoes: true },
    { repo: 'releaseHealthConfigRepository', method: 'delete', args: ['blk_1'] },
    { repo: 'incidentEnrichmentConnectionRepository', method: 'get', args: [], echoes: true },
    { repo: 'incidentEnrichmentConnectionRepository', method: 'delete', args: [] },
    // The per-workspace capability-credential store rides this same shape: sealed blob,
    // workspace-scoped. It is `remote` rather than `local-sqlite` because a RUN resolves
    // it — a mothership-mode node has no `db`, and a credential the operator set on the mothership
    // must reach the dispatch that needs it. `deleteIfRev` is the rev-guarded delete behind the
    // checklist's per-key remove (the stub echoes the workspace; the real method returns a boolean).
    { repo: 'capabilityCredentialRepository', method: 'get', args: [], echoes: true },
    { repo: 'capabilityCredentialRepository', method: 'deleteIfRev', args: [3], echoes: true },
    { repo: 'capabilityCredentialRepository', method: 'delete', args: [] },
    // The MCP OAuth grants ride the same shape one level finer: keyed by (workspace, server), so
    // the server id is an ordinary argument AFTER the workspace the call is scoped on. Same
    // `remote` bucket and the same reason — a dispatch refreshes the token, and a mothership-mode
    // node has no `db` to refresh it in.
    { repo: 'mcpOAuthGrantRepository', method: 'get', args: ['issues'], echoes: true },
    { repo: 'mcpOAuthGrantRepository', method: 'listByWorkspace', args: [], echoes: true },
    { repo: 'mcpOAuthGrantRepository', method: 'delete', args: ['issues'] },
  ]

  for (const { repo, method, args, echoes } of WORKSPACE_METHODS) {
    it(`forwards ${repo}.${method} for an in-scope workspace`, async () => {
      const result = await remoteRegistry()[repo]![method]!('ws_in', ...args)
      if (echoes) {
        const echoed = Array.isArray(result) ? result[0] : result
        expect(echoed).toMatchObject({ ws: 'ws_in' })
      } else {
        expect(result).toBeUndefined()
      }
    })

    it(`rejects ${repo}.${method} for an out-of-scope workspace (404, no leak)`, async () => {
      // ws_out belongs to OTHER_ACCOUNT; the token is scoped to ACCOUNT only.
      await expect(remoteRegistry()[repo]![method]!('ws_out', ...args)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
  }

  // The record-based `upsert(record)` methods bind on the record's `workspaceId` FIELD (the
  // `workspaceField` rule): the write targets exactly `record.workspaceId`, so an out-of-scope
  // workspace in the record is refused before any repo write.
  // The settled-gate projection's engine write rides the same `workspaceField` rule, under a
  // method named `record` rather than `upsert`. It matters more than most: a mothership-mode node
  // runs the gates, so this is the only way a gate outcome reaches the store the dashboard reads.
  it('forwards gateOutcomeRepository.record when the row targets an in-scope workspace', async () => {
    await expect(
      remoteRegistry().gateOutcomeRepository!.record!({ workspaceId: 'ws_in', id: 'ex:0:passed' }),
    ).resolves.toBeUndefined()
  })

  it('rejects gateOutcomeRepository.record when the row targets another account (404)', async () => {
    await expect(
      remoteRegistry().gateOutcomeRepository!.record!({ workspaceId: 'ws_out', id: 'ex:0:passed' }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  for (const [label, arg] of [
    ['no workspaceId field', {}],
    ['null', null],
    ['a non-string primitive', 'not-a-record'],
  ] as const) {
    it(`rejects gateOutcomeRepository.record when the arg has ${label} (404, fail-closed)`, async () => {
      await expect(remoteRegistry().gateOutcomeRepository!.record!(arg)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
  }

  it('keeps the gate projection READ and PRUNE off the machine API', async () => {
    // The account-scoped dashboard read is admin-gated and the prune is the sweep's; only the
    // engine's per-row write crosses.
    for (const method of ['statsSince', 'deleteOlderThan']) {
      await expect(remoteRegistry().gateOutcomeRepository![method]!('acc_in', 0)).rejects.toThrow(
        /not callable/,
      )
    }
  })

  const UPSERTS = [
    'observabilityConnectionRepository',
    'releaseHealthConfigRepository',
    'incidentEnrichmentConnectionRepository',
    'capabilityCredentialRepository',
    'mcpOAuthGrantRepository',
  ]

  for (const repo of UPSERTS) {
    it(`forwards ${repo}.upsert when the record targets an in-scope workspace`, async () => {
      await expect(
        remoteRegistry()[repo]!.upsert!({ workspaceId: 'ws_in' }),
      ).resolves.toBeUndefined()
    })

    it(`rejects ${repo}.upsert when the record targets an out-of-scope workspace (404)`, async () => {
      await expect(
        remoteRegistry()[repo]!.upsert!({ workspaceId: 'ws_out' }),
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    it(`rejects ${repo}.upsert when the record has no workspaceId field (404)`, async () => {
      // A record with no bindable workspaceId cannot be scope-checked, so it fails closed.
      await expect(remoteRegistry()[repo]!.upsert!({})).rejects.toMatchObject({
        code: 'not_found',
      })
    })

    // A non-object arg (null / primitive) has no `workspaceId` to bind, so the `workspaceField`
    // rule must fail closed rather than throw on the property access or reach the repo write.
    for (const [label, arg] of [
      ['null', null],
      ['a non-string primitive', 'not-a-record'],
    ] as const) {
      it(`rejects ${repo}.upsert when the arg is ${label} (404, fail-closed)`, async () => {
        await expect(remoteRegistry()[repo]!.upsert!(arg)).rejects.toMatchObject({
          code: 'not_found',
        })
      })
    }
  }

  it('forwards capabilityCredentialRepository.compareAndSwap for an in-scope workspace and refuses another', async () => {
    // Same `workspaceField` rule as the upserts above, under the rev-guarded method the
    // checklist's per-key save rides. The boolean verdict must survive the hop, because the
    // service's retry loop keys off it.
    await expect(
      remoteRegistry().capabilityCredentialRepository!.compareAndSwap!({ workspaceId: 'ws_in' }, 1),
    ).resolves.toBe(true)
    await expect(
      remoteRegistry().capabilityCredentialRepository!.compareAndSwap!(
        { workspaceId: 'ws_out' },
        1,
      ),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      remoteRegistry().capabilityCredentialRepository!.compareAndSwap!({}, 1),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('environment-connection management surface (workspace-scoped)', () => {
  // Workspace-scoped reads/deletes (arg0 = workspaceId → the `workspace` rule). Value-returning
  // reads (`echoes: true`) echo the workspaceId so we prove the call reached the bound workspace;
  // void deletes just resolve.
  const WORKSPACE_METHODS: Array<{
    repo: string
    method: string
    args: unknown[]
    echoes?: boolean
  }> = [
    { repo: 'environmentConnectionRepository', method: 'listByWorkspace', args: [], echoes: true },
    {
      repo: 'environmentConnectionRepository',
      method: 'getByWorkspaceAndType',
      args: ['kubernetes', null],
      echoes: true,
    },
    {
      repo: 'environmentConnectionRepository',
      method: 'softDelete',
      args: ['kubernetes', null, 1],
    },
    { repo: 'customManifestTypeRepository', method: 'listByWorkspace', args: [], echoes: true },
    { repo: 'customManifestTypeRepository', method: 'remove', args: ['helm-app'] },
    // The reads every delivery path makes on a run's TERMINAL emit, where an un-routed method
    // surfaces only as a webhook that silently never fires (delivery is best-effort, so the
    // refusal is swallowed by design). `list` is the hot one now that a workspace can register
    // several endpoints: all three sinks call it per delivery, so it carries the same round-trip
    // and cross-account-refusal cover as the `get` it replaced on those paths.
    { repo: 'notificationWebhookRepository', method: 'get', args: [], echoes: true },
    { repo: 'notificationWebhookRepository', method: 'list', args: [], echoes: true },
    { repo: 'notificationWebhookRepository', method: 'delete', args: [] },
  ]

  for (const { repo, method, args, echoes } of WORKSPACE_METHODS) {
    it(`forwards ${repo}.${method} for an in-scope workspace`, async () => {
      const result = await remoteRegistry()[repo]![method]!('ws_in', ...args)
      if (echoes) {
        const echoed = Array.isArray(result) ? result[0] : result
        expect(echoed).toMatchObject({ ws: 'ws_in' })
      } else {
        expect(result).toBeUndefined()
      }
    })

    it(`rejects ${repo}.${method} for an out-of-scope workspace (404, no leak)`, async () => {
      // ws_out belongs to OTHER_ACCOUNT; the token is scoped to ACCOUNT only.
      await expect(remoteRegistry()[repo]![method]!('ws_out', ...args)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
  }

  // The record-based `upsert(record)` methods bind on the record's `workspaceId` FIELD (the
  // `workspaceField` rule): a connection / custom-type row can only ever land in an in-scope
  // workspace, and a missing/non-object arg fails closed before any repo write.
  const UPSERTS = ['environmentConnectionRepository', 'customManifestTypeRepository']

  it('forwards notificationWebhookRepository.put for an in-scope workspace and refuses another', async () => {
    // Same `workspaceField` rule as the upserts below, under the method name this repo uses.
    await expect(
      remoteRegistry().notificationWebhookRepository!.put!({ workspaceId: 'ws_in' }),
    ).resolves.toBeUndefined()
    await expect(
      remoteRegistry().notificationWebhookRepository!.put!({ workspaceId: 'ws_out' }),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(remoteRegistry().notificationWebhookRepository!.put!({})).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  for (const repo of UPSERTS) {
    it(`forwards ${repo}.upsert when the record targets an in-scope workspace`, async () => {
      await expect(
        remoteRegistry()[repo]!.upsert!({ workspaceId: 'ws_in' }),
      ).resolves.toBeUndefined()
    })

    it(`rejects ${repo}.upsert when the record targets an out-of-scope workspace (404)`, async () => {
      await expect(
        remoteRegistry()[repo]!.upsert!({ workspaceId: 'ws_out' }),
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    it(`rejects ${repo}.upsert when the record has no workspaceId field (404)`, async () => {
      await expect(remoteRegistry()[repo]!.upsert!({})).rejects.toMatchObject({
        code: 'not_found',
      })
    })

    for (const [label, arg] of [
      ['null', null],
      ['a non-string primitive', 'not-a-record'],
    ] as const) {
      it(`rejects ${repo}.upsert when the arg is ${label} (404, fail-closed)`, async () => {
        await expect(remoteRegistry()[repo]!.upsert!(arg)).rejects.toMatchObject({
          code: 'not_found',
        })
      })
    }
  }
})

describe('advanced review / session management surface (workspace-scoped)', () => {
  // The clarity-review / brainstorm / consensus windows: run + re-read + persist/replace as the
  // window iterates. Every method takes the workspaceId as arg0 (the `upsert(workspaceId, review)`
  // signature carries it positionally → the `workspace` rule). `args` are the trailing arguments
  // after it; value-returning reads (`echoed`) echo the FULL bound arg set so the round-trip can
  // assert every argument reached the repo in order, void writes resolve `undefined`.
  const METHODS: Array<{
    repo: string
    method: string
    args: unknown[]
    // The object a value-returning read echoes back (workspaceId + trailing args), asserting the
    // whole argument list survived the hop in order. Absent → a void write (resolves `undefined`).
    echoed?: Record<string, unknown>
  }> = [
    // requirement-review: getByBlock/get/upsert were exposed earlier; the rev-guarded
    // compareAndSwap + the atomic replaceForBlock complete it.
    {
      repo: 'requirementReviewRepository',
      method: 'get',
      args: ['rev_1'],
      echoed: { ws: 'ws_in', id: 'rev_1' },
    },
    { repo: 'requirementReviewRepository', method: 'upsert', args: [{ id: 'rev_1' }] },
    { repo: 'requirementReviewRepository', method: 'compareAndSwap', args: [{ id: 'rev_1' }] },
    { repo: 'requirementReviewRepository', method: 'replaceForBlock', args: [{ id: 'rev_1' }] },
    // clarity-review (bug-report triage).
    {
      repo: 'clarityReviewRepository',
      method: 'get',
      args: ['rev_1'],
      echoed: { ws: 'ws_in', id: 'rev_1' },
    },
    { repo: 'clarityReviewRepository', method: 'upsert', args: [{ id: 'rev_1' }] },
    { repo: 'clarityReviewRepository', method: 'compareAndSwap', args: [{ id: 'rev_1' }] },
    { repo: 'clarityReviewRepository', method: 'replaceForBlock', args: [{ id: 'rev_1' }] },
    // brainstorm (structured dialogue, keyed by block+stage).
    {
      repo: 'brainstormSessionRepository',
      method: 'get',
      args: ['sess_1'],
      echoed: { ws: 'ws_in', id: 'sess_1' },
    },
    { repo: 'brainstormSessionRepository', method: 'upsert', args: [{ id: 'sess_1' }] },
    { repo: 'brainstormSessionRepository', method: 'compareAndSwap', args: [{ id: 'sess_1' }] },
    {
      repo: 'brainstormSessionRepository',
      method: 'replaceForBlockStage',
      args: [{ id: 'sess_1' }],
    },
    // consensus (multi-strategy orchestration, keyed by run step).
    {
      repo: 'consensusSessionRepository',
      method: 'get',
      args: ['sess_1'],
      echoed: { ws: 'ws_in', id: 'sess_1' },
    },
    {
      repo: 'consensusSessionRepository',
      method: 'getByStep',
      args: ['ex_1', 0],
      echoed: { ws: 'ws_in', executionId: 'ex_1', stepIndex: 0 },
    },
    {
      repo: 'consensusSessionRepository',
      method: 'getByBlock',
      args: ['blk_1'],
      echoed: { ws: 'ws_in', blockId: 'blk_1' },
    },
    { repo: 'consensusSessionRepository', method: 'upsert', args: [{ id: 'sess_1' }] },
    // The consensus-GROUP library: the editor's CRUD plus `listByIds`, which the engine calls on
    // every dispatch of a tiered consensus step.
    {
      repo: 'consensusGroupRepository',
      method: 'list',
      args: [],
      echoed: { ws: 'ws_in' },
    },
    {
      repo: 'consensusGroupRepository',
      method: 'listByIds',
      args: [['cng_1', 'cng_2']],
      echoed: { ws: 'ws_in', ids: ['cng_1', 'cng_2'] },
    },
    {
      repo: 'consensusGroupRepository',
      method: 'get',
      args: ['cng_1'],
      echoed: { ws: 'ws_in', id: 'cng_1' },
    },
    { repo: 'consensusGroupRepository', method: 'upsert', args: [{ id: 'cng_1' }] },
    { repo: 'consensusGroupRepository', method: 'remove', args: ['cng_1'] },
  ]

  for (const { repo, method, args, echoed } of METHODS) {
    it(`forwards ${repo}.${method} for an in-scope workspace`, async () => {
      const result = await remoteRegistry()[repo]![method]!('ws_in', ...args)
      if (echoed) {
        // Assert the FULL bound arg set round-tripped (workspaceId + every trailing arg in order),
        // not just that the call was authorized — a read that dropped or reordered an arg would
        // slip past a bare `{ ws }` check.
        expect(Array.isArray(result) ? result[0] : result).toMatchObject(echoed)
      } else {
        expect(result).toBeUndefined()
      }
    })

    it(`rejects ${repo}.${method} for an out-of-scope workspace (404, no leak)`, async () => {
      // ws_out belongs to OTHER_ACCOUNT; the token is scoped to ACCOUNT only.
      await expect(remoteRegistry()[repo]![method]!('ws_out', ...args)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
  }

  // A void write resolves `undefined`, so the loop above can't see WHAT reached the repo. Drive a
  // capturing registry to prove the write path forwards the workspaceId + payload (and, for the
  // block+stage delete, every positional key) in order across the round-trip — the write-path
  // analogue of the `echoed` reads above.
  it('forwards the workspaceId + payload to a write in order', async () => {
    const calls: unknown[][] = []
    const { registry, ...resolvers } = makeRegistry()
    const capturing: PersistenceRegistry = {
      ...registry,
      consensusSessionRepository: {
        ...registry.consensusSessionRepository,
        upsert: async (...a: unknown[]) => void calls.push(a),
      },
      brainstormSessionRepository: {
        ...registry.brainstormSessionRepository,
        replaceForBlockStage: async (...a: unknown[]) => void calls.push(a),
      },
    }
    const client = inProcessClient({
      registry: capturing,
      ...resolvers,
      scope: { accountIds: [ACCOUNT], userId: USER },
    })
    const remote = createRemoteRepositoryRegistry(client) as unknown as Record<
      string,
      Record<string, (...args: unknown[]) => Promise<unknown>>
    >

    await remote.consensusSessionRepository!.upsert!('ws_in', { id: 'sess_1' })
    await remote.brainstormSessionRepository!.replaceForBlockStage!('ws_in', { id: 'sess_1' })

    expect(calls).toContainEqual(['ws_in', { id: 'sess_1' }])
    expect(calls.filter((c) => c[0] === 'ws_in')).toHaveLength(2)
  })
})

describe('self-hosted runner-backend connection surface (workspace-scoped)', () => {
  // The runner-pool settings panel's connect/rotate/disconnect (`RunnerPoolConnectionService`):
  // `getByWorkspace`/`softDelete` take the workspaceId as arg0 (the `workspace` rule); the
  // record-based `upsert(record)` binds on the record's `workspaceId` FIELD (the `workspaceField`
  // rule). The credentials ride a sealed `secretsCipher` blob, so no plaintext crosses the API.
  const WORKSPACE_METHODS: Array<{ method: string; args: unknown[]; echoes?: boolean }> = [
    { method: 'getByWorkspace', args: [], echoes: true },
    { method: 'softDelete', args: [0] },
  ]

  for (const { method, args, echoes } of WORKSPACE_METHODS) {
    it(`forwards runnerPoolConnectionRepository.${method} for an in-scope workspace`, async () => {
      const result = await remoteRegistry().runnerPoolConnectionRepository![method]!(
        'ws_in',
        ...args,
      )
      if (echoes) expect(result).toMatchObject({ ws: 'ws_in' })
      else expect(result).toBeUndefined()
    })

    it(`rejects runnerPoolConnectionRepository.${method} for an out-of-scope workspace (404)`, async () => {
      await expect(
        remoteRegistry().runnerPoolConnectionRepository![method]!('ws_out', ...args),
      ).rejects.toMatchObject({ code: 'not_found' })
    })
  }

  it('forwards runnerPoolConnectionRepository.upsert when the record targets an in-scope workspace', async () => {
    await expect(
      remoteRegistry().runnerPoolConnectionRepository!.upsert!({ workspaceId: 'ws_in' }),
    ).resolves.toBeUndefined()
  })

  it('rejects runnerPoolConnectionRepository.upsert when the record targets an out-of-scope workspace (404)', async () => {
    await expect(
      remoteRegistry().runnerPoolConnectionRepository!.upsert!({ workspaceId: 'ws_out' }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects runnerPoolConnectionRepository.upsert when the record has no workspaceId field (404)', async () => {
    await expect(
      remoteRegistry().runnerPoolConnectionRepository!.upsert!({}),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('binary-artifact metadata surface (visual-confirmation gate, workspace-scoped)', () => {
  // The artifact controllers + visual-confirmation gate reads (`ArtifactController` /
  // `HarnessArtifactController`). Point reads/deletes take the workspaceId as arg0 (the `workspace`
  // rule); `args` are the trailing arguments after it. Value-returning reads (`echoes: true`) echo
  // the workspaceId (an object or an array of one); the numeric `countByExecution` and the void
  // `delete` are asserted separately below.
  const WORKSPACE_METHODS: Array<{ method: string; args: unknown[] }> = [
    { method: 'get', args: ['art_1'] },
    { method: 'listByExecution', args: ['ex_1'] },
    { method: 'listByBlock', args: ['blk_1'] },
  ]

  for (const { method, args } of WORKSPACE_METHODS) {
    it(`forwards binaryArtifactMetadataStore.${method} for an in-scope workspace`, async () => {
      const result = await remoteRegistry().binaryArtifactMetadataStore![method]!('ws_in', ...args)
      expect(Array.isArray(result) ? result[0] : result).toMatchObject({ ws: 'ws_in' })
    })

    it(`rejects binaryArtifactMetadataStore.${method} for an out-of-scope workspace (404, no leak)`, async () => {
      await expect(
        remoteRegistry().binaryArtifactMetadataStore![method]!('ws_out', ...args),
      ).rejects.toMatchObject({ code: 'not_found' })
    })
  }

  it('forwards binaryArtifactMetadataStore.countByExecution (numeric result) for an in-scope workspace', async () => {
    await expect(
      remoteRegistry().binaryArtifactMetadataStore!.countByExecution!('ws_in', 'ex_1'),
    ).resolves.toBe(0)
  })

  it('forwards binaryArtifactMetadataStore.delete (void) for an in-scope workspace', async () => {
    await expect(
      remoteRegistry().binaryArtifactMetadataStore!.delete!('ws_in', 'art_1'),
    ).resolves.toBeUndefined()
  })

  it('rejects binaryArtifactMetadataStore.delete for an out-of-scope workspace (404)', async () => {
    await expect(
      remoteRegistry().binaryArtifactMetadataStore!.delete!('ws_out', 'art_1'),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  // The record-based `insert(record)` binds on the record's `workspaceId` FIELD (the
  // `workspaceField` rule): a metadata row can only ever land in an in-scope workspace.
  it('forwards binaryArtifactMetadataStore.insert when the record targets an in-scope workspace', async () => {
    await expect(
      remoteRegistry().binaryArtifactMetadataStore!.insert!({ workspaceId: 'ws_in' }),
    ).resolves.toBeUndefined()
  })

  it('rejects binaryArtifactMetadataStore.insert when the record targets an out-of-scope workspace (404)', async () => {
    await expect(
      remoteRegistry().binaryArtifactMetadataStore!.insert!({ workspaceId: 'ws_out' }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('still refuses the sweeper-only retention reads (listOlderThan off the allow-list)', async () => {
    // `listOlderThan`/`deleteOlderThan` are the retention sweep — mothership-internal, never remote.
    await expect(
      remoteRegistry().binaryArtifactMetadataStore!.listOlderThan!('ws_in', 0),
    ).rejects.toThrow(/not callable/)
  })
})

describe('service board-composition read surface (blockList-scoped)', () => {
  // `serviceRepository.listByFrameBlocks(frameBlockIds)` binds via the `blockList` scope kind: arg0
  // is an array of frame BLOCK ids, each resolved to its home workspace's account server-side
  // (block → workspace → account). blk_in homes in ws_in (ACCOUNT); blk_out in ws_out
  // (OTHER_ACCOUNT). EVERY id must resolve in-scope, so a missing/out-of-scope frame fails closed.
  it('forwards listByFrameBlocks when every frame block is in scope', async () => {
    const result = (await remoteRegistry().serviceRepository!.listByFrameBlocks!([
      'blk_in',
    ])) as Array<{ frameBlockId: string }>
    expect(result[0]).toMatchObject({ frameBlockId: 'blk_in' })
  })

  it('rejects listByFrameBlocks when any frame block is out of scope (404)', async () => {
    await expect(
      remoteRegistry().serviceRepository!.listByFrameBlocks!(['blk_in', 'blk_out']),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects listByFrameBlocks for an unknown frame block (fails closed)', async () => {
    await expect(
      remoteRegistry().serviceRepository!.listByFrameBlocks!(['blk_missing']),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('allows listByFrameBlocks with an empty list (no block to scope)', async () => {
    await expect(remoteRegistry().serviceRepository!.listByFrameBlocks!([])).resolves.toBeDefined()
  })
})

describe('document / task integration surface (workspace-scoped)', () => {
  // The half of both integrations that used to be mothership-internal: the import/link WRITE path,
  // the role-link management surface, the per-workspace source toggle, and the source CONNECTIONS.
  //
  // The connections are the load-bearing entry. They were not pending for want of a scope rule —
  // the repository decrypted INSIDE, so proxying `getByWorkspace` would have put a plaintext Jira
  // token on the wire, and no `/internal/secrets/unseal` entry could name them either (a
  // decrypt-inside repository exposes no sealed field to address). The row now carries its
  // `credentialsCipher`, which is what these assertions ride on: only ciphertext crosses, exactly
  // as it does for the environment / observability / Slack / runner-pool connections.
  const WORKSPACE_METHODS: Array<{
    repo: string
    method: string
    args: unknown[]
    echoes?: boolean
  }> = [
    // Documents: the batched context read, the whole-workspace list, and the link writes. The
    // batched `linkBlockMany`/`detachBlocks` ride with `linkBlock` because they are the same
    // write — a task created with a list of documents, and the block-delete cascade that undoes it.
    { repo: 'documentRepository', method: 'listByRefs', args: [[]], echoes: true },
    { repo: 'documentRepository', method: 'listByWorkspace', args: [], echoes: true },
    { repo: 'documentRepository', method: 'linkBlock', args: ['notion', 'ext_1', 'blk_1'] },
    { repo: 'documentRepository', method: 'linkBlockMany', args: [[], 'blk_1'] },
    { repo: 'documentRepository', method: 'detachBlocks', args: [['blk_1']] },
    // The WS1 role links, whose run-path read halves were already remote.
    { repo: 'documentRepository', method: 'getRoleLink', args: ['template', 'prd'], echoes: true },
    {
      repo: 'documentRepository',
      method: 'listRoleLinks',
      args: ['exemplar', 'prd'],
      echoes: true,
    },
    { repo: 'documentRepository', method: 'listRoleLinksByWorkspace', args: [], echoes: true },
    { repo: 'documentRepository', method: 'setRole', args: ['notion', 'ext_1', 'template', 'prd'] },
    { repo: 'documentRepository', method: 'clearRole', args: ['notion', 'ext_1'] },
    { repo: 'documentRepository', method: 'clearRoleForKind', args: ['template', 'prd'] },
    {
      repo: 'documentConnectionRepository',
      method: 'getByWorkspace',
      args: ['figma'],
      echoes: true,
    },
    { repo: 'documentConnectionRepository', method: 'listByWorkspace', args: [], echoes: true },
    { repo: 'documentConnectionRepository', method: 'softDelete', args: ['figma', 1] },
    // Tasks: the import + link writes. `claimBlockLink` is the atomic one-task-per-ticket claim,
    // which only means anything alongside the `upsert` that imports the issue it claims.
    { repo: 'taskRepository', method: 'listByRefs', args: [[]], echoes: true },
    { repo: 'taskRepository', method: 'listByWorkspace', args: [], echoes: true },
    { repo: 'taskRepository', method: 'linkBlock', args: ['jira', 'KEY-1', 'blk_1'] },
    { repo: 'taskRepository', method: 'claimBlockLink', args: ['jira', 'KEY-1', 'blk_1'] },
    { repo: 'taskRepository', method: 'unlinkAllFromBlock', args: ['blk_1'] },
    { repo: 'taskRepository', method: 'unlinkAllFromBlocks', args: [['blk_1']] },
    { repo: 'taskConnectionRepository', method: 'getByWorkspace', args: ['jira'], echoes: true },
    { repo: 'taskConnectionRepository', method: 'listByWorkspace', args: [], echoes: true },
    { repo: 'taskConnectionRepository', method: 'softDelete', args: ['jira', 1] },
    { repo: 'taskSourceSettingsRepository', method: 'getByWorkspace', args: [], echoes: true },
    { repo: 'taskSourceSettingsRepository', method: 'get', args: ['jira'], echoes: true },
  ]

  for (const { repo, method, args, echoes } of WORKSPACE_METHODS) {
    it(`forwards ${repo}.${method} for an in-scope workspace`, async () => {
      const result = await remoteRegistry()[repo]![method]!('ws_in', ...args)
      if (echoes) {
        const echoed = Array.isArray(result) ? result[0] : result
        expect(echoed).toMatchObject({ ws: 'ws_in' })
      } else {
        expect(result).toBeUndefined()
      }
    })

    it(`rejects ${repo}.${method} for an out-of-scope workspace (404, no leak)`, async () => {
      await expect(remoteRegistry()[repo]![method]!('ws_out', ...args)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
  }

  // The record-based writes bind on the record's `workspaceId` FIELD (`workspaceField`), so an
  // imported document, a filed issue, a connection or a source toggle can only ever land in an
  // in-scope workspace, and a missing/non-object arg fails closed before any repo write.
  const UPSERTS = [
    'documentRepository',
    'documentConnectionRepository',
    'taskRepository',
    'taskConnectionRepository',
    'taskSourceSettingsRepository',
  ]

  for (const repo of UPSERTS) {
    it(`forwards ${repo}.upsert when the record targets an in-scope workspace`, async () => {
      await expect(
        remoteRegistry()[repo]!.upsert!({ workspaceId: 'ws_in' }),
      ).resolves.toBeUndefined()
    })

    it(`rejects ${repo}.upsert when the record targets an out-of-scope workspace (404)`, async () => {
      await expect(
        remoteRegistry()[repo]!.upsert!({ workspaceId: 'ws_out' }),
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    for (const [label, arg] of [
      ['no workspaceId field', {}],
      ['null', null],
      ['a non-record primitive', 'not-a-record'],
    ] as const) {
      it(`rejects ${repo}.upsert when the arg is ${label} (404, fail-closed)`, async () => {
        await expect(remoteRegistry()[repo]!.upsert!(arg)).rejects.toMatchObject({
          code: 'not_found',
        })
      })
    }
  }
})

describe('parked-review question writeback markers (workspaceField-scoped)', () => {
  // `IssueWritebackService.postReviewQuestions` claims one marker per `(workspace, review,
  // iteration, linked issue)` BEFORE posting, so a replaying durable driver cannot comment the same
  // findings onto the reporter's issue twice. The ENGINE writes it, so a mothership-mode node
  // reaches it on the run path; every method takes the KEY as arg0, whose `workspaceId` is a FIELD.
  const key = (workspaceId: string) => ({
    workspaceId,
    reviewId: 'rev_1',
    iteration: 2,
    issueRef: 'github:acme/api#42',
  })
  const WINDOW = { now: 1_000, reclaimPendingBefore: 0 }
  const CALLS: Array<{ method: string; extra: unknown[] }> = [
    { method: 'claim', extra: [WINDOW] },
    { method: 'settle', extra: [{ status: 'posted' }, 1_000] },
    { method: 'get', extra: [] },
  ]

  for (const { method, extra } of CALLS) {
    it(`forwards ${method} when the key targets an in-scope workspace`, async () => {
      // `claim` echoes the bound workspace through its boolean and `get` echoes the whole key, so
      // this proves the marker the repo saw is the one the caller named — not merely that the call
      // was admitted.
      const result = await remoteRegistry().reviewQuestionPostRepository![method]!(
        key('ws_in'),
        ...extra,
      )
      if (method === 'claim') expect(result).toBe(true)
      if (method === 'get') expect(result).toMatchObject({ workspaceId: 'ws_in', iteration: 2 })
    })

    it(`rejects ${method} when the key targets an out-of-scope workspace (404, no leak)`, async () => {
      await expect(
        remoteRegistry().reviewQuestionPostRepository![method]!(key('ws_out'), ...extra),
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    for (const [label, arg] of [
      ['no workspaceId field', { reviewId: 'rev_1' }],
      ['null', null],
      ['a non-record primitive', 'not-a-record'],
    ] as const) {
      it(`rejects ${method} when the key is ${label} (404, fail-closed)`, async () => {
        await expect(
          remoteRegistry().reviewQuestionPostRepository![method]!(arg, ...extra),
        ).rejects.toMatchObject({ code: 'not_found' })
      })
    }
  }

  it('still refuses the INBOUND tracker-comment ingest markers (off the allow-list)', async () => {
    // The mirror-image surface, and the reason it is a permanent exclusion rather than a backlog
    // item: a tracker comment reaches the deployment holding the public webhook URL, so a laptop
    // never receives a delivery and has nothing to claim.
    await expect(
      remoteRegistry().trackerCommentIngestRepository!.claim!({ workspaceId: 'ws_in' }),
    ).rejects.toThrow(/not callable/)
  })
})
