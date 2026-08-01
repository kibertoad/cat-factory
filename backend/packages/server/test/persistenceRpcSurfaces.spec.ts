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

// The mothership-mode persistence RPC, SURFACE half: one table per allow-listed surface, each
// asserting that every method it names is forwarded for an in-scope subject and refused (404, no
// leak) for an out-of-scope one — the drift guard that keeps `REMOTE_PERSISTENCE_METHODS` and the
// scope rules honest as new repository methods land. The round-trip mechanics these ride on live
// in `persistenceRpc.spec.ts`; the shared fixtures in `persistenceRpc.harness.ts`.

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
    { repo: 'notificationRepository', method: 'listOpen', args: [] },
    { repo: 'bootstrapJobRepository', method: 'listByWorkspace', args: [] },
    { repo: 'executionRepository', method: 'listRecent', args: [{ limit: 10 }] },
    { repo: 'executionRepository', method: 'exists', args: ['exec_1'] },
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
  const SEED_WRITES: Array<{ repo: string; method: string }> = [
    { repo: 'riskPolicyRepository', method: 'upsert' },
    { repo: 'modelPresetRepository', method: 'upsert' },
  ]
  for (const { repo, method } of SEED_WRITES) {
    it(`forwards ${repo}.${method} for an in-scope workspace`, async () => {
      await expect(
        remoteRegistry()[repo]![method]!('ws_in', { id: 'p_1' }),
      ).resolves.toBeUndefined()
    })

    it(`rejects ${repo}.${method} for an out-of-scope workspace (404)`, async () => {
      await expect(remoteRegistry()[repo]![method]!('ws_out', { id: 'p_1' })).rejects.toMatchObject(
        { code: 'not_found' },
      )
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
    { repo: 'trackerSettingsRepository', method: 'put', args: [{}] },
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
  const UPSERTS = [
    'observabilityConnectionRepository',
    'releaseHealthConfigRepository',
    'incidentEnrichmentConnectionRepository',
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
    // The read BOTH delivery paths make — and the one the run-lifecycle sink makes on a run's
    // terminal emit, where an un-routed method would surface only as a webhook that never fires.
    { repo: 'notificationWebhookRepository', method: 'get', args: [], echoes: true },
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

  it('still refuses a non-allow-listed mount method (real-time fan-out read)', async () => {
    // `listByService` is a mothership-internal fan-out read — absent from the allow-list.
    await expect(
      remoteRegistry().workspaceMountRepository!.listByService!('svc_in'),
    ).rejects.toThrow(/not callable/)
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
    { repo: 'branchProjectionRepository', method: 'listByRepo', args: [42] },
    { repo: 'pullRequestProjectionRepository', method: 'listByWorkspace', args: [] },
    { repo: 'issueProjectionRepository', method: 'listByWorkspace', args: [] },
  ]

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

  it('still refuses the projection WRITE surface (sync ingest / board-linkage stay off)', async () => {
    // `upsertMany` (sync ingest), `setMonorepo` (board-linkage), and the single-repo
    // `get` (repo-write facade) are NOT allow-listed — the mothership owns GitHub sync + writes.
    const repos = remoteRegistry()
    await expect(repos.repoProjectionRepository!.upsertMany!('ws_in', [])).rejects.toThrow(
      /not callable/,
    )
    await expect(repos.repoProjectionRepository!.get!('ws_in', 42)).rejects.toThrow(/not callable/)
    await expect(repos.repoProjectionRepository!.setMonorepo!('ws_in', 42, true)).rejects.toThrow(
      /not callable/,
    )
    // Only `getByWorkspace` on the installation repo is opened — its installationId-keyed reads,
    // token/sync writes, the webhook fan-out, and the cron `listActive` stay off the SPA path.
    await expect(repos.githubInstallationRepository!.getByInstallationId!(42)).rejects.toThrow(
      /not callable/,
    )
    await expect(repos.githubInstallationRepository!.listActive!()).rejects.toThrow(/not callable/)
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

describe('prompt-fragment library management surface (owner-scoped)', () => {
  // The owner-keyed reads bind on an (ownerKind, ownerId) PAIR (the `owner` rule): `workspace`
  // resolves the workspace's account, `account` IS the accountId. `args` are the trailing arguments
  // after the pair. Each is exercised with BOTH owner kinds, in and out of scope.
  const OWNER_READS: Array<{ repo: string; method: string; args: unknown[] }> = [
    { repo: 'promptFragmentRepository', method: 'listByOwner', args: [] },
    { repo: 'promptFragmentRepository', method: 'get', args: ['frag_1'] },
    { repo: 'fragmentSourceRepository', method: 'listByOwner', args: [] },
    { repo: 'fragmentBriefRepository', method: 'listByOwner', args: [] },
  ]

  for (const { repo, method, args } of OWNER_READS) {
    it(`forwards ${repo}.${method} for a workspace owner in scope`, async () => {
      const result = await remoteRegistry()[repo]![method]!('workspace', 'ws_in', ...args)
      const echoed = Array.isArray(result) ? result[0] : result
      expect(echoed).toMatchObject({ ownerKind: 'workspace', ownerId: 'ws_in' })
    })

    it(`forwards ${repo}.${method} for an account owner in scope`, async () => {
      const result = await remoteRegistry()[repo]![method]!('account', ACCOUNT, ...args)
      const echoed = Array.isArray(result) ? result[0] : result
      expect(echoed).toMatchObject({ ownerKind: 'account', ownerId: ACCOUNT })
    })

    it(`rejects ${repo}.${method} for a workspace owner out of scope (404, no leak)`, async () => {
      // ws_out belongs to OTHER_ACCOUNT; the token is scoped to ACCOUNT only.
      await expect(
        remoteRegistry()[repo]![method]!('workspace', 'ws_out', ...args),
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    it(`rejects ${repo}.${method} for an account owner out of scope (404, no leak)`, async () => {
      await expect(
        remoteRegistry()[repo]![method]!('account', OTHER_ACCOUNT, ...args),
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    it(`rejects ${repo}.${method} for an unknown owner kind (fails closed)`, async () => {
      // A kind the rule doesn't recognise can't be scope-bound, so it is refused (never reaches the repo).
      await expect(
        remoteRegistry()[repo]![method]!('user', 'usr_x', ...args),
      ).rejects.toMatchObject({ code: 'not_found' })
    })
  }

  // The `softDelete` (void owner-keyed write): forwards in scope, rejected out of scope.
  it('forwards promptFragmentRepository.softDelete for an in-scope owner', async () => {
    await expect(
      remoteRegistry().promptFragmentRepository!.softDelete!('account', ACCOUNT, 'frag_1', 0),
    ).resolves.toBeUndefined()
  })

  it('rejects promptFragmentRepository.softDelete for an out-of-scope owner (404)', async () => {
    await expect(
      remoteRegistry().promptFragmentRepository!.softDelete!('workspace', 'ws_out', 'frag_1', 0),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  // The generated brief's owner-keyed delete (dropping a removed fragment's derived text).
  it('forwards fragmentBriefRepository.delete for an in-scope owner', async () => {
    await expect(
      remoteRegistry().fragmentBriefRepository!.delete!('account', ACCOUNT, 'frag_1'),
    ).resolves.toBeUndefined()
  })

  it('rejects fragmentBriefRepository.delete for an out-of-scope owner (404)', async () => {
    await expect(
      remoteRegistry().fragmentBriefRepository!.delete!('workspace', 'ws_out', 'frag_1'),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  // The record-based `upsert(record)` binds on the record's `(ownerKind, ownerId)` FIELDS (the
  // `ownerField` rule): a fragment/source row can only ever land under an in-scope owner.
  const UPSERTS = [
    'promptFragmentRepository',
    'fragmentSourceRepository',
    'fragmentBriefRepository',
  ]

  for (const repo of UPSERTS) {
    it(`forwards ${repo}.upsert when the record targets an in-scope workspace owner`, async () => {
      await expect(
        remoteRegistry()[repo]!.upsert!({ ownerKind: 'workspace', ownerId: 'ws_in' }),
      ).resolves.toBeUndefined()
    })

    it(`forwards ${repo}.upsert when the record targets an in-scope account owner`, async () => {
      await expect(
        remoteRegistry()[repo]!.upsert!({ ownerKind: 'account', ownerId: ACCOUNT }),
      ).resolves.toBeUndefined()
    })

    it(`rejects ${repo}.upsert when the record targets an out-of-scope owner (404)`, async () => {
      await expect(
        remoteRegistry()[repo]!.upsert!({ ownerKind: 'workspace', ownerId: 'ws_out' }),
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    it(`rejects ${repo}.upsert when the record has no owner fields (404, fail-closed)`, async () => {
      await expect(remoteRegistry()[repo]!.upsert!({})).rejects.toMatchObject({ code: 'not_found' })
    })

    it(`rejects ${repo}.upsert when the record has an unknown owner kind (404, fail-closed)`, async () => {
      await expect(
        remoteRegistry()[repo]!.upsert!({ ownerKind: 'user', ownerId: 'usr_x' }),
      ).rejects.toMatchObject({ code: 'not_found' })
    })
  }

  it('still refuses the sourceId-keyed sync reads (off the allow-list)', async () => {
    // `promptFragmentRepository.listBySource` + `fragmentSourceRepository.get` are the repo-sync
    // reads the mothership owns — never remotely callable from a mothership node.
    await expect(remoteRegistry().promptFragmentRepository!.listBySource!('src_1')).rejects.toThrow(
      /not callable/,
    )
    await expect(remoteRegistry().fragmentSourceRepository!.get!('src_1')).rejects.toThrow(
      /not callable/,
    )
  })
})

describe('Claude Skills library surface (account- and source-scoped)', () => {
  // Skills live in ONE tier (the account), so the catalog + link reads bind positionally on an
  // accountId (`account`) rather than the fragment library's (ownerKind, ownerId) pair. Each stub
  // echoes the accountId, proving the call reached the bound account.
  const ACCOUNT_METHODS: Array<{ repo: string; method: string; extra?: unknown[] }> = [
    { repo: 'accountSkillRepository', method: 'listByAccount' },
    { repo: 'accountSkillRepository', method: 'get', extra: ['src:sklsrc_in:triage'] },
    { repo: 'accountSkillRepository', method: 'softDelete', extra: ['src:sklsrc_in:triage', 0] },
    { repo: 'skillSourceRepository', method: 'listByAccount' },
  ]

  for (const { repo, method, extra = [] } of ACCOUNT_METHODS) {
    it(`forwards ${repo}.${method} for an in-scope account`, async () => {
      const result = await remoteRegistry()[repo]![method]!(ACCOUNT, ...extra)
      // Reads echo `{ accountId }`; the void `softDelete` forwards without throwing.
      if (result !== undefined && result !== null) {
        expect(Array.isArray(result) ? result[0] : result).toMatchObject({ accountId: ACCOUNT })
      }
    })

    it(`rejects ${repo}.${method} for an out-of-scope account (404, no leak)`, async () => {
      await expect(remoteRegistry()[repo]![method]!(OTHER_ACCOUNT, ...extra)).rejects.toMatchObject(
        { code: 'not_found' },
      )
    })
  }

  // The sync surface: every method carries a source id and nothing else, so the `skillSource` rule
  // resolves the source's owning account server-side. `sklsrc_in` is under ACCOUNT, `sklsrc_out`
  // under OTHER_ACCOUNT, and `sklsrc_missing` does not exist (must fail closed, not 500).
  const SOURCE_METHODS: Array<{ repo: string; method: string; extra?: unknown[] }> = [
    { repo: 'accountSkillRepository', method: 'listBySource' },
    { repo: 'accountSkillRepository', method: 'softDeleteBySource', extra: [0] },
    { repo: 'skillSourceRepository', method: 'get' },
    { repo: 'skillSourceRepository', method: 'updateSyncState', extra: ['abc123', 0] },
    { repo: 'skillSourceRepository', method: 'softDelete', extra: [0] },
  ]

  for (const { repo, method, extra = [] } of SOURCE_METHODS) {
    it(`forwards ${repo}.${method} for a source in an in-scope account`, async () => {
      // The reads resolve a value, the void writes resolve `undefined` — either way, reaching the
      // repo at all (rather than a 404) is the assertion, so a refusal fails by throwing.
      await remoteRegistry()[repo]![method]!('sklsrc_in', ...extra)
    })

    it(`rejects ${repo}.${method} for a source in another account (404, no leak)`, async () => {
      await expect(remoteRegistry()[repo]![method]!('sklsrc_out', ...extra)).rejects.toMatchObject({
        code: 'not_found',
      })
    })

    it(`rejects ${repo}.${method} for a source that does not exist (fails closed)`, async () => {
      await expect(
        remoteRegistry()[repo]![method]!('sklsrc_missing', ...extra),
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    it(`rejects ${repo}.${method} for a non-string source id (fails closed)`, async () => {
      await expect(remoteRegistry()[repo]![method]!(undefined, ...extra)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
  }

  // `accountSkillRepository.upsert(record)` binds on the record's `accountId` FIELD (`accountField`).
  // That is sufficient here because the write conflicts on `(account_id, skill_id)`: the bound
  // account is part of the key, so a foreign `skillId` inserts under the caller's own account.
  it('forwards accountSkillRepository.upsert when the record targets an in-scope account', async () => {
    await expect(
      remoteRegistry().accountSkillRepository!.upsert!({ accountId: ACCOUNT }),
    ).resolves.toBeUndefined()
  })

  it('rejects accountSkillRepository.upsert when the record targets another account (404)', async () => {
    await expect(
      remoteRegistry().accountSkillRepository!.upsert!({ accountId: OTHER_ACCOUNT }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects accountSkillRepository.upsert when the record has no accountId (404, fail-closed)', async () => {
    await expect(remoteRegistry().accountSkillRepository!.upsert!({})).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  // `skillSourceRepository.upsert(record)` takes `accountFieldUpsert` instead, because its write
  // conflicts on the `id` ALONE and never re-`SET`s `account_id` — the row it lands on is chosen by
  // the id, not by the bound account. So BOTH the declared account and the STORED row's account are
  // bound, and a create (no such row yet) passes on the declared half alone.
  describe('skillSourceRepository.upsert binds the stored row, not just the declared account', () => {
    it('forwards a CREATE: an id no row holds yet, under an in-scope account', async () => {
      await expect(
        remoteRegistry().skillSourceRepository!.upsert!({
          id: 'sklsrc_missing',
          accountId: ACCOUNT,
        }),
      ).resolves.toBeUndefined()
    })

    it("forwards an UPDATE of the caller's own existing source", async () => {
      await expect(
        remoteRegistry().skillSourceRepository!.upsert!({ id: 'sklsrc_in', accountId: ACCOUNT }),
      ).resolves.toBeUndefined()
    })

    // The regression this rule exists for. Declaring an in-scope `accountId` satisfies the field
    // check, but the id names ANOTHER account's row — and because the upsert does not re-`SET`
    // `account_id`, forwarding it would repoint that tenant's source at a repo the caller chose,
    // whose `SKILL.md` bodies their next sync folds into their catalog as agent instructions.
    it('rejects an in-scope account claiming ANOTHER account’s source id (404)', async () => {
      await expect(
        remoteRegistry().skillSourceRepository!.upsert!({ id: 'sklsrc_out', accountId: ACCOUNT }),
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    it('rejects a record declaring another account outright (404)', async () => {
      await expect(
        remoteRegistry().skillSourceRepository!.upsert!({
          id: 'sklsrc_out',
          accountId: OTHER_ACCOUNT,
        }),
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    it('rejects a record with no accountId (404, fail-closed)', async () => {
      await expect(
        remoteRegistry().skillSourceRepository!.upsert!({ id: 'sklsrc_in' }),
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    // No usable conflict key ⇒ the record cannot be bound to the row it would write, so it is
    // refused rather than allowed through on the declared half alone.
    it('rejects a record with no id (404, fail-closed)', async () => {
      await expect(
        remoteRegistry().skillSourceRepository!.upsert!({ accountId: ACCOUNT }),
      ).rejects.toMatchObject({ code: 'not_found' })
    })
  })

  it('still refuses the global push-webhook reverse lookup (off the allow-list)', async () => {
    // `listByRepo` spans every account by construction (a push delivery knows a repo, not an
    // account), so no scope rule can bind it — it stays mothership-internal.
    await expect(
      remoteRegistry().skillSourceRepository!.listByRepo!('acme', 'guidelines'),
    ).rejects.toThrow(/not callable/)
  })
})

describe('account onboarding read surface (account-scoped)', () => {
  // The two member-level account reads the SPA's account/members + email-settings panels drive.
  // arg0 is an accountId → the `account` rule (reject out-of-scope as 404). Each stub echoes the
  // accountId, proving the call reached the bound account.
  const READS: Array<{ repo: string; method: string }> = [
    { repo: 'invitationRepository', method: 'listByAccount' },
    { repo: 'emailConnectionRepository', method: 'getByAccount' },
  ]

  for (const { repo, method } of READS) {
    it(`forwards ${repo}.${method} for an in-scope account`, async () => {
      const result = await remoteRegistry()[repo]![method]!(ACCOUNT)
      expect(Array.isArray(result) ? result[0] : result).toMatchObject({ accountId: ACCOUNT })
    })

    it(`rejects ${repo}.${method} for an out-of-scope account (404, no leak)`, async () => {
      await expect(remoteRegistry()[repo]![method]!(OTHER_ACCOUNT)).rejects.toMatchObject({
        code: 'not_found',
      })
    })
  }

  it('still refuses the admin-gated account writes (invite create / email connect off the allow-list)', async () => {
    // `invitationRepository.create` (inviting members) and `emailConnectionRepository.upsert`
    // (connecting a provider) are admin-gated in the service layer; the RPC bypasses `requireAdmin`
    // and the token scopes accounts not roles, so they MUST stay off — never remotely callable.
    await expect(
      remoteRegistry().invitationRepository!.create!({ accountId: ACCOUNT }),
    ).rejects.toThrow(/not callable/)
    await expect(
      remoteRegistry().emailConnectionRepository!.upsert!({ accountId: ACCOUNT }),
    ).rejects.toThrow(/not callable/)
  })
})

describe('Slack integration management surface', () => {
  // Account-scoped methods (arg0 is an accountId → the `account` rule): the per-account connection
  // read/delete + the member-mapping read/write. Each stub echoes the accountId, proving the call
  // reached the bound account; an out-of-scope account is refused 404.
  const ACCOUNT_METHODS: Array<{ repo: string; method: string; extra?: unknown[] }> = [
    { repo: 'slackConnectionRepository', method: 'getByAccount' },
    { repo: 'slackConnectionRepository', method: 'softDelete', extra: [123] },
    { repo: 'slackMemberMappingRepository', method: 'getByAccount' },
    { repo: 'slackMemberMappingRepository', method: 'upsert', extra: [[], 123] },
  ]

  for (const { repo, method, extra = [] } of ACCOUNT_METHODS) {
    it(`forwards ${repo}.${method} for an in-scope account`, async () => {
      const result = await remoteRegistry()[repo]![method]!(ACCOUNT, ...extra)
      // Reads echo `{ accountId }`; the void write (`softDelete`/mapping `upsert`) forwards without throwing.
      if (result !== undefined && result !== null) {
        expect(Array.isArray(result) ? result[0] : result).toMatchObject({ accountId: ACCOUNT })
      }
    })

    it(`rejects ${repo}.${method} for an out-of-scope account (404, no leak)`, async () => {
      await expect(remoteRegistry()[repo]![method]!(OTHER_ACCOUNT, ...extra)).rejects.toMatchObject(
        {
          code: 'not_found',
        },
      )
    })
  }

  // Per-workspace routing settings: `getByWorkspace` (the `workspace` rule) echoes the workspaceId.
  it('forwards slackSettingsRepository.getByWorkspace for an in-scope workspace', async () => {
    expect(await remoteRegistry().slackSettingsRepository!.getByWorkspace!('ws_in')).toMatchObject({
      ws: 'ws_in',
    })
  })
  it('rejects slackSettingsRepository.getByWorkspace for an out-of-scope workspace (404)', async () => {
    await expect(
      remoteRegistry().slackSettingsRepository!.getByWorkspace!('ws_out'),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  // The `workspaceField` record-based `upsert`: binds on the record's `workspaceId` FIELD.
  it('forwards slackSettingsRepository.upsert for an in-scope workspace field', async () => {
    await expect(
      remoteRegistry().slackSettingsRepository!.upsert!({ workspaceId: 'ws_in' }),
    ).resolves.toBeUndefined()
  })
  it('rejects slackSettingsRepository.upsert whose record workspace is out of scope (404)', async () => {
    await expect(
      remoteRegistry().slackSettingsRepository!.upsert!({ workspaceId: 'ws_out' }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  // The new `accountField` rule: the record-based connection `upsert` binds on the record's
  // `accountId` FIELD (checked in scope directly — the account-owned mirror of `workspaceField`).
  it('forwards slackConnectionRepository.upsert for an in-scope account field', async () => {
    await expect(
      remoteRegistry().slackConnectionRepository!.upsert!({ accountId: ACCOUNT, tokenCipher: 'x' }),
    ).resolves.toBeUndefined()
  })
  it('rejects slackConnectionRepository.upsert whose record account is out of scope (404)', async () => {
    await expect(
      remoteRegistry().slackConnectionRepository!.upsert!({ accountId: OTHER_ACCOUNT }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
  it('rejects an accountField upsert with a missing/non-string accountId (404, no crash)', async () => {
    await expect(
      remoteRegistry().slackConnectionRepository!.upsert!({ notAnAccount: true }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  // `getByTeam` is the global inbound-OAuth teamId lookup — mothership-internal, off the allow-list.
  it('still refuses slackConnectionRepository.getByTeam (global teamId lookup, off the allow-list)', async () => {
    await expect(remoteRegistry().slackConnectionRepository!.getByTeam!('T123')).rejects.toThrow(
      /not callable/,
    )
  })
})

describe('spend ledger write surface (usageRecord-scoped)', () => {
  const usage = (over: Record<string, unknown> = {}) => ({
    id: 'usage_1',
    workspaceId: 'ws_in',
    accountId: ACCOUNT,
    userId: USER,
    executionId: 'exec_1',
    agentKind: 'coder',
    provider: 'anthropic',
    model: 'claude',
    inputTokens: 10,
    outputTokens: 5,
    costEstimate: 0.01,
    billing: 'metered',
    vendor: null,
    createdAt: 1000,
    ...over,
  })

  it('forwards a metered row for an in-scope workspace', async () => {
    await expect(remoteRegistry().tokenUsageRepository!.record!(usage())).resolves.toMatchObject({
      workspaceId: 'ws_in',
      accountId: ACCOUNT,
    })
  })

  it('accepts a row whose denormalized account/user are unresolved (null)', async () => {
    // The recorder legitimately writes nulls when a run has no resolvable account or initiator, so
    // the rule must admit them rather than force the node to guess an id.
    await expect(
      remoteRegistry().tokenUsageRepository!.record!(usage({ accountId: null, userId: null })),
    ).resolves.toBeDefined()
  })

  it('rejects a row targeting an out-of-scope workspace (404, no leak)', async () => {
    await expect(
      remoteRegistry().tokenUsageRepository!.record!(
        usage({ workspaceId: 'ws_out', accountId: OTHER_ACCOUNT }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  // The reason this rule exists rather than plain `workspaceField`: the account- and user-tier
  // budget rollups read the DENORMALIZED columns directly, so a row written into the caller's own
  // workspace but STAMPED with someone else's id would inflate a budget the caller has no
  // entitlement to — pausing that account's (or that teammate's) runs.
  it("refuses to stamp another account's id on a row in the caller's own workspace", async () => {
    await expect(
      remoteRegistry().tokenUsageRepository!.record!(usage({ accountId: OTHER_ACCOUNT })),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('refuses to attribute a row to another user', async () => {
    await expect(
      remoteRegistry().tokenUsageRepository!.record!(usage({ userId: 'usr_someone_else' })),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects a non-object / workspace-less row (404, no crash)', async () => {
    await expect(remoteRegistry().tokenUsageRepository!.record!('not-a-row')).rejects.toMatchObject(
      {
        code: 'not_found',
      },
    )
    await expect(
      remoteRegistry().tokenUsageRepository!.record!({ accountId: ACCOUNT }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  // The local-first telemetry bucket's complement: with the store on the laptop, the old remote
  // summarize stopgap is gone rather than left as dead surface.
  it('no longer exposes llmCallMetricRepository.summarizeByExecution (local-first telemetry)', async () => {
    await expect(
      remoteRegistry().llmCallMetricRepository!.summarizeByExecution!('ws_in', 'exec_1'),
    ).rejects.toThrow(/not callable/)
  })
})
