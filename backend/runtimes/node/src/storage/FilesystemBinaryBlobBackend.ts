import { mkdirSync } from 'node:fs'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { BinaryBlobBackend } from '@cat-factory/kernel'

/** Default base directory (relative to the process cwd, i.e. the repo root in dev). */
export const DEFAULT_FILE_STORAGE_PATH = '.file-storage'

/**
 * On-disk blob backend for the Node/local facades: store each artifact's bytes as a file
 * under {@link basePath} (default `.file-storage`, git-ignored). The bytes' key is the
 * store's `${workspaceId}/${id}` locator, so files are nested one directory per workspace.
 * There is no Cloudflare equivalent (workerd has no filesystem) — exactly like the Postgres
 * `bytea` backend, which is also Node/local-only.
 *
 * Configured per-account in the UI (the local facade defaults to it; Node requires it to be
 * selected). The base directory is created up-front so the path exists from boot.
 *
 * IMPORTANT: this is local-disk storage. It is correct for local mode and a single-instance
 * Node deployment backed by a persistent volume, but it is NOT safe for a scaled (multi-replica)
 * deployment or one with an ephemeral disk: bytes written by one instance are invisible to the
 * others and are lost on redeploy. Such deployments should configure the `s3` backend instead.
 */
export class FilesystemBinaryBlobBackend implements BinaryBlobBackend {
  readonly kind = 'fs' as const

  private readonly basePath: string

  constructor({ basePath }: { basePath?: string }) {
    this.basePath = resolve(basePath?.trim() || DEFAULT_FILE_STORAGE_PATH)
    // Create the base directory eagerly so "the newly created .file-storage directory"
    // exists from boot rather than only appearing on the first upload.
    mkdirSync(this.basePath, { recursive: true })
  }

  /**
   * Resolve a storage key to an absolute on-disk path, refusing any key that would escape
   * the base directory (defence-in-depth: keys are internally generated as `ws/id`, but a
   * `..` segment must never let a write/read reach outside the store).
   */
  private pathFor(key: string): string {
    const full = resolve(this.basePath, key)
    const rel = relative(this.basePath, full)
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Invalid artifact storage key (escapes the storage root): ${key}`)
    }
    return full
  }

  async put(key: string, bytes: Uint8Array, _contentType: string): Promise<void> {
    const path = this.pathFor(key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const buf = await readFile(this.pathFor(key))
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.pathFor(key))
    } catch (err) {
      // Idempotent: a missing file is a successful delete (matches the store's delete/prune
      // semantics, which tolerate already-gone bytes).
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
}
