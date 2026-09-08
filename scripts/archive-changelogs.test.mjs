// Fixtures for the changelog archiver. Run by `node --test 'scripts/*.test.mjs'`.
//
// The transform rewrites generated history in place, so its two failure modes both destroy
// something a release depends on. Cutting an entry in the wrong place splits a release's prose
// across two files, and `create-github-releases` reads the top entry for its release notes.
// Failing to recognise the pointer footer on a re-run either duplicates it or files it away as
// changelog text, and the second is unrecoverable prose loss.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { archiveOne, FOOTER_MARKER, parseChangelog } from './archive-changelogs.mjs'

const entry = (version, body = 'a change') => `## ${version}\n\n### Patch Changes\n\n- ${body}`

const changelog = (...versions) => `# @scope/pkg\n\n${versions.map((v) => entry(v)).join('\n\n')}\n`

test('splits the title block from the release entries, newest first', () => {
  const { head, entries } = parseChangelog(changelog('1.2.0', '1.1.0', '1.0.0'))
  assert.equal(head, '# @scope/pkg')
  assert.deepEqual(
    entries.map((e) => e.split('\n')[0]),
    ['## 1.2.0', '## 1.1.0', '## 1.0.0'],
  )
})

test('a heading inside a fence is prose, not a release boundary', () => {
  const fenced = `# @scope/pkg\n\n## 1.1.0\n\n- shows the shape:\n\n  \`\`\`md\n  ## 0.0.1\n  \`\`\`\n\n## 1.0.0\n\n- first\n`
  const { entries } = parseChangelog(fenced)
  assert.equal(entries.length, 2)
  assert.match(entries[0], /## 0\.0\.1/)
})

test('leaves a short history alone rather than writing an empty archive', () => {
  assert.equal(archiveOne({ changelog: changelog('1.1.0', '1.0.0'), archive: null, keep: 2 }), null)
})

test('keeps the newest entries and moves the rest under an archive title', () => {
  const result = archiveOne({
    changelog: changelog('1.2.0', '1.1.0', '1.0.0'),
    archive: null,
    keep: 1,
  })
  assert.equal(result.movedCount, 2)
  assert.match(result.changelog, /^# @scope\/pkg\n\n## 1\.2\.0/)
  assert.equal(result.changelog.includes('## 1.1.0'), false)
  assert.match(result.changelog, /Older releases: \[`CHANGELOG-ARCHIVE\.md`\]/)
  assert.match(result.archive, /^# @scope\/pkg: archived releases/)
  assert.ok(result.archive.indexOf('## 1.1.0') < result.archive.indexOf('## 1.0.0'))
})

test('a re-run prepends inside the existing archive and rewrites one footer', () => {
  const first = archiveOne({
    changelog: changelog('1.2.0', '1.1.0', '1.0.0'),
    archive: null,
    keep: 1,
  })
  const grown = first.changelog.replace('## 1.2.0', `${entry('1.3.0')}\n\n## 1.2.0`)
  const second = archiveOne({ changelog: grown, archive: first.archive, keep: 1 })

  assert.equal(second.movedCount, 1)
  assert.equal(second.changelog.split(FOOTER_MARKER).length - 1, 1)
  assert.match(second.changelog, /^# @scope\/pkg\n\n## 1\.3\.0/)
  assert.equal(second.archive.split('archived releases').length - 1, 1)
  assert.deepEqual(
    [...second.archive.matchAll(/^## (.+)$/gm)].map((m) => m[1]),
    ['1.2.0', '1.1.0', '1.0.0'],
  )
  assert.equal(second.archive.includes(FOOTER_MARKER), false)
})

test('the pointer footer is never mistaken for changelog prose', () => {
  const trimmed = archiveOne({ changelog: changelog('1.2.0', '1.1.0'), archive: null, keep: 1 })
  const { entries } = parseChangelog(trimmed.changelog)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].includes('CHANGELOG-ARCHIVE'), false)
})
