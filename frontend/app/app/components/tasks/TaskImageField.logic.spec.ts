import { describe, expect, it } from 'vitest'
import { partitionImagePick } from './TaskImageField.logic'

const file = (name: string, type: string) => new File([new Uint8Array([1])], name, { type })

describe('partitionImagePick', () => {
  it('keeps the accepted images and names every file it could not take', () => {
    const pick = partitionImagePick(
      [
        file('crash.png', 'image/png'),
        file('photo.heic', 'image/heic'),
        file('dropped', ''),
        file('sketch.jpg', 'image/jpeg'),
      ],
      6,
    )
    expect(pick.kept.map((f) => f.name)).toEqual(['crash.png', 'sketch.jpg'])
    expect(pick.rejected).toEqual(['photo.heic', 'dropped'])
    expect(pick.truncated).toBe(false)
  })

  it('names the rejected files even when nothing at all was attached', () => {
    const pick = partitionImagePick([file('scan.bmp', 'image/bmp')], 6)
    expect(pick.kept).toEqual([])
    expect(pick.rejected).toEqual(['scan.bmp'])
  })

  it('reports a pick that held more accepted images than there was room for', () => {
    const pick = partitionImagePick(
      [file('a.png', 'image/png'), file('b.png', 'image/png'), file('c.png', 'image/png')],
      2,
    )
    expect(pick.kept.map((f) => f.name)).toEqual(['a.png', 'b.png'])
    expect(pick.truncated).toBe(true)
    expect(pick.rejected).toEqual([])
  })
})
