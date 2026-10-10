import { describe, expect, it } from 'vitest'
import { probeDirsForLegs } from '../src/multi-repo-coding.js'

describe('probeDirsForLegs (what a multi-repo run must show progress in)', () => {
  const legs = [
    { dir: '/ws/owner__api__aa', readOnly: undefined },
    { dir: '/ws/owner__web__bb' },
    { dir: '/ws/owner__docs__cc', readOnly: true },
  ]

  it('names every WRITABLE checkout, never the workspace root', () => {
    // The root is no git repository, so probing it (the guard's default, `[dir]`) throws on every
    // call and the bound never enforces anything.
    expect(probeDirsForLegs(legs)).toEqual(['/ws/owner__api__aa', '/ws/owner__web__bb'])
  })

  it('excludes a read-only reference checkout', () => {
    // The run may not write there, so a change appearing in it is not this run making progress
    // and must never be what saves it from the bound.
    expect(probeDirsForLegs(legs)).not.toContain('/ws/owner__docs__cc')
  })
})
