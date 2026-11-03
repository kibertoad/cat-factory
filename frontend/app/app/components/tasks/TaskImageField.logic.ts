import { INLINE_IMAGE_MEDIA_TYPES } from '@cat-factory/contracts'

/** What one pick of files comes to, with everything it drops said rather than silent. */
export interface ImagePick {
  /** The accepted images that fit, in the order they were picked. */
  kept: File[]
  /**
   * The names of picked files that are not an accepted image: a HEIC photo, a BMP, or a drop the
   * platform gave no type to. Named so a pick that attached nothing does not read as a broken
   * picker, and a pick that attached some does not read as one that attached all.
   */
  rejected: string[]
  /** Set when the accepted images held more than there was room for. */
  truncated: boolean
}

export function partitionImagePick(files: readonly File[], remaining: number): ImagePick {
  const images = files.filter((file) => INLINE_IMAGE_MEDIA_TYPES.includes(file.type))
  return {
    kept: images.slice(0, Math.max(0, remaining)),
    rejected: files.filter((file) => !images.includes(file)).map((file) => file.name),
    truncated: images.length > remaining,
  }
}
