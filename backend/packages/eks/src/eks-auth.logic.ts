import {
  EKS_ACCESS_KEY_ID_SECRET_KEY,
  EKS_SECRET_ACCESS_KEY_SECRET_KEY,
  EKS_SESSION_TOKEN_SECRET_KEY,
} from '@cat-factory/contracts'
import type { KubernetesTokenProvider } from '@cat-factory/integrations'
import type { SecretResolver } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// AWS EKS apiserver authentication.
//
// EKS does not use a static ServiceAccount bearer token. Instead the apiserver is fronted by
// the aws-iam-authenticator webhook, which accepts a token that is a base64url-encoded,
// SigV4-PRESIGNED `sts:GetCallerIdentity` URL, prefixed with `k8s-aws-v1.` — the exact token
// `aws eks get-token` / the AWS SDKs produce. The EKS cluster name is bound into the signature
// via the SIGNED header `x-k8s-aws-id`, so a token minted for one cluster cannot be replayed
// against another. The token is short-lived (~15 min), which is precisely why it can't be a
// stored static secret and must be minted per use (behind the async `KubernetesTokenProvider`
// seam in `KubernetesApiClient`).
//
// This is implemented with WebCrypto (`crypto.subtle`, HMAC-SHA256 + SHA-256) so it is
// runtime-neutral (Node + the Cloudflare Worker) and carries NO AWS SDK runtime dependency.
// The signing is a pure function of its inputs (credentials + region + cluster + timestamp),
// so it is deterministically golden-vector testable.
// ---------------------------------------------------------------------------

const ALGORITHM = 'AWS4-HMAC-SHA256'
const SERVICE = 'sts'
const CLUSTER_HEADER = 'x-k8s-aws-id'
const TOKEN_PREFIX = 'k8s-aws-v1.'
/** X-Amz-Expires for the presign. 60s is what aws-iam-authenticator uses; the k8s side accepts the token for ~15m. */
const PRESIGN_EXPIRES_SECONDS = 60

/** Static AWS credentials the SigV4 signature is computed from. */
export interface EksAwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  /** Present for temporary (STS / assume-role) credentials; folded in as `X-Amz-Security-Token`. */
  sessionToken?: string
}

export interface MintEksTokenParams {
  region: string
  clusterName: string
  credentials: EksAwsCredentials
  /** Epoch ms for `X-Amz-Date`. Injectable so the token is deterministic in tests. Defaults to `Date.now()`. */
  now?: number
  /**
   * STS host override, e.g. floci's emulated STS endpoint. Defaults to the regional public STS
   * host `sts.<region>.amazonaws.com`. Only the HOST is overridable (the scheme stays https).
   */
  stsHost?: string
}

/**
 * Mint an EKS apiserver bearer token (`k8s-aws-v1.<base64url(presigned STS URL)>`).
 * Pure + deterministic given `now`.
 */
export async function mintEksToken(params: MintEksTokenParams): Promise<string> {
  const { region, clusterName, credentials } = params
  const stsHost = params.stsHost ?? `sts.${region}.amazonaws.com`
  const now = new Date(params.now ?? Date.now())
  const amzDate = toAmzDate(now)
  const dateStamp = amzDate.slice(0, 8)
  const credentialScope = `${dateStamp}/${region}/${SERVICE}/aws4_request`

  // The presign query params (everything except the signature itself), sorted canonically.
  const query: Record<string, string> = {
    Action: 'GetCallerIdentity',
    Version: '2011-06-15',
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${credentials.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(PRESIGN_EXPIRES_SECONDS),
    'X-Amz-SignedHeaders': `host;${CLUSTER_HEADER}`,
  }
  if (credentials.sessionToken) query['X-Amz-Security-Token'] = credentials.sessionToken

  const canonicalQuery = canonicalQueryString(query)
  // The cluster name is bound via a SIGNED header — this is what makes the token cluster-scoped.
  const canonicalHeaders = `host:${stsHost}\n${CLUSTER_HEADER}:${clusterName}\n`
  const signedHeaders = `host;${CLUSTER_HEADER}`
  // STS is not S3, so a presigned GET with no body hashes the empty string (not UNSIGNED-PAYLOAD).
  const payloadHash = await sha256Hex('')
  const canonicalRequest = [
    'GET',
    '/',
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n')

  const signingKey = await deriveSigningKey(credentials.secretAccessKey, dateStamp, region)
  const signature = toHex(await hmac(signingKey, stringToSign))

  const presignedUrl = `https://${stsHost}/?${canonicalQuery}&X-Amz-Signature=${signature}`
  return TOKEN_PREFIX + base64UrlEncode(new TextEncoder().encode(presignedUrl))
}

/**
 * Build the async token provider `KubernetesApiClient` calls per request. It reads the AWS
 * credentials from the run's secret bundle and mints a token, caching it briefly so a single
 * transport call (e.g. an apply loop) mints once rather than per apiserver request.
 */
export function eksTokenProvider(
  cluster: { region: string; clusterName: string; stsHost?: string },
  resolveSecret: SecretResolver,
): KubernetesTokenProvider {
  // Refresh well before the ~15m server-side acceptance window; a fresh mint is cheap.
  const CACHE_TTL_MS = 10 * 60_000
  const REFRESH_GUARD_MS = 60_000
  let cached: { token: string; expiresAt: number } | null = null
  return async () => {
    const now = Date.now()
    if (cached && cached.expiresAt - REFRESH_GUARD_MS > now) return cached.token
    const credentials = readAwsCredentials(resolveSecret)
    const token = await mintEksToken({ ...cluster, credentials, now })
    cached = { token, expiresAt: now + CACHE_TTL_MS }
    return token
  }
}

/** Read the AWS credentials from the encrypted secret bundle. Throws if the required keys are absent. */
export function readAwsCredentials(resolveSecret: SecretResolver): EksAwsCredentials {
  const accessKeyId = resolveSecret(EKS_ACCESS_KEY_ID_SECRET_KEY)
  const secretAccessKey = resolveSecret(EKS_SECRET_ACCESS_KEY_SECRET_KEY)
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      `Missing AWS credentials for EKS ('${EKS_ACCESS_KEY_ID_SECRET_KEY}' / ` +
        `'${EKS_SECRET_ACCESS_KEY_SECRET_KEY}').`,
    )
  }
  const sessionToken = resolveSecret(EKS_SESSION_TOKEN_SECRET_KEY) || undefined
  return { accessKeyId, secretAccessKey, sessionToken }
}

// --- SigV4 primitives (WebCrypto) ------------------------------------------

/** Format an epoch Date as the SigV4 `YYYYMMDDTHHMMSSZ` basic ISO-8601 timestamp (UTC). */
function toAmzDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  )
}

/** Sort the query params by key and RFC3986-encode both key and value (including `/` in values). */
function canonicalQueryString(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${awsUriEncode(k)}=${awsUriEncode(params[k]!)}`)
    .join('&')
}

/** RFC3986 percent-encoding as AWS SigV4 requires (unreserved = A-Za-z0-9-_.~; everything else encoded). */
function awsUriEncode(value: string): string {
  let out = ''
  for (const byte of new TextEncoder().encode(value)) {
    const isUnreserved =
      (byte >= 0x41 && byte <= 0x5a) || // A-Z
      (byte >= 0x61 && byte <= 0x7a) || // a-z
      (byte >= 0x30 && byte <= 0x39) || // 0-9
      byte === 0x2d || // -
      byte === 0x2e || // .
      byte === 0x5f || // _
      byte === 0x7e // ~
    out += isUnreserved
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

/** The SigV4 signing key: HMAC chain over date → region → service → `aws4_request`. */
async function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
): Promise<Uint8Array> {
  const kDate = await hmac(new TextEncoder().encode(`AWS4${secretAccessKey}`), dateStamp)
  const kRegion = await hmac(kDate, region)
  const kService = await hmac(kRegion, SERVICE)
  return hmac(kService, 'aws4_request')
}

async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message))
  return new Uint8Array(sig)
}

async function sha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message))
  return toHex(new Uint8Array(digest))
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** URL-safe, unpadded base64 (the token envelope EKS expects). */
function base64UrlEncode(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0
    out += chars[b0 >> 2]
    out += chars[((b0 & 0x03) << 4) | (b1 >> 4)]
    if (i + 1 < bytes.length) out += chars[((b1 & 0x0f) << 2) | (b2 >> 6)]
    if (i + 2 < bytes.length) out += chars[b2 & 0x3f]
  }
  return out
}
