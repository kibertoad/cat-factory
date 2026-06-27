import type {
  DeleteObjectCommand as DeleteObjectCommandType,
  GetObjectCommand as GetObjectCommandType,
  PutObjectCommand as PutObjectCommandType,
  S3Client,
  S3ClientConfig,
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

/** The slice of `@aws-sdk/client-s3` we use, loaded lazily (see {@link loadSdk}). */
interface S3Sdk {
  S3Client: new (config: S3ClientConfig) => S3Client
  PutObjectCommand: typeof PutObjectCommandType
  GetObjectCommand: typeof GetObjectCommandType
  DeleteObjectCommand: typeof DeleteObjectCommandType
}

/**
 * AWS S3 (or S3-compatible) blob backend for binary artifacts. Implements the kernel
 * {@link BinaryBlobBackend} port; the metadata still lives in the runtime's DB. Opt-in:
 * a deployment selects it via `BINARY_STORAGE_BACKEND=s3`.
 *
 * The (heavy) `@aws-sdk/client-s3` is imported LAZILY on first use, not at module load:
 * a facade statically imports this class to wire its container, but a deployment that
 * runs the `db` (or no) blob backend then never pays the SDK's load cost — the SDK is
 * only pulled in when an S3 operation actually executes.
 */
export class S3BinaryBlobBackend implements BinaryBlobBackend {
  readonly kind = 's3' as const
  private readonly bucket: string
  private readonly prefix: string
  /** Cached, lazily-built `{ sdk, client }` so the AWS SDK loads at most once on first I/O. */
  private clientPromise: Promise<{ sdk: S3Sdk; client: S3Client }> | undefined

  constructor(private readonly config: S3BinaryBlobBackendConfig) {
    this.bucket = config.bucket
    this.prefix = config.prefix ? config.prefix.replace(/\/+$/, '') + '/' : ''
  }

  /** Dynamically import the AWS SDK and build the client (memoised). */
  private async resolveClient(): Promise<{ sdk: S3Sdk; client: S3Client }> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const sdk = (await import('@aws-sdk/client-s3')) as unknown as S3Sdk
        const clientConfig: S3ClientConfig = { region: this.config.region }
        if (this.config.endpoint) clientConfig.endpoint = this.config.endpoint
        if (this.config.forcePathStyle) clientConfig.forcePathStyle = this.config.forcePathStyle
        if (this.config.credentials) clientConfig.credentials = this.config.credentials
        return { sdk, client: new sdk.S3Client(clientConfig) }
      })()
    }
    return this.clientPromise
  }

  private fullKey(key: string): string {
    return `${this.prefix}${key}`
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const { sdk, client } = await this.resolveClient()
    await client.send(
      new sdk.PutObjectCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
        Body: bytes,
        ContentType: contentType,
      }),
    )
  }

  async get(key: string): Promise<Uint8Array | null> {
    const { sdk, client } = await this.resolveClient()
    try {
      const out = await client.send(
        new sdk.GetObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
      )
      if (!out.Body) return null
      return new Uint8Array(await out.Body.transformToByteArray())
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') return null
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    const { sdk, client } = await this.resolveClient()
    await client.send(new sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }))
  }
}
