// Shared, dependency-free secret scrubbing for any string that is persisted or shipped
// off-box and might carry a credential: a provisioning-log error, an LLM prompt/response
// captured for telemetry, a trace fanned out to an external sink. It drops the common
// secret-bearing fragments — an `Authorization: Bearer …` echo, a `user:token@` URL
// userinfo, a `?token=`/`?sig=` query or `"secret":"…"` JSON field, and the recognisable
// standalone token shapes (OpenAI `sk-…`, GitHub `ghp_…`/`github_pat_…`, Slack `xoxb-…`,
// AWS `AKIA…`, a JWT) — while keeping the surrounding context (field name, URL host, token
// scheme) so the redacted string stays diagnostic. Best-effort and never throws; it is a
// safety net over the structural allow-lists, not a substitute for them.

const REPLACEMENT = '[REDACTED]'

// Each rule matches a secret-bearing fragment; the capture group(s) bracket the literal
// prefix to keep (so the reader still sees WHAT was redacted) and the secret to drop.
const RULES: { pattern: RegExp; replace: (m: RegExpMatchArray) => string }[] = [
  // PEM-armored private keys pasted verbatim (`-----BEGIN … PRIVATE KEY-----` …
  // `-----END … PRIVATE KEY-----`), covering RSA/EC/OPENSSH/ENCRYPTED/PGP variants. Such a
  // block has no field-name/URL/token-scheme scaffolding for the shape rules below to catch,
  // so it is matched on its armor header and dropped wholesale — regardless of the enclosing
  // filename, so a key pasted into a prompt or an ordinarily-named doc is caught too. The
  // body is `[\s\S]*?` (non-greedy, bounded by the literal END marker), so no catastrophic
  // backtracking. Runs FIRST so a later field-name rule (e.g. a `key:` echo preceding the
  // block) can't consume the `-----BEGIN` marker and leave the body behind. Public certs
  // (`BEGIN CERTIFICATE`) are intentionally left untouched.
  {
    pattern:
      /-----BEGIN[ A-Z0-9]*PRIVATE KEY[ A-Z0-9]*-----[\s\S]*?-----END[ A-Z0-9]*PRIVATE KEY[ A-Z0-9]*-----/g,
    replace: () => REPLACEMENT,
  },
  // `Authorization: Bearer <token>` / `Bearer <token>` (case-insensitive scheme).
  {
    pattern: /\b(bearer|basic|token)\s+([A-Za-z0-9._+/=~-]{8,})/gi,
    replace: (m) => `${m[1]} ${REPLACEMENT}`,
  },
  // `Authorization: <anything>` / `x-api-key: <anything>` header echoes.
  {
    pattern:
      /\b(authorization|x-api-key|x-auth-token|proxy-authorization)(["']?\s*[:=]\s*["']?)([^\s"',}]+)/gi,
    replace: (m) => `${m[1]}${m[2]}${REPLACEMENT}`,
  },
  // Credentials embedded in a URL userinfo: `scheme://user:secret@host`. The scheme run
  // is length-bounded (a real scheme is short) so a long non-URL string can't make the
  // greedy scheme scan-then-backtrack at every offset — that turned this rule O(n²).
  {
    pattern: /([a-z][a-z0-9+.-]{0,39}:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    replace: (m) => `${m[1]}${m[2]}:${REPLACEMENT}@`,
  },
  // Secret-ish query/JSON params: token, key, secret, password, sig, signature,
  // api_key/apikey, access_token, client_secret, etc. (`?token=…` or `"token":"…"`).
  {
    pattern:
      /\b((?:access[_-]?)?(?:api[_-]?)?(?:client[_-]?)?(?:token|secret|password|passwd|pwd|sig|signature|key|apikey|auth))(["']?\s*[:=]\s*["']?)([^\s"',&}@/]{4,})/gi,
    replace: (m) => `${m[1]}${m[2]}${REPLACEMENT}`,
  },
  // Recognisable standalone token shapes, regardless of surrounding context.
  { pattern: /\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, replace: () => REPLACEMENT },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: () => REPLACEMENT },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: () => REPLACEMENT },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: () => REPLACEMENT },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => REPLACEMENT },
  // JWTs (three dot-separated base64url segments starting with the `eyJ` header).
  {
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replace: () => REPLACEMENT,
  },
]

/**
 * Best-effort scrub of credentials from a string. Conservative on both ends: it never
 * throws, and it keeps the surrounding context (the field name, the URL host, the token
 * scheme) so the value stays useful — only the secret itself is dropped. Returns `null`
 * unchanged so callers can pass nullable fields straight through.
 */
export function redactSecrets(value: string | null): string | null {
  if (value == null) return value
  let out = value
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (...args) => {
      // String.replace passes (match, ...groups, offset, string); reconstruct the
      // RegExpMatchArray shape our `replace` callbacks expect (match + groups).
      const groups = args.slice(0, -2) as string[]
      return rule.replace(groups as unknown as RegExpMatchArray)
    })
  }
  return out
}

// Filenames whose ENTIRE content is a credential, so a shape-based `redactSecrets` scrub of
// the body is not enough — the whole file body is dropped rather than stored. These are the
// canonical secret-bearing files an operator might attach as agent context (a `.env`, a PEM
// private key, an SSH key, an npm/pg auth file): a body that is purely a private key or a
// dump of `KEY=value` pairs has no field-name/URL scaffolding for the pattern rules to latch
// onto, so it would otherwise be persisted verbatim. Matched against the file's basename.
const SECRET_BASENAME_EXACT: ReadonlySet<string> = new Set([
  'credentials', // AWS shared credentials
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
])

// Suffixes (checked against the lowercased basename) that mark a secret-bearing file.
// `.env` and its variants (`.env.local`, `.env.production`) are covered by the `.env`
// prefix check below rather than a suffix.
const SECRET_SUFFIXES: readonly string[] = [
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.pkcs12',
  '.asc', // armored PGP key/signature
  '.ppk', // PuTTY private key
  '.p8', // PKCS#8 private key (also Apple auth keys)
  '.pkcs8',
]

// Dotfiles whose whole purpose is to carry a credential — matched as the basename or a
// prefix (so `.npmrc` and `.env.production` both hit).
const SECRET_DOTFILE_PREFIXES: readonly string[] = [
  '.env',
  '.npmrc',
  '.netrc',
  '.pgpass',
  '.htpasswd',
  '.git-credentials', // git's plaintext credential store (`https://user:token@host`)
  '.dockercfg', // legacy Docker registry auth
]

/**
 * Whether a context-file path names a file whose body is intrinsically a credential (a
 * `.env`, a `*.pem`/`*.key` private key, an SSH key, an `.npmrc`, …). A shape-based
 * {@link redactSecrets} scrub can miss such a body — a raw PEM block or a `KEY=value` dump
 * has none of the field-name/URL/token-scheme scaffolding the pattern rules key off — so
 * callers that persist injected file bodies should drop the WHOLE body for these rather
 * than store it verbatim. Best-effort and dependency-free; matched on the basename only, so
 * directory segments never widen the match. Returns `false` for an empty/relative-less path.
 */
export function isSecretShapedFilename(path: string | null | undefined): boolean {
  if (!path) return false
  // Take the basename regardless of separator (`/` or `\`), strip any trailing slash.
  const base = path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop()
    ?.toLowerCase()
  if (!base) return false
  if (SECRET_BASENAME_EXACT.has(base)) return true
  if (SECRET_SUFFIXES.some((suffix) => base.endsWith(suffix))) return true
  // `.env` / `.env.local` / `.npmrc` — a dotfile whose name starts with a known prefix.
  if (SECRET_DOTFILE_PREFIXES.some((prefix) => base === prefix || base.startsWith(`${prefix}.`)))
    return true
  return false
}

/**
 * Recursively apply {@link redactSecrets} to every string reachable inside a JSON-shaped
 * value — the strings inside a nested object or array, at any depth — leaving non-string
 * leaves (numbers, booleans, `null`) and the surrounding structure untouched. The
 * structural shape is returned unchanged (the return type mirrors the input), so a caller
 * that persists a free-text-bearing `Record<string, unknown>` bag (e.g. an agent-context
 * snapshot's `extras`, whose values include human-authored decision/feedback prose) can
 * guarantee NO string in it lands verbatim, without enumerating which keys are free text.
 * Best-effort and never throws, mirroring {@link redactSecrets}.
 */
export function redactSecretsDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T
  if (Array.isArray(value)) return value.map((item) => redactSecretsDeep(item)) as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = redactSecretsDeep(item)
    return out as T
  }
  return value
}
