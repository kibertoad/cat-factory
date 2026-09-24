// Fixtures for the raw-control guard (issue #2249). Run by `node --test 'scripts/*.test.mjs'`.
//
// The guard's two failure modes are opposite and both quiet. Matching too loosely fails a diff
// for markup that was never a control (`<article>` is not `<a>`, `<UInput>` is not `<input>`),
// which teaches the next contributor to reach for the waiver. Matching too narrowly lets the
// count climb back, which is the thing the guard exists to stop. The element-boundary cases and
// the `<template #slot>` case below are the ones that got this wrong while it was being written.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { findRawControls, findRedundantTitle, templateHalf } from './check-frontend-primitives.mjs'

test('claims each banned control', () => {
  assert.deepEqual(findRawControls('  <button type="button">Go</button>'), ['button'])
  assert.deepEqual(findRawControls('  <textarea v-model="x" />'), ['textarea'])
  assert.deepEqual(findRawControls('  <select v-model="x">'), ['select'])
  assert.deepEqual(findRawControls('  <table class="w-full">'), ['table'])
  assert.deepEqual(findRawControls('  <details>'), ['details'])
  assert.deepEqual(findRawControls('  <form @submit.prevent="go">'), ['form'])
  assert.deepEqual(findRawControls('  <datalist id="views">'), ['datalist'])
})

test('an element name ends at a character that cannot continue it', () => {
  // The bug this pins: `<a` matching the start of `<article>`, and `<input` the start of a
  // component whose name merely begins the same way.
  assert.deepEqual(findRawControls('  <article class="card">'), [])
  assert.deepEqual(findRawControls('  <aside>'), [])
  assert.deepEqual(findRawControls('  <UInput v-model="x" />'), [])
  assert.deepEqual(findRawControls('  <UButton color="neutral" />'), [])
  assert.deepEqual(findRawControls('  <UTable :data="rows" />'), [])
  assert.deepEqual(findRawControls('  <table-of-contents />'), [])
})

test('an anchor is a link only when it has a destination', () => {
  assert.deepEqual(findRawControls('  <a :href="url" target="_blank">'), ['a'])
  assert.deepEqual(findRawControls('  <a href="https://example.test">'), ['a'])
  // A bare anchor is a scroll target, not a link, and Nuxt UI has nothing to replace it with.
  assert.deepEqual(findRawControls('  <a id="section-3" />'), [])
})

test('prose and layout markup is out of scope', () => {
  assert.deepEqual(findRawControls('  <p class="text-xs">hello</p>'), [])
  assert.deepEqual(findRawControls('  <h2>Heading</h2>'), [])
  assert.deepEqual(findRawControls('  <ul><li>one</li></ul>'), [])
  assert.deepEqual(findRawControls('  <pre>{{ detail }}</pre>'), [])
  assert.deepEqual(findRawControls('  <div><span>x</span></div>'), [])
})

test('reports every distinct control on one line', () => {
  // Order follows the replacement table rather than the line, so compare as a set.
  assert.deepEqual(findRawControls('  <form><input /></form>').sort(), ['form', 'input'])
})

test('a comment line is prose about the rule, not an application of it', () => {
  assert.deepEqual(findRawControls('  // <button> becomes UButton'), [])
  assert.deepEqual(findRawControls('  <!-- <select> becomes USelect -->'), [])
  assert.deepEqual(findRawControls('   * a raw <input> is banned'), [])
})

test('the waiver is honoured on the line and on the one before it', () => {
  assert.deepEqual(findRawControls('  <button /> <!-- raw-control-ok: reason -->'), [])
  assert.deepEqual(findRawControls('  <button />', '  <!-- raw-control-ok: reason -->'), [])
  // ...and nowhere else, so a waiver two lines up cannot silence an unrelated control.
  assert.deepEqual(findRawControls('  <button />', '  <div>'), ['button'])
})

test('title= is banned on the primitives that own their tooltip', () => {
  assert.deepEqual(findRedundantTitle('  <IconButton :title="x" icon="i-lucide-x" />'), ['title'])
  assert.deepEqual(findRedundantTitle('  <CopyButton title="Copy" :text="x" />'), ['title'])
  // A labelled UButton's title is a hover HINT beside its own name, which the rule allows.
  assert.deepEqual(findRedundantTitle('  <UButton :title="hint" label="Save" />'), [])
  assert.deepEqual(findRedundantTitle('  <IconButton :label="x" icon="i-lucide-x" />'), [])
})

test('the template half keeps line numbers and survives nested slot templates', () => {
  const sfc = [
    '<script setup lang="ts">',
    "const markup = '<button>not markup</button>'",
    '</script>',
    '',
    '<template>',
    '  <UCard>',
    '    <template #header>',
    '      <span>head</span>',
    '    </template>',
    '    <button>real</button>',
    '  </UCard>',
    '</template>',
  ].join('\n')
  const lines = templateHalf(sfc).split('\n')

  // The script's string literal is blanked, so it cannot be reported...
  assert.deepEqual(findRawControls(lines[1]), [])
  // ...the line count is unchanged, so an offender's reported line is its real one...
  assert.equal(lines.length, 12)
  // ...and the control AFTER a nested `<template #header>` is still seen, which a non-greedy
  // match on the outer template pair would have skipped.
  assert.deepEqual(findRawControls(lines[9]), ['button'])
})

test('a style block is blanked too', () => {
  const sfc = [
    '<template>',
    '  <div />',
    '</template>',
    '<style>',
    'button { color: red }',
    '</style>',
  ].join('\n')
  const lines = templateHalf(sfc).split('\n')
  assert.deepEqual(findRawControls(lines[4]), [])
})
