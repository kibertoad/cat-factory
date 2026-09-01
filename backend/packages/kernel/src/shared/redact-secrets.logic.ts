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

// The armor markers of a PEM-encoded private key, covering the RSA/EC/OPENSSH/ENCRYPTED/PGP
// variants. Kept as two SEPARATE patterns rather than one `BEGIN…[\s\S]*?…END` regex: see
// `redactPrivateKeyBlocks`.
const PEM_PRIVATE_KEY_BEGIN = /-----BEGIN[ A-Z0-9]*PRIVATE KEY[ A-Z0-9]*-----/g
const PEM_PRIVATE_KEY_END = /-----END[ A-Z0-9]*PRIVATE KEY[ A-Z0-9]*-----/g

/**
 * Drop PEM-armored private keys pasted verbatim, block and all. Such a block has no
 * field-name/URL/token-scheme scaffolding for the {@link RULES} shape rules to catch, so it is
 * found by its armor header and dropped wholesale, regardless of the enclosing filename (a key
 * pasted into a prompt or an ordinarily-named doc is caught too). Public certs
 * (`BEGIN CERTIFICATE`) are intentionally left untouched.
 *
 * Two markers scanned in lockstep rather than one regex with a lazy `[\s\S]*?` body, because
 * that body is unbounded: a header with no END after it makes the engine scan to end-of-string,
 * then advance to the next header and scan the same tail again, which is quadratic in the number
 * of unterminated headers (2MB of them cost ~19s). Here each marker scan only ever moves
 * FORWARD, and a header with no END terminates the whole loop rather than one iteration, since
 * no LATER header can have one either. That makes the pass strictly O(n) whatever the input
 * shape, matching the regex byte-for-byte (pinned by the equivalence cases in the test).
 *
 * An unterminated header is left in place, exactly as the regex left it: there is no second
 * delimiter to bound the drop, and guessing one would either spare a key body or swallow
 * unrelated text to end-of-string.
 */
function redactPrivateKeyBlocks(value: string): string {
  PEM_PRIVATE_KEY_BEGIN.lastIndex = 0
  let begin = PEM_PRIVATE_KEY_BEGIN.exec(value)
  if (begin === null) return value
  let out = ''
  let copiedTo = 0
  while (begin !== null) {
    PEM_PRIVATE_KEY_END.lastIndex = begin.index + begin[0].length
    const end = PEM_PRIVATE_KEY_END.exec(value)
    if (end === null) break
    out += value.slice(copiedTo, begin.index) + REPLACEMENT
    copiedTo = end.index + end[0].length
    PEM_PRIVATE_KEY_BEGIN.lastIndex = copiedTo
    begin = PEM_PRIVATE_KEY_BEGIN.exec(value)
  }
  return copiedTo === 0 ? value : out + value.slice(copiedTo)
}

// An environment variable's NAME (`OPENAI_API_KEY`), which an error naming a missing setting
// interpolates and no vendor emits a credential in the shape of. The underscore is required:
// without it this would also spare an uppercase hex or base32 token.
const ENV_VAR_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/
// One word in ONE case convention (`expected`, `AUTHENTICATION`, `Missing`). Mixed case inside a
// purely-alphabetic run is the tell that it is not a word: short base64 (`dXNlcjpwYXNz`) is
// alphabetic too, and that is exactly what a `Basic ` prefix carries.
const PROSE_WORD = /^(?:[a-z]+|[A-Z]+|[A-Z][a-z]+)$/
// Above this length a purely-alphabetic single-case run stops reading as an English word. The
// words that actually appear after these field names in error prose ("expected", "required",
// "authentication") are all well under it.
const MIN_ALPHABETIC_SECRET_CHARS = 16

/**
 * Whether a value captured by a FIELD-NAME rule is plausibly a credential rather than the next
 * word of a sentence.
 *
 * The field-name rules key off a name (`key`, `signature`, `token`, `basic`), and those names are
 * ordinary English that appears in ordinary error prose. Unguarded they turned "Missing required
 * key: OPENAI_API_KEY" into "Missing required key: [REDACTED]" — deleting the one identifier the
 * operator has to go and set — and "basic authentication failed" into "basic [REDACTED] failed".
 * That was survivable while scrubbing was confined to log fields; it is not now that the same
 * text is the message a person reads on a form and the `reason` persisted on a failed run.
 *
 * Deliberately asymmetric, in the direction the surrounding module already declares: this is a
 * best-effort net over the structural allow-lists, so it gives up an all-lowercase dictionary
 * word used as a password (`password=letmein`) to stop mangling every sentence that contains the
 * word "key". Every credential SHAPE the rules exist for still matches, because real ones carry a
 * digit, a symbol, mixed case, or length.
 *
 * An absent capture group answers `true`: a rule that matched without producing a value has told
 * us nothing about the value, and the safe reading of nothing is "secret".
 */
function looksLikeSecretValue(value: string): boolean {
  if (ENV_VAR_NAME.test(value)) return false
  return !(value.length < MIN_ALPHABETIC_SECRET_CHARS && PROSE_WORD.test(value))
}

// Each rule matches a secret-bearing fragment; the capture group(s) bracket the literal
// prefix to keep (so the reader still sees WHAT was redacted) and the secret to drop.
const RULES: { pattern: RegExp; replace: (m: RegExpMatchArray) => string }[] = [
  // `Authorization: Bearer <token>` / `Bearer <token>` (case-insensitive scheme).
  {
    pattern: /\b(bearer|basic|token)\s+([A-Za-z0-9._+/=~-]{8,})/gi,
    replace: (m) => (looksLikeSecretValue(m[2] ?? '') ? `${m[1]} ${REPLACEMENT}` : (m[0] ?? '')),
  },
  // `Authorization: <anything>` / `x-api-key: <anything>` header echoes.
  {
    pattern:
      /\b(authorization|x-api-key|x-auth-token|proxy-authorization)(["']?\s*[:=]\s*["']?)([^\s"',}]+)/gi,
    replace: (m) => `${m[1]}${m[2]}${REPLACEMENT}`,
  },
  // Credentials embedded in a URL userinfo: `scheme://user:secret@host`. The scheme run is
  // length-bounded (a real scheme is short) so a long non-URL string can't make the greedy
  // scheme scan-then-backtrack at every offset, and it sits in a LOOKBEHIND rather than a
  // leading capture so the pattern's first obligation at each offset is the literal `://`.
  // A leading `[a-z]` made the engine walk that bounded run at every position of any
  // alphanumeric text before failing: ~40 steps per character, which costs ~130ms per 512KB
  // of base64 or minified source and made scrubbing one large context file the dominant cost
  // of recording a snapshot. Behind the lookbehind the same offsets reject on a single
  // character comparison (~2ms per 512KB), matching identically: the scheme is not consumed,
  // so it survives in the output untouched instead of being re-emitted by the replacement.
  {
    pattern: /(?<=[a-z][a-z0-9+.-]{0,39}:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    replace: (m) => `${m[1]}:${REPLACEMENT}@`,
  },
  // Secret-ish query/JSON params: token, key, secret, password, sig, signature,
  // api_key/apikey, access_token, client_secret, etc. (`?token=…` or `"token":"…"`).
  {
    pattern:
      /\b((?:access[_-]?)?(?:api[_-]?)?(?:client[_-]?)?(?:token|secret|password|passwd|pwd|sig|signature|key|apikey|auth))(["']?\s*[:=]\s*["']?)([^\s"',&}@/]{4,})/gi,
    replace: (m) =>
      looksLikeSecretValue(m[3] ?? '') ? `${m[1]}${m[2]}${REPLACEMENT}` : (m[0] ?? ''),
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
  // PEM blocks FIRST, so a later field-name rule (e.g. a `key:` echo preceding the block)
  // can't consume the `-----BEGIN` marker and leave the body behind.
  let out = redactPrivateKeyBlocks(value)
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

/**
 * Scrub a flat `key -> value` bag, giving each value its OWN KEY as scrubbing context.
 *
 * {@link redactSecretsDeep} is the wrong tool for one: it walks to the string LEAF and scrubs it
 * alone, so a bag whose secret is `{ apiToken: "9f2c…" }` keeps it: every field-name rule needs
 * the name, and by the time the walk reaches the value the name is gone. The bag shape is exactly
 * how a provider's captured provision fields arrive, and that bag is now read by something other
 * than teardown, so the gap became reachable.
 *
 * Implemented by scrubbing the rendered `key=value` pair and slicing the key back off, so there is
 * ONE rule set rather than a second list of secret-ish names to drift from the first. Every rule
 * that matches a name preserves the name and separator it matched, so the prefix is stable.
 */
export function redactSecretFields(
  fields: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(fields)) {
    const prefix = `${key}=`
    const scrubbed = redactSecrets(`${prefix}${value}`) ?? ''
    out[key] = scrubbed.startsWith(prefix) ? scrubbed.slice(prefix.length) : scrubbed
  }
  return out
}
