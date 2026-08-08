import { describe, expect, it } from 'vitest'
import type { ArtifactSetCap } from './artifactSetCap.js'
import { reclaimArtifactOverflow, reserveArtifactSlot } from './artifactSetCap.js'

// The standing row-count bound both artifact upload endpoints share. Its whole job is the case a
// single request cannot see — a set that grows past its cap one legal upload at a time, or a burst
// that each passes the pre-check before any row lands — so the races are what is pinned here.

describe('artifact set cap', () => {
  /** A set of `ids`, oldest-first, recording what the cap removes. */
  function cap(limit: number, ids: string[]) {
    const removed: string[] = []
    const rows = [...ids]
    const set: ArtifactSetCap = {
      limit,
      count: () => Promise.resolve(rows.length),
      list: () => Promise.resolve(rows.map((id) => ({ id }))),
      remove: (id) => {
        removed.push(id)
        rows.splice(rows.indexOf(id), 1)
        return Promise.resolve()
      },
    }
    return { set, removed, rows }
  }

  it('admits an upload below the cap and reports the size the reconcile needs', async () => {
    const { set } = cap(3, ['a'])
    expect(await reserveArtifactSlot(set)).toBe(1)
  })

  it('refuses at the cap without materialising a row', async () => {
    const { set } = cap(2, ['a', 'b'])
    expect(await reserveArtifactSlot(set)).toBeNull()
  })

  it('costs no materialising read while the set is far below the cap', async () => {
    // The steady-state path is one COUNT and nothing else: `list()` throws here, so a reconcile
    // that ran unconditionally would fail this rather than merely being slower.
    const { set } = cap(100, ['a'])
    const throwing: ArtifactSetCap = {
      ...set,
      list: () => Promise.reject(new Error('list must not be read below the cap edge')),
    }
    expect(await reclaimArtifactOverflow(throwing, 1, 'new')).toBe(false)
  })

  it('rolls back the inserted row when a race carried the set past the cap', async () => {
    // Check-then-act: two uploads both read a count of 2 against a cap of 3, so both are admitted
    // and the set lands at 4. The one in the overflow TAIL is the one refused.
    const { set, removed } = cap(3, ['a', 'b', 'c', 'mine'])
    expect(await reclaimArtifactOverflow(set, 2, 'mine')).toBe(true)
    expect(removed).toEqual(['mine'])
  })

  it("never rolls back somebody ELSE's row", async () => {
    // The other side of that same race: this request's row survived into the kept prefix, so the
    // overflow belongs to the concurrent uploader and is theirs to be refused. Deleting it here
    // would refuse one caller by destroying another's upload.
    const { set, removed } = cap(3, ['a', 'mine', 'c', 'theirs'])
    expect(await reclaimArtifactOverflow(set, 2, 'mine')).toBe(false)
    expect(removed).toEqual([])
  })

  it('keeps the OLDEST rows, so an uploader never loses what they added before', async () => {
    const { set, rows } = cap(2, ['old', 'older-still', 'mine'])
    await reclaimArtifactOverflow(set, 1, 'mine')
    expect(rows).toEqual(['old', 'older-still'])
  })
})
