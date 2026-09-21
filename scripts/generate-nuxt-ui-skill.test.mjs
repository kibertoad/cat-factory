// Fixtures for the bundled Nuxt UI skill generator (`--check` CI guard, issue #2262). Run with
// `node --test scripts/` — the built-in runner, so CI's guards job stays install-free.
//
// Two things matter here. First, the parser must read frontmatter the same on LF and CRLF: the repo
// has no `.gitattributes`, so a Windows checkout carries `\r\n` and an LF-only regex would throw.
// Second, the committed `skill.generated.ts` must equal what the emitter produces NOW, which is the
// drift the guard exists to catch; `parseSkillMd` is exercised on its own so a bug consistent in
// both halves of that regenerate-and-diff cannot hide behind it.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildModule, parseSkillMd } from './generate-nuxt-ui-skill.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_PATH = join(
  repoRoot,
  'backend',
  'packages',
  'agents',
  'src',
  'agents',
  'kinds',
  'nuxt-ui',
  'skill.generated.ts',
)

describe('parseSkillMd', () => {
  const lf = '---\nname: nuxt-ui\ndescription: Build UIs.\n---\n# Body\n\nText.\n'

  it('reads frontmatter and body from an LF file', () => {
    assert.deepEqual(parseSkillMd(lf), {
      name: 'nuxt-ui',
      description: 'Build UIs.',
      body: '# Body\n\nText.',
    })
  })

  it('reads a CRLF file identically (no .gitattributes, so a Windows checkout has \\r\\n)', () => {
    const crlf = lf.replace(/\n/g, '\r\n')
    assert.deepEqual(parseSkillMd(crlf), parseSkillMd(lf))
  })

  it('throws when the frontmatter block is missing', () => {
    assert.throws(() => parseSkillMd('# No frontmatter here\n'), /missing YAML frontmatter/)
  })

  it('throws when a required field is absent', () => {
    assert.throws(() => parseSkillMd('---\nname: x\n---\nbody\n'), /missing 'description'/)
  })

  it('is sensitive to a changed body (so drift is detected, not smoothed over)', () => {
    assert.notEqual(parseSkillMd(lf).body, parseSkillMd(lf.replace('Text.', 'Other.')).body)
  })
})

describe('buildModule', () => {
  it('matches the committed skill.generated.ts (the check the CI guard runs)', () => {
    assert.equal(buildModule(), readFileSync(OUT_PATH, 'utf8'))
  })
})
