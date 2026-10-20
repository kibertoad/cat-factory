// Fixtures for the comment rule the SPA guards share (`lib/frontend-scan.mjs`). Run with
// `node --test scripts/`: the built-in runner, so CI's guards job stays install-free.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { codeLines } from './lib/frontend-scan.mjs'

const code = (source) => codeLines(source).map((line) => line.code.trim())

describe('codeLines', () => {
  it('blanks a block comment across lines and keeps the code around it', () => {
    assert.deepEqual(code('a /* one\n * two\n three */ b'), ['a', '', 'b'])
  })

  it('reads a leading `*` as code outside a block and as prose inside one', () => {
    assert.deepEqual(code('* { x: 1 }'), ['* { x: 1 }'])
    assert.deepEqual(code('/*\n * { x: 1 }\n */'), ['', '', ''])
  })

  it('blanks an HTML comment across lines', () => {
    assert.deepEqual(code('<!--\n  <div class="x">\n--> <p>'), ['', '', '<p>'])
  })

  it('opens a line comment only at the start of a line or after whitespace', () => {
    assert.deepEqual(code(`const u = 'https://x' // note`), [`const u = 'https://x'`])
    assert.deepEqual(code('// all prose'), [''])
  })

  it('never treats a leading `#` as a comment, it being an ID selector', () => {
    assert.deepEqual(code('#app { color: red }'), ['#app { color: red }'])
  })

  it('keeps the raw line and the raw line before it for waivers', () => {
    const [first, second] = codeLines('// ok: reason\nx')
    assert.deepEqual(first, { raw: '// ok: reason', code: '', prev: '' })
    assert.deepEqual(second, { raw: 'x', code: 'x', prev: '// ok: reason' })
  })

  it('throws on a comment that never closes rather than blanking the rest of the file', () => {
    assert.throws(() => codeLines(`const glob = 'src/*.vue'\n/* open`, 'a.ts'), /a\.ts: a \/\*/)
    assert.throws(() => codeLines('<!-- open', 'b.vue'), /b\.vue: a <!--/)
  })
})
