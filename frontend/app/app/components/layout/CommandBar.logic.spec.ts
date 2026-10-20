import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { missingI18nKeys, resolveI18nKey } from '../../../test/i18nKeys'
import { SOURCE_COMMAND_KEYS, documentSourceKind, sourceCommandLabelKey } from './CommandBar.logic'

/**
 * A provider that is both a document source and a task source (Linear) gets two palette entries
 * for two separate connections. They must read differently in EVERY locale, or the palette lists
 * the same label twice. The keys are reached through a table, so `i18n:check` cannot see them;
 * this reads each catalog instead, and a new locale file is covered when it is added.
 */

const localesDir = join(dirname(fileURLToPath(import.meta.url)), '../../../i18n/locales')
const locales = readdirSync(localesDir).filter((f) => f.endsWith('.json'))

const allKeys = Object.values(SOURCE_COMMAND_KEYS).flatMap((byState) => Object.values(byState))

describe('sourceCommandLabelKey', () => {
  it('picks the manage label for a connected source and the connect label otherwise', () => {
    expect(sourceCommandLabelKey('document', false)).toBe(SOURCE_COMMAND_KEYS.document.connect)
    expect(sourceCommandLabelKey('design', true)).toBe(SOURCE_COMMAND_KEYS.design.manage)
    expect(sourceCommandLabelKey('task', false)).toBe(SOURCE_COMMAND_KEYS.task.connect)
    expect(sourceCommandLabelKey('task', true)).toBe(SOURCE_COMMAND_KEYS.task.manage)
  })

  it('labels a design source as designs and any other document source as documents', () => {
    expect(documentSourceKind('figma')).toBe('design')
    expect(documentSourceKind('zeplin')).toBe('design')
    expect(documentSourceKind('notion')).toBe('document')
    expect(documentSourceKind('linear')).toBe('document')
  })
})

describe.each(locales)('source command labels in %s', (file) => {
  const catalog: unknown = JSON.parse(readFileSync(join(localesDir, file), 'utf8'))

  it('has every key, each naming the source', () => {
    expect(missingI18nKeys(allKeys, catalog)).toEqual([])
    for (const key of allKeys) {
      expect(resolveI18nKey(key, catalog), key).toContain('{source}')
    }
  })

  it('gives one source a different label for each kind and state', () => {
    const rendered = allKeys.map((key) =>
      resolveI18nKey(key, catalog)?.replace('{source}', 'Linear'),
    )
    expect(new Set(rendered).size).toBe(allKeys.length)
  })
})
