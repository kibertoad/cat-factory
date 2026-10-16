// The board's write requests, answered from memory, so a story that lets the user drag a card or
// a frame, or change a block's settings, does not report the server as unreachable. Without an
// answer the store also rolls its optimistic change back, so a setting a story changes would
// return to its old value.
//
// Each request is applied to the story's own copy of the blocks and the moved block comes back,
// as the backend would return it. The copy lives as long as the story module: switching stories
// and back keeps earlier moves on the server side while the stores re-seed from the snapshot.
import {
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

export function boardApi(blocks: readonly Block[]): HttpHandler[] {
  const byId = new Map(blocks.map((b) => [b.id, b]))

  function update(id: string | undefined, change: Partial<Block>): Block {
    const current = id ? byId.get(id) : undefined
    if (!current) throw new Error(`No block "${id}" on the story's board`)
    const next = { ...current, ...change }
    byId.set(next.id, next)
    return next
  }

  const at = { pathPrefix: storyWorkspacePrefix, pattern: { blockId: ':blockId' } }
  return [
    apiHandler(moveBlockContract, at, ({ pathParams, body }) => {
      const { position } = v.parse(moveBlockSchema, body)
      return update(pathParams.blockId, { position })
    }),
    apiHandler(resizeBlockContract, at, ({ pathParams, body }) => {
      const { position, size } = v.parse(resizeBlockSchema, body)
      return update(pathParams.blockId, { position, size })
    }),
    apiHandler(reparentBlockContract, at, ({ pathParams, body }) => {
      const { parentId, position } = v.parse(reparentSchema, body)
      return update(pathParams.blockId, { parentId, position })
    }),
    // A settings patch, merged onto the block as given.
    apiHandler(updateBlockContract, at, ({ pathParams, body }) =>
      update(pathParams.blockId, v.parse(updateBlockSchema, body) as Partial<Block>),
    ),
  ]
}
