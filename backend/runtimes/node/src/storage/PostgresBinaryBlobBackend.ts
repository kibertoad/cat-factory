import type { BinaryBlobBackend } from '@cat-factory/kernel'
import { eq } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import { binaryArtifactBlobs } from '../db/schema.js'

/**
 * Default Node/local blob backend: store the bytes in a Postgres `bytea` table
 * (`binary_artifact_blobs`). Used when `BINARY_STORAGE_BACKEND=db`. There is no
 * Cloudflare equivalent — D1 can't hold large values, so the Worker uses R2.
 *
 * Postgres tolerates large `bytea` values, but a screenshot store should not become
 * an accidental large-object dump, so the backend guards against absurd blobs.
 */
const MAX_DB_BLOB_BYTES = 16 * 1024 * 1024 // 16 MiB — generous for a PNG, a hard ceiling.

export class PostgresBinaryBlobBackend implements BinaryBlobBackend {
  readonly kind = 'db' as const

  constructor(private readonly db: DrizzleDb) {}

  async put(key: string, bytes: Uint8Array, _contentType: string): Promise<void> {
    if (bytes.byteLength > MAX_DB_BLOB_BYTES) {
      throw new Error(
        `Binary artifact (${bytes.byteLength} bytes) exceeds the ${MAX_DB_BLOB_BYTES}-byte ` +
          'limit for the Postgres DB blob backend; configure R2/S3 storage for large artifacts.',
      )
    }
    await this.db
      .insert(binaryArtifactBlobs)
      .values({ storage_key: key, bytes })
      .onConflictDoUpdate({ target: binaryArtifactBlobs.storage_key, set: { bytes } })
  }

  async get(key: string): Promise<Uint8Array | null> {
    const rows = await this.db
      .select()
      .from(binaryArtifactBlobs)
      .where(eq(binaryArtifactBlobs.storage_key, key))
      .limit(1)
    return rows[0] ? rows[0].bytes : null
  }

  async delete(key: string): Promise<void> {
    await this.db.delete(binaryArtifactBlobs).where(eq(binaryArtifactBlobs.storage_key, key))
  }
}
