import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SOURCE_COMMAND_KEYS, sourceCommandLabelKey } from './CommandBar.logic'

/**
 * A provider that is both a document source and a task source (Linear) gets two palette entries
 * for two separate connections. They must read differently in EVERY locale, or the palette lists
 * the same label twice. The keys are reached through a table, so `i18n:check` cannot see them;
 * this reads each catalog instead, and a new locale file is covered when it is added.
 */

const localesDir = join(dirname(fileURLToPath(import.meta.url)), '../../../i18n/locales')
const locales = readdirSync(localesDir).filter((f) => f.endsWith('.json'))

function lookup(catalog: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => {
    return node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined
  }, catalog)
}

const allKeys = Object.values(SOURCE_COMMAND_KEYS).flatMap((byState) => Object.values(byState))

describe('sourceCommandLabelKey', () => {
  it('picks the manage label for a connected source and the connect label otherwise', () => {
    expect(sourceCommandLabelKey('document', false)).toBe(SOURCE_COMMAND_KEYS.document.connect)
    expect(sourceCommandLabelKey('document', true)).toBe(SOURCE_COMMAND_KEYS.document.manage)
    expect(sourceCommandLabelKey('task', false)).toBe(SOURCE_COMMAND_KEYS.task.connect)
    expect(sourceCommandLabelKey('task', true)).toBe(SOURCE_COMMAND_KEYS.task.manage)
  })
})

describe.each(locales)('source command labels in %s', (file) => {
  const catalog: unknown = JSON.parse(readFileSync(join(localesDir, file), 'utf8'))

  it('has every key, each naming the source', () => {
    for (const key of allKeys) {
      expect(lookup(catalog, key), key).toEqual(expect.stringContaining('{source}'))
    }
  })

  it('gives one source four different labels, so a document and a task source never read alike', () => {
    const rendered = allKeys.map((key) =>
      String(lookup(catalog, key)).replace('{source}', 'Linear'),
    )
    expect(new Set(rendered).size).toBe(allKeys.length)
  })
})
