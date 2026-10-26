// Fixtures for the hand-built tab bar ban (`check-frontend-tabs.mjs`). Run with `node --test
// scripts/`, the built-in runner, so CI's guards job stays install-free.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findTabRoles } from './check-frontend-tabs.mjs'

const vue = (template) =>
  `<script setup lang="ts">\nconst a = 1\n</script>\n\n<template>\n${template}\n</template>\n`
const roles = (template) => findTabRoles(vue(template)).map((hit) => hit.role)

describe('hand-stated tab roles', () => {
  it('flags each of the three tab roles, in either quote style', () => {
    assert.deepEqual(
      roles(
        [
          '<div class="flex gap-1" role="tablist">',
          '  <UButton role=\'tab\' :aria-selected="on">One</UButton>',
          '</div>',
          '<section role="tabpanel">x</section>',
        ].join('\n'),
      ),
      ['tablist', 'tab', 'tabpanel'],
    )
  })

  it('flags a role on a tag the formatter broke across lines', () => {
    const hits = findTabRoles(
      vue(['<UButton', '  v-for="tab in tabs"', '  :key="tab"', '  role="tab"', '/>'].join('\n')),
    )
    assert.deepEqual(hits, [{ line: 6, role: 'tab' }])
  })

  it('flags a bound string literal', () => {
    assert.deepEqual(roles(`<div :role="'tablist'" />`), ['tablist'])
    assert.deepEqual(roles(`<div v-bind:role='"tab"' />`), ['tab'])
  })

  it('flags a template literal and a literal operand of a bound expression', () => {
    assert.deepEqual(roles('<div :role="`tablist`" />'), ['tablist'])
    assert.deepEqual(roles(`<div :role="tabbed ? 'tab' : undefined" />`), ['tab'])
    assert.deepEqual(roles(`<div v-bind:role='open ? "tabpanel" : "region"' />`), ['tabpanel'])
  })

  it('flags the role key of a `v-bind` object, quoted or not', () => {
    assert.deepEqual(roles(`<div v-bind="{ role: 'tab', id: x }" />`), ['tab'])
    assert.deepEqual(roles(`<div v-bind="{ id: x, 'role': on ? 'tab' : 'button' }" />`), ['tab'])
    assert.deepEqual(roles(`<div v-bind="{ ariaRole: 'tab', role: kind }" />`), [])
  })

  it('does not read a computed role, another role, or a longer role name', () => {
    assert.deepEqual(roles('<div :role="kind" />'), [])
    assert.deepEqual(roles('<div :role="`${kind}`" />'), [])
    assert.deepEqual(roles(`<div :role="on ? 'listbox' : 'tabular'" />`), [])
    assert.deepEqual(roles('<ul role="listbox"><li role="option">x</li></ul>'), [])
    assert.deepEqual(roles('<div role="tabular" />'), [])
    assert.deepEqual(roles('<div data-role="tab" />'), [])
  })

  it('passes `UTabs`, which states no role in the template', () => {
    assert.deepEqual(roles('<UTabs v-model="tab" :items="tabs" :content="false" />'), [])
  })

  it('ignores a role in a comment, the script block or a mustache', () => {
    assert.deepEqual(roles('<!-- never role="tablist" here -->\n<p>{{ \'role="tab"\' }}</p>'), [])
    assert.deepEqual(
      findTabRoles('<script setup lang="ts">\nconst x = \'<div role="tab">\'\n</script>\n'),
      [],
    )
  })

  it('honours a `tabs-ok:` waiver directly above the tag, and only that tag', () => {
    assert.deepEqual(
      roles(
        [
          '<!-- tabs-ok: a third-party widget renders the panels -->',
          '<div role="tablist">',
          '  <button role="tab">x</button>',
          '</div>',
        ].join('\n'),
      ),
      ['tab'],
    )
  })
})
