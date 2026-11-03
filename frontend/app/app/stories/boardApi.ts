// The board's write requests, answered from memory, so a story that lets the user drag a card or
// a frame, or change a block's settings, does not report the server as unreachable. Without an
// answer the store also rolls its optimistic change back, so a setting a story changes would
// return to its old value.
//
// Each request is applied to the story's own copy of the blocks and the moved block comes back,
// as the backend would return it. The copy lives as long as the story module: switching stories
// and back keeps earlier moves on the server side while the stores re-seed from the snapshot.
import {
  type UpdateBlockInput,
  moveBlockContract,
  moveBlockSchema,
  reparentBlockContract,
  reparentSchema,
  resizeBlockContract,
  resizeBlockSchema,
  updateBlockContract,
  updateBlockSchema,
} from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import * as v from 'valibot'
import type { Block } from '~/types/domain'
import { apiHandler } from './api'
import { storyWorkspacePrefix } from './workspace'

/** The patch keys where an empty string clears the field, as the backend stores it. */
const CLEARED_BY_EMPTY = [
  'epicId',
  'pipelineId',
  'modelId',
  'riskPolicyId',
  'modelPresetId',
] as const

/**
 * A settings patch applied the way `BoardService` applies it. The request names the two halves of
 * the task-type bag separately (`customTaskTypeFields`, `builtinTaskTypeFields`), and each replaces
 * its own half of `taskTypeFields`. An empty string clears the fields in `CLEARED_BY_EMPTY`. The
 * mock does not run the server's validation of the custom half.
 */
function applyBlockPatch(current: Block, patch: UpdateBlockInput): Block {
  const { customTaskTypeFields, builtinTaskTypeFields, ...rest } = patch
  const next: Block = { ...current, ...rest }
  for (const key of CLEARED_BY_EMPTY) {
    if (rest[key] === '') delete next[key]
  }
  if (current.level === 'task') {
    let fields = current.taskTypeFields ?? undefined
    if (customTaskTypeFields !== undefined) fields = { ...fields, custom: customTaskTypeFields }
    if (builtinTaskTypeFields !== undefined) {
      fields = { ...(fields?.custom ? { custom: fields.custom } : {}), ...builtinTaskTypeFields }
    }
    if (fields !== current.taskTypeFields) next.taskTypeFields = fields
  }
  return next
}

export function boardApi(blocks: readonly Block[]): HttpHandler[] {
  const byId = new Map(blocks.map((b) => [b.id, b]))

  function update(id: string | undefined, change: (current: Block) => Block): Block {
    const current = id ? byId.get(id) : undefined
    if (!current) throw new Error(`No block "${id}" on the story's board`)
    const next = change(current)
    byId.set(next.id, next)
    return next
  }

  const at = { pathPrefix: storyWorkspacePrefix, pattern: { blockId: ':blockId' } }
  return [
    apiHandler(moveBlockContract, at, ({ pathParams, body }) => {
      const { position } = v.parse(moveBlockSchema, body)
      return update(pathParams.blockId, (current) => ({ ...current, position }))
    }),
    apiHandler(resizeBlockContract, at, ({ pathParams, body }) => {
      const { position, size } = v.parse(resizeBlockSchema, body)
      return update(pathParams.blockId, (current) => ({ ...current, position, size }))
    }),
    apiHandler(reparentBlockContract, at, ({ pathParams, body }) => {
      const { parentId, position } = v.parse(reparentSchema, body)
      return update(pathParams.blockId, (current) => ({ ...current, parentId, position }))
    }),
    apiHandler(updateBlockContract, at, ({ pathParams, body }) => {
      const patch = v.parse(updateBlockSchema, body)
      return update(pathParams.blockId, (current) => applyBlockPatch(current, patch))
    }),
  ]
}
