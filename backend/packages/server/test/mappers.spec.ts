import type { Block } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import {
  type BlockRow,
  type ExecutionRow,
  blockInsertValues,
  blockPatchToColumns,
  rowToBlock,
  rowToExecution,
  rowToPipeline,
  rowToWorkspace,
} from '../src/persistence/mappers.js'

// The row<->domain mappers are shared verbatim by the D1 (SQLite) and Drizzle
// (Postgres) repos, so a bug here breaks BOTH stores identically. These exercise the
// fiddly bits: JSON (de)serialisation, null-vs-omitted optionals, and the
// empty-string-clears-the-selection patch rules.

function fullBlock(): Block {
  return {
    id: 'blk_1',
    title: 'Task',
    type: 'task',
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
    testTarget: 'unit',
    pullRequest: { number: 7, url: 'https://gh/pr/7', branch: 'feat/x' },
    mergePresetId: 'mp_1',
    pipelineId: 'pl_1',
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
      status: 'todo',
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

  it('treats an empty string as "clear the selection" for modelId/mergePresetId/pipelineId', () => {
    expect(blockPatchToColumns({ modelId: '' }).model_id).toBeNull()
    expect(blockPatchToColumns({ modelId: 'gpt' }).model_id).toBe('gpt')
    expect(blockPatchToColumns({ mergePresetId: '' }).merge_preset_id).toBeNull()
    expect(blockPatchToColumns({ pipelineId: '' }).pipeline_id).toBeNull()
  })

  it('nulls a cleared pullRequest / fragmentIds but JSON-encodes a present one', () => {
    expect(blockPatchToColumns({ pullRequest: null }).pull_request).toBeNull()
    expect(blockPatchToColumns({ fragmentIds: null }).fragment_ids).toBeNull()
    expect(blockPatchToColumns({ fragmentIds: ['a'] }).fragment_ids).toBe('["a"]')
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

  it('coerces a null block_id to an empty string', () => {
    expect(rowToExecution({ ...base, block_id: null }).blockId).toBe('')
  })

  it('parses a valid failure but ignores garbage / partial shapes', () => {
    const ok = rowToExecution({
      ...base,
      failure: JSON.stringify({ kind: 'agent', message: 'boom' }),
    })
    expect(ok.failure).toEqual({ kind: 'agent', message: 'boom' })
    expect(rowToExecution({ ...base, failure: '{bad' }).failure).toBeNull()
    expect(
      rowToExecution({ ...base, failure: JSON.stringify({ kind: 'agent' }) }).failure,
    ).toBeNull()
  })
})

describe('rowToWorkspace / rowToPipeline', () => {
  it('maps a workspace, defaulting account_id to null', () => {
    expect(rowToWorkspace({ id: 'ws_1', name: 'W', created_at: 5, account_id: null })).toEqual({
      id: 'ws_1',
      name: 'W',
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
})
