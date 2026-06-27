import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'
import type { BinaryBlobBackend } from '@cat-factory/kernel'

export interface S3BinaryBlobBackendConfig {
  region: string
  bucket: string
  /** Optional key prefix, e.g. `artifacts/`. Joined to the artifact's storage key. */
  prefix?: string
  /** Optional custom endpoint (S3-compatible stores: MinIO, etc.). */
  endpoint?: string
  /** Force path-style addressing (needed by most S3-compatible stores). */
  forcePathStyle?: boolean
  /** Explicit credentials; omit to use the default AWS credential chain. */
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
}

/**
 * AWS S3 (or S3-compatible) blob backend for binary artifacts. Implements the kernel
 * {@link BinaryBlobBackend} port; the metadata still lives in the runtime's DB. Opt-in:
 * a deployment selects it via `BINARY_STORAGE_BACKEND=s3`.
 */
export class S3BinaryBlobBackend implements BinaryBlobBackend {
  readonly kind = 's3' as const
  private readonly client: S3Client
  private readonly bucket: string
  private readonly prefix: string

  constructor(config: S3BinaryBlobBackendConfig) {
    const clientConfig: S3ClientConfig = { region: config.region }
    if (config.endpoint) clientConfig.endpoint = config.endpoint
    if (config.forcePathStyle) clientConfig.forcePathStyle = config.forcePathStyle
    if (config.credentials) clientConfig.credentials = config.credentials
    this.client = new S3Client(clientConfig)
    this.bucket = config.bucket
    this.prefix = config.prefix ? config.prefix.replace(/\/+$/, '') + '/' : ''
  }

  private fullKey(key: string): string {
    return `${this.prefix}${key}`
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
        Body: bytes,
        ContentType: contentType,
      }),
    )
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
      )
      if (!out.Body) return null
      return new Uint8Array(await out.Body.transformToByteArray())
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') return null
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }))
  }
}
