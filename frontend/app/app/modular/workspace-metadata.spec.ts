import * as v from 'valibot'
import { workspaceMetadataKeySchema } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import {
  isValidMetadataKey,
  metadataDraftFrom,
  metadataPatchFrom,
  metadataValue,
  resolveMetadataFields,
  toMetadataBag,
  type WorkspaceMetadataFieldDefinition,
} from './workspace-metadata'

const field = (
  key: string,
  extra: Partial<WorkspaceMetadataFieldDefinition> = {},
): WorkspaceMetadataFieldDefinition => ({ key, label: key, ...extra })

describe('isValidMetadataKey', () => {
  it.each(['gameId', 'a', 'game.id', 'game-id', 'game_id', 'g1'])('accepts %s', (key) => {
    expect(isValidMetadataKey(key)).toBe(true)
  })

  it.each(['', '1game', 'game id', 'game/id', 'game%id', '_game', 'a'.repeat(65)])(
    'rejects %s',
    (key) => {
      expect(isValidMetadataKey(key)).toBe(false)
    },
  )

  // The pattern is mirrored from the contract rather than imported (the contract expresses it
  // as a valibot schema). This is what keeps the two copies from drifting: a key the editor
  // renders but the store refuses would 422 every save with a message about a key the operator
  // never typed.
  it.each(['gameId', 'game.id-1', '1game', 'game id', 'a'.repeat(65)])(
    'agrees with the contract schema on %s',
    (key) => {
      expect(isValidMetadataKey(key)).toBe(v.safeParse(workspaceMetadataKeySchema, key).success)
    },
  )
})

// A field key only has to be identifier-shaped, and `constructor` / `toString` / `valueOf` all
// are. On a plain object each of those reads as an inherited FUNCTION for a field nobody has
// filled in — truthy where the code expects `undefined`, and not a string where the code expects
// one. These two helpers are what stop that reaching a required-metadata check, a resolver, or
// the editor's draft.
describe('metadataValue', () => {
  it('reads a stored value', () => {
    expect(metadataValue({ gameId: 'zork' }, 'gameId')).toBe('zork')
  })

  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty'])(
    'reads an unfilled %s as undefined rather than an inherited member',
    (key) => {
      expect(metadataValue({}, key)).toBeUndefined()
    },
  )

  it('reads a non-string value as undefined', () => {
    // The bag arrives via `JSON.parse`, so its shape is only as good as what was stored.
    expect(
      metadataValue({ gameId: 7 } as unknown as Record<string, string>, 'gameId'),
    ).toBeUndefined()
  })
})

describe('toMetadataBag', () => {
  it('hangs the bag on a null prototype so a plain property read is total', () => {
    // A resolver is a deployment's own code writing `ctx.metadata.gameId`; it cannot be made to
    // call `metadataValue`, so the object it receives has to be safe by construction.
    const bag = toMetadataBag({ gameId: 'zork' })

    expect(bag.gameId).toBe('zork')
    expect(Object.getPrototypeOf(bag)).toBeNull()
    expect((bag as Record<string, unknown>).constructor).toBeUndefined()
  })
})

describe('resolveMetadataFields', () => {
  it('orders by declared order and keeps the first declaration of a duplicate key', () => {
    const first = field('gameId', { order: 2, label: 'Game' })
    const { fields, rejected } = resolveMetadataFields([
      first,
      field('region', { order: 1 }),
      field('gameId', { label: 'Game (again)' }),
    ])

    expect(fields.map((f) => f.key)).toEqual(['region', 'gameId'])
    expect(fields.find((f) => f.key === 'gameId')).toBe(first)
    expect(rejected).toHaveLength(1)
  })

  it('drops a malformed key and hands it back rather than swallowing it', () => {
    const bad = field('not a key')
    const { fields, rejected } = resolveMetadataFields([field('gameId'), bad])

    // Rendering it would build an editor whose every save is refused by the store.
    expect(fields.map((f) => f.key)).toEqual(['gameId'])
    expect(rejected).toEqual([bad])
  })
})

describe('metadataDraftFrom', () => {
  it('seeds every declared field, blank where the workspace has no value', () => {
    expect(metadataDraftFrom([field('gameId'), field('region')], { gameId: 'zork' })).toEqual({
      gameId: 'zork',
      region: '',
    })
  })
})

describe('metadataPatchFrom', () => {
  const fields = [field('gameId'), field('region')]

  it('submits the trimmed non-empty values', () => {
    expect(metadataPatchFrom(fields, { gameId: ' zork ', region: 'eu' }, {})).toEqual({
      gameId: 'zork',
      region: 'eu',
    })
  })

  it('drops a cleared field, which is how the editor deletes a value', () => {
    expect(metadataPatchFrom(fields, { gameId: 'zork', region: '  ' }, { region: 'eu' })).toEqual({
      gameId: 'zork',
    })
  })

  it('carries a stored key no field renders into the patch', () => {
    // The update REPLACES the bag, so a value written under a field this build no longer
    // declares (a mid-rollout deployment, a retired field still read by something) would be
    // deleted by an unrelated save.
    expect(
      metadataPatchFrom(fields, { gameId: 'zork', region: '' }, { legacyId: 'keep-me' }),
    ).toEqual({ gameId: 'zork', legacyId: 'keep-me' })
  })

  it('lets a rendered field win over the stored value it edits', () => {
    expect(metadataPatchFrom(fields, { gameId: 'myst', region: '' }, { gameId: 'zork' })).toEqual({
      gameId: 'myst',
    })
  })

  it("coerces a number field's draft value instead of throwing on it", () => {
    // A `number` field renders `<UInput type="number">`, whose v-model hands back a NUMBER
    // however the draft is typed — `.trim()` on it is a TypeError, surfaced to the operator as
    // an opaque "save failed". `BudgetSettings.vue` wraps the same control in `String(...)`.
    const numeric = [field('port', { type: 'number' })]
    expect(metadataPatchFrom(numeric, { port: 8080 }, {})).toEqual({ port: '8080' })
  })

  it('keeps a stored key named after an Object member out of the prototype', () => {
    const patch = metadataPatchFrom(fields, { gameId: 'zork', region: '' }, { toString: 'kept' })

    expect(patch).toEqual({ gameId: 'zork', toString: 'kept' })
    expect(Object.getPrototypeOf(patch)).toBeNull()
    // The bag is JSON on the wire, and a null prototype changes nothing about that.
    expect(JSON.parse(JSON.stringify(patch))).toEqual({ gameId: 'zork', toString: 'kept' })
  })
})
