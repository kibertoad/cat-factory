// Fixtures for the restated-default ban (issue #2250). Run with `node --test scripts/`, the
// built-in runner, so CI's guards job stays install-free.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { findInTemplate, readDefaults } from './check-frontend-variants.mjs'
import { repoRoot } from './lib/frontend-scan.mjs'

// A synthetic config whose button and badge defaults DIFFER, so the per-component lookup is
// exercised; the real file states Nuxt UI's `primary solid md` for both.
const CONFIG = `export default defineAppConfig({
  ui: {
    button: {
      defaultVariants: { color: 'neutral', variant: 'ghost', size: 'xs' },
    },
    badge: {
      defaultVariants: { color: 'neutral', variant: 'subtle', size: 'sm' },
    },
  },
})`
const defaults = readDefaults(CONFIG)
const sfc = (template) => `<template>\n${template}\n</template>\n`
const find = (template) => findInTemplate(sfc(template), defaults)

describe('readDefaults', () => {
  it('reads each component block', () => {
    assert.deepEqual(defaults, {
      button: { color: 'neutral', variant: 'ghost', size: 'xs' },
      badge: { color: 'neutral', variant: 'subtle', size: 'sm' },
    })
  })

  it('reads the real app.config.ts', () => {
    // The guard is only as good as this parse, so it runs against the file CI will read.
    const real = readFileSync(join(repoRoot, 'frontend', 'app', 'app', 'app.config.ts'), 'utf8')
    const parsed = readDefaults(real)
    for (const key of ['button', 'badge']) {
      assert.deepEqual(Object.keys(parsed[key]).sort(), ['color', 'size', 'variant'])
    }
  })

  it('throws when a block or a prop is missing, rather than passing everything', () => {
    assert.throws(() => readDefaults(CONFIG.replace(/badge: \{[\s\S]*?\},\n {4}\},/, '')), /badge/)
    assert.throws(() => readDefaults(CONFIG.replace(", size: 'xs'", '')), /'size'/)
  })
})

describe('findInTemplate', () => {
  it('flags a literal equal to the default on each tag', () => {
    assert.deepEqual(find('<UButton size="xs" label="Go" />'), [
      { line: 2, matches: ['<UButton>', 'size="xs"'] },
    ])
    assert.deepEqual(find('<IconButton color="neutral" icon="i-x" label="Close" />'), [
      { line: 2, matches: ['<IconButton>', 'color="neutral"'] },
    ])
    assert.deepEqual(find('<UBadge variant="subtle" size="sm">New</UBadge>'), [
      { line: 2, matches: ['<UBadge>', 'variant="subtle"', 'size="sm"'] },
    ])
  })

  it('reads the defaults per component, so a badge default is fine on a button', () => {
    // `subtle` is the badge default and an ordinary choice for a button.
    assert.deepEqual(find('<UButton variant="subtle" />'), [])
    assert.deepEqual(find('<UBadge variant="ghost" />'), [])
  })

  it('accepts a value that differs from the default', () => {
    assert.deepEqual(find('<UButton color="primary" variant="solid" size="md" />'), [])
  })

  it('flags a bound string literal but not a computed binding', () => {
    assert.deepEqual(find(`<UButton :size="'xs'" />`), [
      { line: 2, matches: ['<UButton>', 'size="xs"'] },
    ])
    assert.deepEqual(find(`<UButton :variant="on ? 'solid' : 'ghost'" />`), [])
  })

  it('reads an opening tag the formatter wrapped across lines', () => {
    assert.deepEqual(find('<UButton\n  v-if="count > 1"\n  icon="i-x"\n  variant="ghost"\n/>'), [
      { line: 2, matches: ['<UButton>', 'variant="ghost"'] },
    ])
  })

  it('does not read a prop from the button body or a neighbouring tag', () => {
    assert.deepEqual(find('<UButton icon="i-x">\n  <span size="xs" />\n</UButton>'), [])
  })

  it('does not match a longer component name', () => {
    assert.deepEqual(find('<UButtonGroup size="xs" />'), [])
  })

  it('ignores the script half and HTML comments', () => {
    const source = `<script setup lang="ts">\nconst tpl = '<UButton size="xs" />'\n</script>\n${sfc(
      '<!-- <UButton size="xs" /> -->',
    )}`
    assert.deepEqual(findInTemplate(source, defaults), [])
  })

  it('honours the waiver on the tag line or the line before it', () => {
    assert.deepEqual(find('<UButton size="xs" /> <!-- variant-default-ok: why -->'), [])
    assert.deepEqual(find('<!-- variant-default-ok: why -->\n<UButton size="xs" />'), [])
  })
})
