// Fixtures for the restated-default ban (issue #2250). Run with `node --test scripts/`, the
// built-in runner, so CI's guards job stays install-free.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  deriveWrappers,
  findInTemplate,
  findSolidSiblings,
  readDefaults,
} from './check-frontend-variants.mjs'
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
// The Nuxt UI pair plus the one wrapper the real tree derives.
const TAG_KEYS = { UButton: 'button', UBadge: 'badge', IconButton: 'button' }
const find = (template) => findInTemplate(sfc(template), defaults, TAG_KEYS)

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

  it('tolerates a sibling key first, a comment and double quotes', () => {
    const edited = CONFIG.replace(
      "button: {\n      defaultVariants: { color: 'neutral', variant: 'ghost', size: 'xs' },",
      'button: {\n      slots: { base: "gap-1" },\n      // the quiet control\n      defaultVariants: { color: "neutral", /* why */ variant: "ghost", size: "xs" },',
    )
    assert.notEqual(edited, CONFIG)
    assert.deepEqual(readDefaults(edited).button, defaults.button)
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

  it('honours a waiver on its own line directly above the tag, for that tag only', () => {
    assert.deepEqual(find('<!-- variant-default-ok: why -->\n<UButton size="xs" />'), [])
    // A trailing comment does not waive, and a waiver does not leak onto the next tag.
    assert.deepEqual(find('<UButton size="xs" /> <!-- variant-default-ok: why -->'), [
      { line: 2, matches: ['<UButton>', 'size="xs"'] },
    ])
    assert.deepEqual(
      find('<!-- variant-default-ok: why -->\n<UButton size="xs" />\n<UButton size="xs" />'),
      [{ line: 4, matches: ['<UButton>', 'size="xs"'] }],
    )
  })

  it('reads kebab-case tags, single quotes and v-bind object literals', () => {
    assert.deepEqual(find('<u-button size="xs" />'), [
      { line: 2, matches: ['<UButton>', 'size="xs"'] },
    ])
    assert.deepEqual(find("<UButton size='xs' />"), [
      { line: 2, matches: ['<UButton>', 'size="xs"'] },
    ])
    assert.deepEqual(find(`<UButton v-bind="{ size: 'xs', block: true }" />`), [
      { line: 2, matches: ['<UButton>', 'size="xs"'] },
    ])
    assert.deepEqual(find(`<UButton :color='"neutral"' />`), [
      { line: 2, matches: ['<UButton>', 'color="neutral"'] },
    ])
  })

  it('does not flag size inside a field group, which sets the size itself', () => {
    assert.deepEqual(find('<UFieldGroup size="sm">\n  <UButton size="xs" />\n</UFieldGroup>'), [])
    // ...but the group does not excuse colour or variant.
    assert.deepEqual(
      find('<UFieldGroup size="sm">\n  <UButton color="neutral" />\n</UFieldGroup>'),
      [{ line: 3, matches: ['<UButton>', 'color="neutral"'] }],
    )
  })

  it('does not read a < inside a binding or a mustache as a tag', () => {
    assert.deepEqual(
      find('<UButton :x="y as Array<Item>" />\n<span>{{ n<max }}</span>\n<UButton size="xs" />'),
      [{ line: 4, matches: ['<UButton>', 'size="xs"'] }],
    )
  })
})

describe('deriveWrappers', () => {
  it('finds a component that spreads its attributes into a UButton or UBadge', () => {
    const wrapper = (inner) => `<template>\n  <span>${inner}</span>\n</template>\n`
    assert.deepEqual(
      deriveWrappers([
        { name: 'IconButton', source: wrapper('<UButton v-bind="buttonAttrs" />') },
        { name: 'ChipBadge', source: wrapper('<u-badge v-bind="$attrs" />') },
        { name: 'CopyButton', source: wrapper('<UButton :size="size" />') },
      ]),
      { IconButton: 'button', ChipBadge: 'badge' },
    )
  })
})

describe('findSolidSiblings', () => {
  // The real defaults: an unvariant button is solid.
  const nuxt = readDefaults(
    CONFIG.replace("variant: 'ghost', size: 'xs'", "variant: 'solid', size: 'md'"),
  )
  const solids = (template) =>
    findSolidSiblings(sfc(template), nuxt, TAG_KEYS).map((hit) => hit.matches.join(' '))

  it('flags two solid buttons under one parent, explicit or by default', () => {
    assert.deepEqual(
      solids('<div>\n  <UButton>A</UButton>\n  <UButton variant="solid">B</UButton>\n</div>'),
      ['solid@3 solid@4'],
    )
  })

  it('accepts one solid beside lighter siblings', () => {
    assert.deepEqual(
      solids(
        '<div>\n  <UButton color="neutral" variant="ghost">Cancel</UButton>\n  <UButton>Save</UButton>\n</div>',
      ),
      [],
    )
  })

  it('counts each parent separately, so two forms in one file are two views', () => {
    assert.deepEqual(
      solids('<form><UButton>Save</UButton></form>\n<form><UButton>Save</UButton></form>'),
      [],
    )
  })

  it('counts a v-if chain as its largest branch', () => {
    assert.deepEqual(
      solids(
        '<div>\n  <UButton v-if="a">A</UButton>\n  <UButton v-else-if="b">B</UButton>\n  <UButton v-else>C</UButton>\n</div>',
      ),
      [],
    )
  })

  it('looks through a plain template wrapper but not a slot template', () => {
    assert.deepEqual(
      solids(
        '<div>\n  <template v-if="x"><UButton>A</UButton></template>\n  <UButton>B</UButton>\n</div>',
      ),
      ['solid@3 solid@4'],
    )
    assert.deepEqual(
      solids(
        '<UModal>\n  <template #body><UButton>A</UButton></template>\n  <template #footer><UButton>B</UButton></template>\n</UModal>',
      ),
      [],
    )
  })

  it('counts a v-for button once and skips a bound variant', () => {
    assert.deepEqual(
      solids('<div>\n  <UButton v-for="p in ps" :key="p">{{ p }}</UButton>\n</div>'),
      [],
    )
    assert.deepEqual(
      solids(
        `<div>\n  <UButton>A</UButton>\n  <UButton :variant="on ? 'solid' : 'ghost'">B</UButton>\n</div>`,
      ),
      [],
    )
  })

  it('reads a wrapped tag whose condition holds a >', () => {
    assert.deepEqual(
      solids('<div>\n  <UButton\n    v-if="n > 1"\n  >A</UButton>\n  <UButton>B</UButton>\n</div>'),
      ['solid@3 solid@6'],
    )
  })

  it('counts a v-if chain inside a plain template as one button', () => {
    assert.deepEqual(
      solids(
        '<div>\n  <template v-if="x">\n    <UButton v-if="a">A</UButton>\n    <UButton v-else>B</UButton>\n  </template>\n</div>',
      ),
      [],
    )
    // ...while two buttons the template renders together are still siblings of the one after it.
    assert.deepEqual(
      solids(
        '<div>\n  <template v-if="x"><UButton>A</UButton></template>\n  <template v-else><UButton>B</UButton></template>\n  <UButton>C</UButton>\n</div>',
      ),
      ['solid@3 solid@5'],
    )
  })

  it('does not read a < inside a binding or a mustache as a tag', () => {
    // An unclosed phantom `Item` element would swallow the last button and hide the pair.
    assert.deepEqual(
      solids(
        '<div>\n  <UButton>A</UButton>\n  <UButton :x="y as Array<Item>" variant="ghost" />\n  <UButton>B</UButton>\n</div>',
      ),
      ['solid@3 solid@5'],
    )
    assert.deepEqual(
      solids(
        '<div>\n  <UButton>A</UButton>\n  <span>{{ n<max ? 1 : 2 }}</span>\n  <UButton>B</UButton>\n</div>',
      ),
      ['solid@3 solid@5'],
    )
  })

  it('honours the waiver on the second button', () => {
    assert.deepEqual(
      solids(
        '<div>\n  <UButton>A</UButton>\n  <!-- solid-ok: why -->\n  <UButton>B</UButton>\n</div>',
      ),
      [],
    )
  })
})
