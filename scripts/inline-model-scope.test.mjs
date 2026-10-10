// Fixtures for the inline-model-scope guard's detection (`inline-model-scope.mjs`).
//
// Run with: node --test 'scripts/*.test.mjs'
//
// The cases that matter are the two directions a text scan gets wrong. A false NEGATIVE lets the
// exact shape the guard exists to catch sail past, which is worse than no guard because the guard
// is then trusted. A false POSITIVE makes people annotate correct code, which teaches them the
// marker is noise and is how the escape hatch stops meaning anything.

import { deepEqual, equal } from 'node:assert/strict'
import { test } from 'node:test'
import { findUnseamedScopes, maskLiterals } from './inline-model-scope.mjs'

const reasonsIn = (src) => findUnseamedScopes(src).map((f) => f.reason)

test('flags an object literal handed straight to the call', () => {
  const src = `const p = await resolveScopedModelProvider({ workspaceId }, this.deps)`
  deepEqual(reasonsIn(src), ['literal'])
})

test('flags a literal on the resolver method too, not just the free function', () => {
  const src = `return this.modelProviderResolver.forScope({ workspaceId: ctx.workspaceId })`
  deepEqual(reasonsIn(src), ['literal'])
})

test('accepts a scope resolved through the seam', () => {
  const src = [
    `const scope = await resolveInlineScope({ kind: 'user', workspaceId, userId })`,
    `const p = await resolveScopedModelProvider(scope, this.deps)`,
  ].join('\n')
  deepEqual(reasonsIn(src), [])
})

test('accepts the seam called inline as the argument', () => {
  const src = `await resolver.forScope(await resolveInlineScope({ kind: 'workspace', workspaceId }))`
  deepEqual(reasonsIn(src), [])
})

test('flags a variable in a file that never mentions the seam (the indirection hole)', () => {
  const src = [
    `const scope = { workspaceId }`,
    `await resolveScopedModelProvider(scope, deps)`,
  ].join('\n')
  deepEqual(reasonsIn(src), ['unseamed'])
})

test('a literal is still flagged even in a file that uses the seam elsewhere', () => {
  // Otherwise one correct call site would vouch for every careless one beside it.
  const src = [
    `const a = await resolveInlineScope({ kind: 'workspace', workspaceId })`,
    `await resolver.forScope({ workspaceId })`,
  ].join('\n')
  deepEqual(reasonsIn(src), ['literal'])
})

test('honours the escape hatch on the line above', () => {
  const src = [
    `// inline-scope-ok: forwards the caller's own scope.`,
    `await generator.forScope(scope)`,
  ].join('\n')
  deepEqual(reasonsIn(src), [])
})

test('honours the escape hatch anywhere in the comment block above', () => {
  const src = [
    `// inline-scope-ok: forwards the scope the public-API controller resolved`,
    `// from the key's own binding; nothing is decided here.`,
    `await generator.forScope(scope)`,
  ].join('\n')
  deepEqual(reasonsIn(src), [])
})

test('rejects the marker with no reason after the colon', () => {
  // A bare token is a thing people skim past; the reason is the whole point of the hatch.
  const src = [`// inline-scope-ok:`, `await resolver.forScope({ workspaceId })`].join('\n')
  deepEqual(reasonsIn(src), ['literal'])
})

test('does not read the hatch across a blank line', () => {
  const src = [
    `// inline-scope-ok: this reason belongs to something else entirely.`,
    ``,
    `await resolver.forScope({ workspaceId })`,
  ].join('\n')
  deepEqual(reasonsIn(src), ['literal'])
})

test('ignores a call site that only appears inside a comment', () => {
  const src = `// historical note: this used to call resolveScopedModelProvider({ workspaceId })`
  deepEqual(reasonsIn(src), [])
})

test('ignores a call site that only appears inside a string', () => {
  // The false-negative trap from the silent-catch guard, in this shape: a URL or a doc string
  // holding a `//` must not make the rest of the line look like a comment.
  const src = `const doc = 'see https://x/y : resolveScopedModelProvider({ workspaceId })'`
  deepEqual(reasonsIn(src), [])
})

test('still sees a real call on a line that also holds a string with a slash in it', () => {
  const src = `await fetch('https://example.com/x'); await resolver.forScope({ workspaceId })`
  deepEqual(reasonsIn(src), ['literal'])
})

test('reports the line and the source text, not the masked text', () => {
  const src = [`const x = 1`, `await resolver.forScope({ workspaceId: 'ws' })`].join('\n')
  const [finding] = findUnseamedScopes(src)
  equal(finding.line, 2)
  equal(finding.snippet, `await resolver.forScope({ workspaceId: 'ws' })`)
})

test('masking preserves offsets and newlines so line numbers stay true', () => {
  const src = `const a = 'xx'\n// yy\nconst b = 2`
  const masked = maskLiterals(src)
  equal(masked.length, src.length)
  equal(masked.split('\n').length, src.split('\n').length)
})

test('seamOptional lets a forwarding definer through without the seam', () => {
  // A resolver decorator: it is handed a scope and passes it on, so it never calls the seam and
  // there is nothing for it to state.
  const src = `forScope(scope) { return this.inner.forScope(scope) }`
  deepEqual(
    findUnseamedScopes(src, { seamOptional: true }).map((f) => f.reason),
    [],
  )
})

test('seamOptional still flags a hand-built literal in a definer', () => {
  // The half the exemption must NOT cover. These files build activation scopes and read
  // `scope.userId`, so a literal is likelier there than anywhere, and a whole-file pass would
  // make them the one place it can never be seen.
  const src = `await this.inner.forScope({ workspaceId })`
  deepEqual(
    findUnseamedScopes(src, { seamOptional: true }).map((f) => f.reason),
    ['literal'],
  )
})
