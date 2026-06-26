// Secret scrubbing for the provisioning event log. The whole point of the log is to
// capture the VERBATIM provider/runtime error so an operator can debug a failed
// spin-up — but those error strings (and the structured `detail`) routinely carry
// credentials: a 401 body echoing an `Authorization: Bearer …` header, a clone/push
// URL with embedded `user:token@`, a signed URL with a `?token=`/`?sig=` query, or a
// recognisable token shape (an OpenAI `sk-…`, a GitHub `ghp_…`/`github_pat_…`, an AWS
// `AKIA…` access key, a JWT). Since these rows are persisted for the retention window
// and served to every workspace member via `GET /provisioning-logs`, we redact at the
// single recorder choke point so EVERY emitting site is covered uniformly.

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
  // Credentials embedded in a URL userinfo: `scheme://user:secret@host`.
  {
    pattern: /([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
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
 * Best-effort scrub of credentials from a provisioning-log string (the verbatim
 * provider error or the structured `detail`). Conservative on both ends: it never
 * throws, and it keeps the surrounding context (the field name, the URL host, the
 * token scheme) so the row stays diagnostic — only the secret itself is dropped.
 * Returns `null` unchanged so callers can pass nullable fields straight through.
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
