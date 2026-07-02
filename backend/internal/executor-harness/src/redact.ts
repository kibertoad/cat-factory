// Single source of truth for credential redaction. Two complementary rules run on
// EVERY redaction so no error path can scrub one class of secret and leak the other:
//
//  - PATTERN-based: scrubs credential SHAPES (URL userinfo, `x-access-token:<tok>`,
//    bare GitHub token prefixes, and `KEY=value` / `KEY: value` assignments whose key
//    names a credential) even when the exact value isn't known ahead of time — this is
//    what catches a freshly-minted installation token in a git error, or a plaintext
//    `POSTGRES_PASSWORD=…` echoed by a docker-compose dependency stand-up.
//  - VALUE-based: scrubs a list of KNOWN secret strings (the leased subscription
//    token + any token-like JSON leaf harvested from a credential blob).
//
// Historically these lived in two modules (git.ts pattern-only, agent-runner.ts
// value-only) and ran on disjoint paths, so a secret only one rule covered could leak
// on the other. They are unified here.

// Below this length a "known secret" is too short to scrub without mangling
// legitimate output (it would replace common substrings).
const MIN_REDACT_LEN = 6

// Only harvest token-like JSON leaves: real OAuth access/refresh tokens and ids are
// long, while short values (`auth_mode: "chatgpt"`, `type: "oauth"`, …) are non-secret
// words that would over-redact legitimate error text if scrubbed. 12 chars is a safe
// floor below which a value is not a credential.
const MIN_HARVEST_LEN = 12

// `KEY=value` / `KEY: value` assignments whose key NAMES a credential. Catches plaintext
// secrets the shape rules above miss — e.g. a docker-compose dependency echoing
// `POSTGRES_PASSWORD=hunter2` or `DATABASE_PASSWORD: hunter2` on a failed stand-up, which
// is not a token shape and is not in the known-value list (the harness never sees the
// service's own secrets). The key token is matched within a surrounding identifier so
// `DB_ACCESS_KEY`/`api_key` are covered; `auth` is deliberately excluded so it can't
// clobber a git `Author:` line. The value is the first whitespace-delimited run.
const CREDENTIAL_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:password|passwd|pwd|secret|token|key|credential)[A-Za-z0-9_]*\s*[:=]\s*)\S+/gi

// Known-secret values registered per JOB (e.g. the job's private-registry tokens),
// scrubbed on EVERY redaction — including the pattern-only `redactSecrets` call sites
// that carry no per-call secret list. Accumulating across jobs on a reused container
// is safe: redaction only ever widens.
const REGISTERED_SECRETS = new Set<string>()

/** Register known secret values to scrub on every subsequent redaction. */
export function registerKnownSecrets(values: readonly string[]): void {
  for (const value of values) {
    if (value && value.length >= MIN_REDACT_LEN) REGISTERED_SECRETS.add(value)
  }
}

/**
 * Strip credentials out of any string before it is logged or stored. Applies the
 * pattern rules (URL userinfo `https://user:pass@host`, `x-access-token:<token>`, bare
 * `ghs_`/`ghp_`/`gho_`/`github_pat_` shapes, and credential-named `KEY=value` / `KEY:
 * value` assignments) and then scrubs every supplied known-secret value plus the
 * module-registered ones ({@link registerKnownSecrets}). Idempotent — safe to call on
 * already-redacted text.
 */
export function redact(input: string, knownSecrets: readonly string[] = []): string {
  let out = input
    .replace(/(https?:\/\/)[^@\s/]*@/gi, '$1***@')
    .replace(/x-access-token:[^@\s]+/gi, 'x-access-token:***')
    .replace(/\b(gh[pso]_|github_pat_)[A-Za-z0-9_]+/g, '$1***')
    .replace(CREDENTIAL_ASSIGNMENT, '$1***')
  for (const secret of [...knownSecrets, ...REGISTERED_SECRETS]) {
    // Guard against scrubbing trivially-short values that would mangle output.
    if (secret.length >= MIN_REDACT_LEN) out = out.split(secret).join('***')
  }
  return out
}

/** Pattern + registered-value redaction. Kept for callers without a per-call secret list. */
export function redactSecrets(input: string): string {
  return redact(input)
}

/** Cap on captured command output kept on an infra record (tail-biased — failures show last). */
export const MAX_CAPTURED_OUTPUT_CHARS = 16_000

/**
 * Combine, redact and tail-bound captured stdout+stderr into a single stored string. Keeps
 * the LAST {@link MAX_CAPTURED_OUTPUT_CHARS} (where a failure's error lives), prefixed with a
 * truncation marker when trimmed. Returns undefined for empty output so a record stays sparse.
 * Shared by the docker-compose and the frontend UI-test stand-ups.
 */
export function captureRedactedOutput(stdout: unknown, stderr: unknown): string | undefined {
  const merged = [String(stdout ?? ''), String(stderr ?? '')]
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n')
  if (!merged) return undefined
  const redacted = redactSecrets(merged)
  if (redacted.length <= MAX_CAPTURED_OUTPUT_CHARS) return redacted
  return `…(${redacted.length - MAX_CAPTURED_OUTPUT_CHARS} earlier chars trimmed)\n${redacted.slice(-MAX_CAPTURED_OUTPUT_CHARS)}`
}

/** Recursively harvest token-like string leaves from a parsed JSON value. */
function collectStrings(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    if (value.length >= MIN_HARVEST_LEN) out.add(value)
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out)
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectStrings(v, out)
  }
}

/**
 * The set of secret strings to scrub from a run's stderr/output. For Claude (and the
 * Anthropic-compatible vendors GLM/Kimi/DeepSeek) the credential IS the token string,
 * so the whole-string entry covers it. For Codex the credential is a whole `auth.json`
 * blob, so we ALSO scrub every string value parsed out of it (access/refresh tokens,
 * ids): a token echoed on its OWN — not as part of the whole blob — would otherwise
 * slip past a whole-blob-only match and leak into an error message.
 */
export function secretsToRedact(subscriptionToken: string): string[] {
  const secrets = new Set<string>()
  if (subscriptionToken) secrets.add(subscriptionToken)
  try {
    collectStrings(JSON.parse(subscriptionToken), secrets)
  } catch {
    // Not JSON (a Claude OAuth token / API key) — the whole-string entry covers it.
  }
  return [...secrets]
}
