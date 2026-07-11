import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DOCS } from '../src/config/docs.js'
import { ENV_HELP } from '../src/config/problems.js'

// These remedies embed a GitHub blob link on `main`. The prefix-shape guard in
// `misconfigured.spec.ts` proves each ENV_HELP entry HAS a link, but not that the link still
// resolves — a doc rename or a re-titled section would silently rot every embedded URL. This
// suite resolves the links against the real files on disk so that rot fails a test instead of
// shipping a dead "View documentation" link to an operator who is already misconfigured.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const BLOB_PREFIX = 'https://github.com/kibertoad/cat-factory/blob/main/'

/** Split a repo-doc blob URL into its repo-relative path and optional `#anchor`. */
function parseDocUrl(url: string): { path: string; anchor?: string } {
  expect(url.startsWith(BLOB_PREFIX), `${url} is not a repo-doc blob URL`).toBe(true)
  const rest = url.slice(BLOB_PREFIX.length)
  const hash = rest.indexOf('#')
  return hash === -1 ? { path: rest } : { path: rest.slice(0, hash), anchor: rest.slice(hash + 1) }
}

// GitHub slugifies a heading by lowercasing, dropping every character that is not a letter,
// number, space, hyphen or underscore, then turning each remaining space into a hyphen. It does
// NOT collapse the resulting runs, which is why `## Storage & retention` becomes
// `storage--retention`. Mirror that exactly so the anchors we assert match github.com.
function slugifyHeading(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s/g, '-')
}

function headingSlugs(path: string): Set<string> {
  const body = readFileSync(resolve(REPO_ROOT, path), 'utf8')
  const slugs = new Set<string>()
  for (const line of body.split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (match) slugs.add(slugifyHeading(match[1]!))
  }
  return slugs
}

describe('doc URLs referenced by error remedies', () => {
  it('every DOCS registry entry points at a file that exists', () => {
    for (const [name, build] of Object.entries(DOCS)) {
      const { path } = parseDocUrl(build())
      expect(existsSync(resolve(REPO_ROOT, path)), `DOCS.${name} → ${path} is missing`).toBe(true)
    }
  })

  it('every ENV_HELP docsUrl resolves to an existing file and heading anchor', () => {
    for (const [key, help] of Object.entries(ENV_HELP)) {
      const { path, anchor } = parseDocUrl(help.docsUrl)
      expect(existsSync(resolve(REPO_ROOT, path)), `${key} → ${path} is missing`).toBe(true)
      if (anchor) {
        expect(headingSlugs(path), `${key} → ${path}#${anchor} has no matching heading`).toContain(
          anchor,
        )
      }
    }
  })
})
