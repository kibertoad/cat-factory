import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `BoardTopOverlays` is the single owner of the board's top overlay region, and that only
 * holds while its members render as members: a card in a flex column, with no placement of
 * its own.
 *
 * The reason this is a test and not a note in the component is that the failure is SILENT and
 * only visible on a deployment in the state the banner reports. A member that re-anchors
 * itself (`absolute top-0`, a z-index of its own) leaves the column and lands back on top of
 * whatever picked a lower number, which is how a standing advisory came to cover the zoom/fit
 * controls outright, and the board-basics tour to ring a control nobody could see. Nothing
 * else catches it: the layout still renders, no type is wrong, and the unit suite mounts no
 * components.
 *
 * The member list is READ FROM THE COMPONENT rather than restated here, so a banner added to
 * the column is covered by the same commit that adds it, and one removed from the column
 * stops being checked instead of failing as a phantom.
 */

const layoutDir = dirname(fileURLToPath(import.meta.url))
const band = readFileSync(join(layoutDir, 'BoardTopOverlays.vue'), 'utf8')

/** The components the band lays out, from its own imports. */
function bandMembers(): string[] {
  return [...band.matchAll(/^import (\w+) from '~\/components\/layout\/(\w+)\.vue'$/gm)].map(
    (m) => m[2] as string,
  )
}

/** Every class token the file applies, from its static `class="…"` attributes. */
function classTokens(source: string): string[] {
  return [...source.matchAll(/\bclass="([^"]*)"/g)].flatMap((m) => (m[1] as string).split(/\s+/))
}

/**
 * A token that takes a member out of the column's flow. Responsive and state variants count
 * (`sm:absolute`, `lg:top-0`): the overlap they cause is no less real for being conditional.
 */
function selfPlacing(token: string): boolean {
  const base = token.includes(':') ? (token.split(':').pop() as string) : token
  return (
    base === 'fixed' ||
    base === 'absolute' ||
    base === 'sticky' ||
    /^-?(top|bottom|inset)-/.test(base) ||
    base === 'inset-0' ||
    base.startsWith('z-')
  )
}

describe('BoardTopOverlays members', () => {
  const members = bandMembers()

  it('lays out every top-region surface, so none of them is left placing itself', () => {
    // A relation over the source, not a count: the column's job is to be the ONLY placement
    // authority in this region, and a pinned number would fail on every ordinary addition
    // while saying nothing about what broke.
    expect(members.length).toBeGreaterThan(0)
    expect(new Set(members).size).toBe(members.length)
  })

  it.each(bandMembers())('%s places nothing itself', (member) => {
    const offenders = classTokens(readFileSync(join(layoutDir, `${member}.vue`), 'utf8')).filter(
      selfPlacing,
    )
    expect(offenders).toEqual([])
  })
})
