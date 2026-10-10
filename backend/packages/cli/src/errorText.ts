// How the CLI turns a THROWN VALUE into the one line it writes to stderr before exiting.
//
// This is a deliberate COPY of `getErrorMessage` in `@cat-factory/kernel`
// (`src/shared/error-chain.logic.ts` over `src/shared/redact-secrets.logic.ts`), for the same
// reason the executor-harness copies `hostMarkdown`: this package is PUBLISHED and stays runtime
// dependency-free (its only `dependencies` entry is `@clack/prompts`), so a `workspace:*` package
// it imports at runtime would resolve locally through pnpm's link and be missing the moment
// someone runs `npx cat-factory` off the registry. `errorText.conformity.test.ts` pins the two to
// byte-identical output over a shared corpus, so the copy cannot drift: change one, change the
// other. Kernel stays a devDependency, which is what lets that test import it.
//
// Why the CLI wants the chain at all: on Node a transport failure IS a bare `TypeError: fetch
// failed`, and what actually happened (`connect ECONNREFUSED`, `self-signed certificate`,
// `getaddrinfo ENOTFOUND`) hangs off `.cause`. `cat-factory` bootstraps against GitHub, a Docker
// daemon and a k3s cluster, so "fetch failed" as the last thing a failed bootstrap prints is the
// least useful sentence available.

const REPLACEMENT = '[REDACTED]'
const PEM_PRIVATE_KEY_BEGIN = /-----BEGIN[ A-Z0-9]*PRIVATE KEY[ A-Z0-9]*-----/g
const PEM_PRIVATE_KEY_END = /-----END[ A-Z0-9]*PRIVATE KEY[ A-Z0-9]*-----/g

/** Drop PEM-armored private keys pasted verbatim, block and all (kernel's `redactPrivateKeyBlocks`). */
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

const ENV_VAR_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/
const PROSE_WORD = /^(?:[a-z]+|[A-Z]+|[A-Z][a-z]+)$/
const MIN_ALPHABETIC_SECRET_CHARS = 16

/** Whether a field-name rule's captured value is a credential rather than the next word of a sentence. */
function looksLikeSecretValue(value: string): boolean {
  if (ENV_VAR_NAME.test(value)) return false
  return !(value.length < MIN_ALPHABETIC_SECRET_CHARS && PROSE_WORD.test(value))
}

const RULES: { pattern: RegExp; replace: (m: RegExpMatchArray) => string }[] = [
  {
    pattern: /\b(bearer|basic|token)\s+([A-Za-z0-9._+/=~-]{8,})/gi,
    replace: (m) => (looksLikeSecretValue(m[2] ?? '') ? `${m[1]} ${REPLACEMENT}` : (m[0] ?? '')),
  },
  {
    pattern:
      /\b(authorization|x-api-key|x-auth-token|proxy-authorization)(["']?\s*[:=]\s*["']?)([^\s"',}]+)/gi,
    replace: (m) => `${m[1]}${m[2]}${REPLACEMENT}`,
  },
  {
    pattern: /(?<=[a-z][a-z0-9+.-]{0,39}:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    replace: (m) => `${m[1]}:${REPLACEMENT}@`,
  },
  {
    pattern:
      /\b((?:access[_-]?)?(?:api[_-]?)?(?:client[_-]?)?(?:token|secret|password|passwd|pwd|sig|signature|key|apikey|auth))(["']?\s*[:=]\s*["']?)([^\s"',&}@/]{4,})/gi,
    replace: (m) =>
      looksLikeSecretValue(m[3] ?? '') ? `${m[1]}${m[2]}${REPLACEMENT}` : (m[0] ?? ''),
  },
  { pattern: /\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, replace: () => REPLACEMENT },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: () => REPLACEMENT },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: () => REPLACEMENT },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: () => REPLACEMENT },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => REPLACEMENT },
  {
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replace: () => REPLACEMENT,
  },
]

/** Best-effort scrub of credentials from a string (kernel's `redactSecrets`, non-null input only). */
function redactSecrets(value: string): string {
  let out = redactPrivateKeyBlocks(value)
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (...args) => {
      const groups = args.slice(0, -2) as string[]
      return rule.replace(groups as unknown as RegExpMatchArray)
    })
  }
  return out
}

const MAX_ERROR_CHAIN_CHARS = 400
const MAX_CHAIN_DEPTH = 6
const MAX_AGGREGATE_BRANCHES = 8
const TRANSPORT_CODE = /^[A-Z][A-Z0-9_]*$/

function readProperty(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

function safeText(value: unknown): string {
  try {
    return String(value)
  } catch {
    return ''
  }
}

function errorCode(error: unknown): string | undefined {
  const code = readProperty(error, 'code')
  return typeof code === 'string' && code ? code : undefined
}

function aggregated(error: unknown): unknown[] {
  const errors = readProperty(error, 'errors')
  return Array.isArray(errors) ? errors : []
}

function flattenErrorChain(
  error: unknown,
  depth = 0,
  out: unknown[] = [],
  seen: Set<unknown> = new Set(),
): unknown[] {
  if (error === null || error === undefined || depth > MAX_CHAIN_DEPTH) return out
  if (typeof error === 'object') {
    if (seen.has(error)) return out
    seen.add(error)
  }
  out.push(error)
  const branches = aggregated(error)
  for (const branch of branches.slice(0, MAX_AGGREGATE_BRANCHES))
    flattenErrorChain(branch, depth + 1, out, seen)
  if (branches.length > MAX_AGGREGATE_BRANCHES)
    out.push(`[…${branches.length - MAX_AGGREGATE_BRANCHES} more branches not read]`)
  flattenErrorChain(readProperty(error, 'cause'), depth + 1, out, seen)
  return out
}

function describeErrorLink(link: unknown): string {
  const message = link instanceof Error ? readProperty(link, 'message') : link
  const code = errorCode(link)
  const text = safeText(message ?? '').trim()
  if (!code || !TRANSPORT_CODE.test(code)) return text || code || ''
  if (!text) return code
  return text.includes(code) ? text : `${text} (${code})`
}

function renderErrorChainLinks(links: readonly unknown[]): string[] {
  const counts = new Map<string, number>()
  for (const link of links) {
    const text = describeErrorLink(link)
    if (!text) continue
    counts.set(text, (counts.get(text) ?? 0) + 1)
  }
  return [...counts].map(([text, count]) => (count > 1 ? `${text} (x${count})` : text))
}

function joinErrorChain(parts: readonly string[]): string {
  const text = redactSecrets(parts.join(': '))
  if (text.length <= MAX_ERROR_CHAIN_CHARS) return text
  const dropped = text.length - MAX_ERROR_CHAIN_CHARS
  return `${text.slice(0, MAX_ERROR_CHAIN_CHARS)} […${dropped} more characters of the cause chain]`
}

/**
 * A thrown value as ONE line: its own message, then each cause beneath it, scrubbed and capped.
 * Byte-for-byte kernel's `getErrorMessage` — see the header, and the conformity test beside it.
 */
export function getErrorMessage(error: unknown): string {
  const parts = renderErrorChainLinks(flattenErrorChain(error))
  if (parts.length > 0) return joinErrorChain(parts)
  if (error instanceof Error) {
    const name = readProperty(error, 'name')
    return typeof name === 'string' && name && name !== Error.name ? joinErrorChain([name]) : ''
  }
  return joinErrorChain([safeText(error)])
}
