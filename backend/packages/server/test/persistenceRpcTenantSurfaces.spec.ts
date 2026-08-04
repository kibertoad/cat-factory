import { describe, expect, it } from 'vitest'
import { ACCOUNT, OTHER_ACCOUNT, remoteRegistry, USER } from './persistenceRpc.harness.js'

// The mothership-mode persistence RPC, TENANT-SCOPED surface half: the surfaces whose scope rule
// binds a tenant identity rather than a workspace alone — an accountId (`account`), a library
// row's `(ownerKind, ownerId)` pair (`owner` / `ownerField`), or the denormalized account/user
// rollup keys a spend-ledger row carries (`usageRecord`). What each table proves is therefore a
// CROSS-ACCOUNT refusal, and the owner-pair ones prove it for BOTH owner kinds.
//
// The workspace-scoped surfaces are in `persistenceRpcSurfaces.spec.ts`, the round-trip mechanics
// in `persistenceRpc.spec.ts`, and the shared fixtures in `persistenceRpc.harness.ts`.

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

describe('foundational-services catalog surface (owner-scoped)', () => {
  // The tiered catalog a mothership-mode architect resolves and its coder reads contracts from
  // (backend/docs/adr/0031-foundational-services.md). Same (ownerKind, ownerId) pair as the fragment
  // library above, so the same `owner` / `ownerField` rules bind it — and the same three
  // properties are what matter: the pair reaches the repo intact, another tenant's catalog is a
  // 404 rather than a leak, and the sync surface stays uncallable.
  const OWNER_READS: Array<{ repo: string; method: string; args: unknown[] }> = [
    { repo: 'foundationalServiceRepository', method: 'listByOwner', args: [] },
    { repo: 'foundationalServiceRepository', method: 'get', args: ['file-storage'] },
    { repo: 'apiContractRepository', method: 'listManifestByOwner', args: [] },
    { repo: 'apiContractRepository', method: 'listByServiceIds', args: [['file-storage']] },
    { repo: 'foundationalServiceSourceRepository', method: 'listByOwner', args: [] },
  ]

  for (const { repo, method, args } of OWNER_READS) {
    it(`forwards ${repo}.${method} for a workspace owner in scope`, async () => {
      const result = await remoteRegistry()[repo]![method]!('workspace', 'ws_in', ...args)
      const echoed = Array.isArray(result) ? result[0] : result
      expect(echoed).toMatchObject({ ownerKind: 'workspace', ownerId: 'ws_in' })
    })

    it(`rejects ${repo}.${method} for a workspace owner out of scope (404, no leak)`, async () => {
      await expect(
        remoteRegistry()[repo]![method]!('workspace', 'ws_out', ...args),
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    it(`rejects ${repo}.${method} for an account owner out of scope (404, no leak)`, async () => {
      await expect(
        remoteRegistry()[repo]![method]!('account', OTHER_ACCOUNT, ...args),
      ).rejects.toMatchObject({ code: 'not_found' })
    })
  }

  // The owner-keyed WRITES the management surface drives, including `hardDelete` — the one that
  // lifts a board's suppression of an inherited account service. Without it a mothership-mode
  // board could opt out of an org-wide service with no way back in.
  const OWNER_WRITES: Array<{ repo: string; method: string; args: unknown[] }> = [
    { repo: 'foundationalServiceRepository', method: 'softDelete', args: ['file-storage', 0] },
    { repo: 'foundationalServiceRepository', method: 'hardDelete', args: ['file-storage'] },
    { repo: 'apiContractRepository', method: 'replaceForService', args: ['file-storage', []] },
    { repo: 'apiContractRepository', method: 'deleteForService', args: ['file-storage'] },
  ]

  for (const { repo, method, args } of OWNER_WRITES) {
    it(`forwards ${repo}.${method} for an in-scope owner`, async () => {
      await expect(
        remoteRegistry()[repo]![method]!('account', ACCOUNT, ...args),
      ).resolves.toBeUndefined()
    })

    it(`rejects ${repo}.${method} for an out-of-scope owner (404)`, async () => {
      await expect(
        remoteRegistry()[repo]![method]!('workspace', 'ws_out', ...args),
      ).rejects.toMatchObject({ code: 'not_found' })
    })
  }

  it('rejects a catalog upsert whose record targets an out-of-scope owner (404)', async () => {
    await expect(
      remoteRegistry().foundationalServiceRepository!.upsert!({
        ownerKind: 'workspace',
        ownerId: 'ws_out',
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('forwards a catalog upsert whose record targets an in-scope owner', async () => {
    await expect(
      remoteRegistry().foundationalServiceRepository!.upsert!({
        ownerKind: 'account',
        ownerId: ACCOUNT,
      }),
    ).resolves.toBeUndefined()
  })

  it('still refuses the sync surface (source- and repo-keyed, off the allow-list)', async () => {
    // These carry no (ownerKind, ownerId) pair for a rule to bind and back work a mothership node
    // cannot do anyway: the resync fan-outs and the push-webhook repo lookup.
    const repos = remoteRegistry()
    await expect(repos.foundationalServiceRepository!.listBySource!('fndsrc_1')).rejects.toThrow(
      /not callable/,
    )
    await expect(
      repos.foundationalServiceRepository!.softDeleteBySource!('fndsrc_1', 0),
    ).rejects.toThrow(/not callable/)
    await expect(
      repos.foundationalServiceSourceRepository!.listByRepo!('acme', 'contracts'),
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
