import type { BinaryBlobBackend } from '@cat-factory/kernel'
import type { R2Bucket } from '@cloudflare/workers-types'

/**
 * R2-backed blob store — the Cloudflare blob backend for binary artifacts (the bytes
 * a {@link BinaryBlobBackend} stores; the metadata lives in D1). R2 has no per-value
 * size limit, so full-page screenshots are fine here (unlike D1).
 */
export class R2BinaryBlobBackend implements BinaryBlobBackend {
  readonly kind = 'r2' as const
  private readonly bucket: R2Bucket

  constructor({ bucket }: { bucket: R2Bucket }) {
    this.bucket = bucket
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.bucket.put(key, bytes, { httpMetadata: { contentType } })
  }

  async get(key: string): Promise<Uint8Array | null> {
    const object = await this.bucket.get(key)
    if (!object) return null
    return new Uint8Array(await object.arrayBuffer())
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key)
  }
}
