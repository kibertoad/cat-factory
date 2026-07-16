import type { Block } from '@cat-factory/contracts'
import { blockSchema, executionInstanceSchema } from '@cat-factory/contracts'
import type { BlockPatch } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import {
  type BlockRow,
  type ExecutionRow,
  blockInsertValues,
  blockPatchToColumns,
  executionToDetail,
  rowToBlock,
  rowToExecution,
  rowToPipeline,
  rowToWorkspace,
} from '../src/persistence/mappers.js'
import { DataIntegrityError } from '../src/persistence/decode.js'

// The row<->domain mappers are shared verbatim by the D1 (SQLite) and Drizzle
// (Postgres) repos, so a bug here breaks BOTH stores identically. These exercise the
// fiddly bits: JSON (de)serialisation, null-vs-omitted optionals, and the
// empty-string-clears-the-selection patch rules.

function fullBlock(): Block {
  return {
    id: 'blk_1',
    title: 'Task',
    type: 'service',
    description: 'do the thing',
    position: { x: 12, y: 34 },
    status: 'in_progress',
    progress: 0.5,
    dependsOn: ['blk_0'],
    executionId: 'exec_1',
    level: 'task',
    parentId: 'blk_parent',
    confidence: 0.9,
    moduleName: 'auth',
    fragmentIds: ['frag_a', 'frag_b'],
    modelId: 'gpt',
    pullRequest: { number: 7, url: 'https://gh/pr/7', branch: 'feat/x' },
    riskPolicyId: 'mp_1',
    pipelineId: 'pl_1',
    agentConfig: { 'playwright.e2eTarget': 'ci' },
    provisioning: { type: 'docker-compose', composePath: 'docker-compose.yml', localDevOnly: true },
    cloudProvider: 'aws',
    instanceSize: 'large',
  } as Block
}

describe('block mappers', () => {
  it('round-trips a fully-populated block through insert → row → domain', () => {
    const block = fullBlock()
    const row = blockInsertValues(block) as unknown as BlockRow
    expect(rowToBlock(row)).toEqual(block)
  })

  it('omits absent optionals (null columns) rather than emitting undefined keys', () => {
    const minimal: Block = {
      id: 'blk_2',
      title: 'Frame',
      type: 'service',
      description: '',
      position: { x: 0, y: 0 },
      status: 'planned',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'frame',
      parentId: null,
    } as Block
    const row = blockInsertValues(minimal) as unknown as BlockRow
    const mapped = rowToBlock(row)
    expect(mapped).toEqual(minimal)
    expect('confidence' in mapped).toBe(false)
    expect('pullRequest' in mapped).toBe(false)
  })

  it('keeps a zero confidence (distinguishes 0 from absent)', () => {
    const row = { ...(blockInsertValues(fullBlock()) as unknown as BlockRow), confidence: 0 }
    expect(rowToBlock(row).confidence).toBe(0)
  })

  it('serialises array/object columns as JSON', () => {
    const values = blockInsertValues(fullBlock())
    expect(values.depends_on).toBe('["blk_0"]')
    expect(values.fragment_ids).toBe('["frag_a","frag_b"]')
    expect(JSON.parse(values.pull_request as string)).toEqual({
      number: 7,
      url: 'https://gh/pr/7',
      branch: 'feat/x',
    })
  })
})

describe('blockPatchToColumns', () => {
  it('is empty for an empty patch (no spurious writes)', () => {
    expect(blockPatchToColumns({})).toEqual({})
  })

  it('splits position into pos_x/pos_y', () => {
    expect(blockPatchToColumns({ position: { x: 1, y: 2 } })).toEqual({ pos_x: 1, pos_y: 2 })
  })

  it('treats an empty string as "clear the selection" for modelId/riskPolicyId/pipelineId', () => {
    expect(blockPatchToColumns({ modelId: '' }).model_id).toBeNull()
    expect(blockPatchToColumns({ modelId: 'gpt' }).model_id).toBe('gpt')
    expect(blockPatchToColumns({ riskPolicyId: '' }).merge_preset_id).toBeNull()
    expect(blockPatchToColumns({ pipelineId: '' }).pipeline_id).toBeNull()
  })

  it('nulls a cleared pullRequest / fragmentIds but JSON-encodes a present one', () => {
    // A PATCH body can carry an explicit `null` to clear these optional fields; the
    // mapper treats any falsy value as "clear" (→ a null column). The `BlockPatch`
    // type only models `T | undefined`, so cast to exercise the runtime clear path.
    expect(
      blockPatchToColumns({ pullRequest: null } as unknown as BlockPatch).pull_request,
    ).toBeNull()
    expect(
      blockPatchToColumns({ fragmentIds: null } as unknown as BlockPatch).fragment_ids,
    ).toBeNull()
    expect(blockPatchToColumns({ fragmentIds: ['a'] }).fragment_ids).toBe('["a"]')
  })

  it('treats an empty serviceFragmentIds array as "clear it" on patch', () => {
    expect(blockPatchToColumns({ serviceFragmentIds: [] }).service_fragment_ids).toBeNull()
    expect(blockPatchToColumns({ serviceFragmentIds: ['f'] }).service_fragment_ids).toBe('["f"]')
  })

  it('clears an empty agentConfig map on patch', () => {
    expect(blockPatchToColumns({ agentConfig: {} }).agent_config).toBeNull()
    expect(blockPatchToColumns({ agentConfig: { 'k.v': 'x' } }).agent_config).toBe('{"k.v":"x"}')
  })

  it('maps the technical tri-state (true→1, false→0, null→null)', () => {
    expect(blockPatchToColumns({ technical: true }).technical).toBe(1)
    expect(blockPatchToColumns({ technical: false }).technical).toBe(0)
    expect(blockPatchToColumns({ technical: null }).technical).toBeNull()
    expect('technical' in blockPatchToColumns({})).toBe(false)
  })

  it('maps boolean-as-int columns (autoStartDependents → 1/null)', () => {
    expect(blockPatchToColumns({ autoStartDependents: true }).auto_start_dependents).toBe(1)
    expect(blockPatchToColumns({ autoStartDependents: false }).auto_start_dependents).toBeNull()
  })
})

describe('block insert/read of the less-common columns', () => {
  it('round-trips the tri-state technical and bool-int / json optional columns', () => {
    for (const technical of [true, false] as const) {
      const block = {
        id: 'blk_3',
        title: 'T',
        type: 'task',
        description: '',
        position: { x: 0, y: 0 },
        status: 'planned',
        progress: 0,
        dependsOn: [],
        executionId: null,
        level: 'task',
        parentId: null,
        epicId: 'epic_1',
        autoStartDependents: true,
        serviceFragmentIds: ['svc_a'],
        modelPresetId: 'mp_1',
        responsibleProductUserId: 'usr_1',
        estimate: { complexity: 0.2, risk: 0.1, impact: 0.3, rationale: 'r' },
        taskType: 'bug',
        taskTypeFields: { severity: 'high' },
        technical,
        trackerCommentOnPrOpen: 'on',
        trackerResolveOnMerge: 'off',
        createdBy: 'usr_1',
      } as unknown as Block
      const row = blockInsertValues(block) as unknown as BlockRow
      expect(row.technical).toBe(technical ? 1 : 0)
      expect(rowToBlock(row)).toEqual(block)
    }
  })

  it('never patches createdBy (insert-only)', () => {
    expect('created_by' in blockPatchToColumns({ createdBy: 'usr_x' } as BlockPatch)).toBe(false)
  })
})

// LEGACY USER-ID REPAIR — these guard the temporary coercion in mappers.ts and would have
// caught the original bug (a pre-#94 numeric `created_by` brought down the whole board load
// because the server ships rows unvalidated and only the SPA validates the snapshot). Delete
// alongside the repair after 2026-07-15.
describe('legacy numeric user ids (pre-#94, repaired on read)', () => {
  function rowWith(overrides: Partial<BlockRow>): BlockRow {
    const minimal: Block = {
      id: 'blk_legacy',
      title: 'Legacy task',
      type: 'service',
      description: '',
      position: { x: 0, y: 0 },
      status: 'done',
      progress: 1,
      dependsOn: [],
      executionId: null,
      level: 'task',
      parentId: null,
      createdBy: 'usr_real',
    } as Block
    return { ...(blockInsertValues(minimal) as unknown as BlockRow), ...overrides }
  }

  it('drops a numeric created_by to absent and keeps the mapped block contract-valid', () => {
    // The exact shape from the field report: a leftover GitHub numeric id in created_by.
    const mapped = rowToBlock(rowWith({ created_by: 1847934 as unknown as string }))
    expect('createdBy' in mapped).toBe(false)
    // The whole point: the mapped block must satisfy the wire contract the SPA validates,
    // so one stale row can no longer reject the entire workspace snapshot.
    expect(() => v.parse(blockSchema, mapped)).not.toThrow()
  })

  it('passes a real string created_by through unchanged', () => {
    expect(rowToBlock(rowWith({ created_by: 'usr_real' })).createdBy).toBe('usr_real')
  })

  it('drops a numeric execution initiatedBy to null and stays contract-valid', () => {
    const row: ExecutionRow = {
      id: 'exec_legacy',
      block_id: 'blk_1',
      status: 'running',
      detail: JSON.stringify({
        pipelineId: 'pl_1',
        pipelineName: 'Quick',
        steps: [],
        currentStep: 0,
        initiatedBy: 1847934,
      }),
      error: null,
      failure: null,
      updated_at: 1,
      workflow_instance_id: null,
    }
    const mapped = rowToExecution(row)
    expect(mapped.initiatedBy).toBeNull()
    expect(() => v.parse(executionInstanceSchema, mapped)).not.toThrow()
  })

  it('drops a failure carrying a removed kind (decision_timeout) and stays contract-valid', () => {
    const row: ExecutionRow = {
      id: 'exec_legacy_fail',
      block_id: 'blk_1',
      status: 'failed',
      detail: JSON.stringify({ pipelineId: 'pl_1', pipelineName: 'Q', steps: [], currentStep: 0 }),
      error: 'decision timed out',
      // Pre-cutoff failure with a kind that is no longer in the contract picklist.
      failure: JSON.stringify({
        kind: 'decision_timeout',
        message: 'decision timed out',
        detail: null,
        hint: null,
        occurredAt: 1,
        lastSubtasks: null,
      }),
      updated_at: 1,
      workflow_instance_id: null,
    }
    const mapped = rowToExecution(row)
    expect(mapped.failure).toBeNull()
    expect(() => v.parse(executionInstanceSchema, mapped)).not.toThrow()
  })

  it('keeps a failure whose kind is still part of the contract', () => {
    const row: ExecutionRow = {
      id: 'exec_ok_fail',
      block_id: 'blk_1',
      status: 'failed',
      detail: JSON.stringify({ pipelineId: 'pl_1', pipelineName: 'Q', steps: [], currentStep: 0 }),
      error: 'boom',
      failure: JSON.stringify({
        kind: 'agent',
        message: 'boom',
        detail: null,
        hint: null,
        occurredAt: 1,
        lastSubtasks: null,
      }),
      updated_at: 1,
      workflow_instance_id: null,
    }
    expect(rowToExecution(row).failure?.kind).toBe('agent')
  })
})

describe('rowToExecution', () => {
  const base: ExecutionRow = {
    id: 'exec_1',
    block_id: 'blk_1',
    status: 'running',
    detail: JSON.stringify({
      pipelineId: 'pl_1',
      pipelineName: 'Quick',
      steps: [{ agentKind: 'coder', state: 'done' }],
      currentStep: 1,
    }),
    error: null,
    failure: null,
    updated_at: 123,
    workflow_instance_id: 'exec_1',
  }

  it('unpacks the detail JSON into the entity', () => {
    const exec = rowToExecution(base)
    expect(exec).toMatchObject({
      id: 'exec_1',
      blockId: 'blk_1',
      pipelineId: 'pl_1',
      pipelineName: 'Quick',
      currentStep: 1,
      status: 'running',
      failure: null,
    })
    expect(exec.steps).toHaveLength(1)
  })

  it('tolerates malformed detail JSON with safe defaults', () => {
    const exec = rowToExecution({ ...base, detail: 'not-json{' })
    expect(exec.steps).toEqual([])
    expect(exec.currentStep).toBe(0)
    expect(exec.pipelineId).toBe('')
  })

  it('rejects a null block_id as corrupt instead of coercing it', () => {
    expect(() => rowToExecution({ ...base, block_id: null })).toThrow(DataIntegrityError)
  })

  it('rejects an out-of-bounds currentStep', () => {
    const detail = JSON.stringify({
      pipelineId: 'pl',
      pipelineName: 'P',
      steps: [],
      currentStep: 3,
    })
    expect(() => rowToExecution({ ...base, detail })).toThrow(DataIntegrityError)
  })

  it('parses a valid failure but ignores garbage / partial shapes', () => {
    const complete = {
      kind: 'agent' as const,
      message: 'boom',
      detail: null,
      hint: null,
      occurredAt: 1,
      lastSubtasks: null,
    }
    const ok = rowToExecution({ ...base, failure: JSON.stringify(complete) })
    expect(ok.failure).toEqual(complete)
    expect(rowToExecution({ ...base, failure: '{bad' }).failure).toBeNull()
    // A known-kind but structurally-incomplete record is dropped: it can't satisfy the wire
    // `agentFailureSchema` (missing occurredAt/detail/hint/lastSubtasks), so surfacing it would
    // fail the SPA's snapshot re-validation.
    expect(
      rowToExecution({ ...base, failure: JSON.stringify({ kind: 'agent', message: 'boom' }) })
        .failure,
    ).toBeNull()
    expect(
      rowToExecution({ ...base, failure: JSON.stringify({ kind: 'agent' }) }).failure,
    ).toBeNull()
  })

  it('defaults the prior-attempts failureHistory to an empty array when absent', () => {
    expect(rowToExecution(base).failureHistory).toEqual([])
  })

  it('round-trips a failure trail through detail and drops legacy/garbage entries', () => {
    const good = {
      kind: 'agent' as const,
      message: 'first crash',
      detail: null,
      hint: null,
      occurredAt: 1,
      lastSubtasks: null,
      // The step the attempt failed at rides through unchanged (attributes the trail per step).
      stepIndex: 2,
    }
    const detail = JSON.stringify({
      pipelineId: 'pl_1',
      pipelineName: 'Quick',
      steps: [],
      currentStep: 0,
      failureHistory: [
        good,
        // A pre-cutoff entry with a removed kind is dropped, not surfaced.
        { kind: 'decision_timeout', message: 'stale', occurredAt: 2 },
        // A structurally-broken entry is dropped too.
        { message: 'no kind' },
        // A known-kind but incomplete record (missing occurredAt/detail/hint/lastSubtasks)
        // is dropped — surfacing it would fail the SPA's snapshot re-validation.
        { kind: 'agent', message: 'partial' },
      ],
    })
    const mapped = rowToExecution({ ...base, detail })
    expect(mapped.failureHistory).toEqual([good])
    expect(() => v.parse(executionInstanceSchema, mapped)).not.toThrow()
  })

  it('executionToDetail persists a non-empty trail and omits an empty one', () => {
    const failure = {
      kind: 'agent' as const,
      message: 'boom',
      detail: null,
      hint: null,
      occurredAt: 1,
      lastSubtasks: null,
    }
    const withTrail = rowToExecution({
      ...base,
      detail: executionToDetail({ ...rowToExecution(base), failureHistory: [failure] }),
    })
    expect(withTrail.failureHistory).toEqual([failure])

    // An empty trail is not written into detail (the key is omitted), so it reads back as [].
    const empty = executionToDetail({ ...rowToExecution(base), failureHistory: [] })
    expect(JSON.parse(empty).failureHistory).toBeUndefined()
  })

  it('defaults the prior-attempts outputHistory to an empty array when absent', () => {
    expect(rowToExecution(base).outputHistory).toEqual([])
  })

  it('round-trips a successful-output trail through detail and drops garbage entries', () => {
    const good = { stepIndex: 1, occurredAt: 5, output: 'the superseded spec', truncated: true }
    const detail = JSON.stringify({
      pipelineId: 'pl_1',
      pipelineName: 'Quick',
      steps: [],
      currentStep: 0,
      outputHistory: [
        good,
        // Structurally-broken entries are dropped, not surfaced (they'd fail the SPA re-validation).
        { stepIndex: 2 },
        { occurredAt: 3, output: 'no index' },
        'nonsense',
      ],
    })
    const mapped = rowToExecution({ ...base, detail })
    expect(mapped.outputHistory).toEqual([good])
    expect(() => v.parse(executionInstanceSchema, mapped)).not.toThrow()

    // executionToDetail persists a non-empty trail and omits an empty one.
    const persisted = executionToDetail({ ...rowToExecution(base), outputHistory: [good] })
    expect(rowToExecution({ ...base, detail: persisted }).outputHistory).toEqual([good])
    expect(JSON.parse(executionToDetail(rowToExecution(base))).outputHistory).toBeUndefined()
  })
})

describe('rowToWorkspace / rowToPipeline', () => {
  it('maps a workspace, defaulting account_id to null', () => {
    expect(rowToWorkspace({ id: 'ws_1', name: 'W', created_at: 5, account_id: null })).toEqual({
      id: 'ws_1',
      name: 'W',
      description: null,
      createdAt: 5,
      accountId: null,
    })
  })

  it('includes gates only when present', () => {
    expect(rowToPipeline({ id: 'pl_1', name: 'P', agent_kinds: '["coder"]', gates: null })).toEqual(
      {
        id: 'pl_1',
        name: 'P',
        agentKinds: ['coder'],
      },
    )
    expect(
      rowToPipeline({ id: 'pl_2', name: 'P', agent_kinds: '["coder"]', gates: '[true,false]' })
        .gates,
    ).toEqual([true, false])
  })

  it('surfaces the truthy flag columns as literal true, omitting them otherwise', () => {
    const on = rowToPipeline({
      id: 'pl_3',
      name: 'P',
      agent_kinds: '["coder"]',
      gates: null,
      archived: 1,
      builtin: true,
      public: 1,
    })
    expect(on.archived).toBe(true)
    expect(on.builtin).toBe(true)
    expect(on.public).toBe(true)

    const off = rowToPipeline({
      id: 'pl_4',
      name: 'P',
      agent_kinds: '["coder"]',
      gates: null,
      archived: null,
      builtin: 0,
      public: null,
    })
    expect('archived' in off).toBe(false)
    expect('builtin' in off).toBe(false)
    expect('public' in off).toBe(false)
  })

  it('keeps a version (including 0) but omits null; passes availability through when set', () => {
    expect(
      rowToPipeline({ id: 'pl_5', name: 'P', agent_kinds: '["coder"]', gates: null, version: 0 })
        .version,
    ).toBe(0)
    expect(
      'version' in
        rowToPipeline({
          id: 'pl_6',
          name: 'P',
          agent_kinds: '["coder"]',
          gates: null,
          version: null,
        }),
    ).toBe(false)
    expect(
      rowToPipeline({
        id: 'pl_7',
        name: 'P',
        agent_kinds: '["coder"]',
        gates: null,
        availability: 'recurring',
      }).availability,
    ).toBe('recurring')
    expect(
      'availability' in
        rowToPipeline({ id: 'pl_8', name: 'P', agent_kinds: '["coder"]', gates: null }),
    ).toBe(false)
  })

  it('parses the many optional JSON columns only when present (snake_case → camelCase)', () => {
    const full = rowToPipeline({
      id: 'pl_9',
      name: 'P',
      agent_kinds: '["coder","tester"]',
      gates: null,
      thresholds: '[0.5]',
      enabled: '[true]',
      follow_ups: '[true]',
      tester_quality: '[{"enabled":true}]',
      step_options: '[{"foo":1}]',
      labels: '["a","b"]',
    })
    expect(full.agentKinds).toEqual(['coder', 'tester'])
    expect(full.thresholds).toEqual([0.5])
    expect(full.enabled).toEqual([true])
    expect(full.followUps).toEqual([true])
    expect(full.testerQuality).toEqual([{ enabled: true }])
    expect(full.stepOptions).toEqual([{ foo: 1 }])
    expect(full.labels).toEqual(['a', 'b'])
    // The absent ones stay off the object entirely.
    const bare = rowToPipeline({ id: 'pl_10', name: 'P', agent_kinds: '[]', gates: null })
    expect('thresholds' in bare).toBe(false)
    expect('followUps' in bare).toBe(false)
    expect('labels' in bare).toBe(false)
  })
})
