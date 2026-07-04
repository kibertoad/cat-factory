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
