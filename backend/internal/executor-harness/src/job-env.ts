// The primitive VALUE rules of the untrusted job body: what counts as a required string, which
// environment-variable names a body may never set, and how the two env-bearing fields (the
// tester's `testSecrets`, a generative integration's `capabilitySecrets`, and a frontend binding's
// `env`) are parsed against those rules.
//
// Extracted from `job.ts` when the generative-integration credentials arrived (the file-size
// ratchet: split along a cohesive seam, never raise the budget). The seam is a real one — every
// rule here answers "may this raw value become part of a child process's environment", which is
// the harness's sharpest untrusted-input boundary, and it is now shared by three parsers rather
// than being one parser's private business.

/** A required non-empty string field of the job body. */
export function str(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid job: '${path}' must be a non-empty string`)
  }
  return value
}

/**
 * Env-var names never injected from a frontend binding: spread over `process.env` at build
 * time, so any of these would break the toolchain (or enable code execution / cert overrides)
 * rather than name an upstream URL. Matched exactly (Linux env is case-sensitive); the
 * {@link RESERVED_ENV_PREFIXES} below cover whole families (`npm_config_*`, `GIT_*`, …).
 */
export const RESERVED_ENV_NAMES = new Set([
  'PATH',
  'HOME',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'BASH_ENV',
  'ENV',
  'SHELL',
  'IFS',
])

/**
 * Env-var name PREFIXES never injected from a frontend binding. `npm_config_*` reconfigures the
 * package manager (registry, scripts, prefix), and `GIT_*` reconfigures git — both run during a
 * frontend install/build, so a binding in either family is toolchain control, not an upstream URL.
 * Compared case-INSENSITIVELY (lower-cased here, matched lower-cased below): npm reads its config
 * env with a case-insensitive `/^npm_config_/i`, so `NPM_CONFIG_REGISTRY` is honoured just like
 * `npm_config_registry` — a case-sensitive prefix match would let the upper-cased form slip through.
 */
const RESERVED_ENV_PREFIXES = ['npm_config_', 'git_']

/**
 * Whether an env-var name is reserved (an exact name, or a reserved family prefix). The exact
 * names are canonical upper-case env vars matched verbatim (Linux env is case-sensitive, so a
 * distinct lower-cased `home` is a different, harmless var); the family PREFIXES are matched
 * case-insensitively because npm interprets `npm_config_*` regardless of case (see above).
 */
export function isReservedEnvName(key: string): boolean {
  if (RESERVED_ENV_NAMES.has(key)) return true
  const lower = key.toLowerCase()
  return RESERVED_ENV_PREFIXES.some((p) => lower.startsWith(p))
}

/**
 * Collect only string→string entries from a raw `env` bag. A non-string value is dropped so a
 * malformed binding can't inject `[object Object]` (or undefined) as an upstream URL. Reserved
 * names that would break the toolchain or enable injection (PATH, NODE_OPTIONS, LD_PRELOAD, …) are
 * dropped too: they are spread over `process.env` at build time, so a binding named `PATH` would
 * replace it with a URL and the build would no longer find its tools. Extracted from the infra
 * parsers to keep their cyclomatic complexity down.
 */
export function parseInfraEnv(raw: unknown): Record<string, string> {
  const env: Record<string, string> = {}
  if (typeof raw === 'object' && raw !== null) {
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
      if (key && !isReservedEnvName(key) && typeof val === 'string') env[key] = val
    }
  }
  return env
}

/**
 * One sensitive test credential the tester receives: an env-var name + its (secret) value.
 * The backend seals these at rest and decrypts them at dispatch; the harness injects each as an
 * environment variable the tester's shell can read (out of band — the value is NEVER in the
 * prompt/telemetry). See {@link parseSecretEnvPairs}.
 */
export interface TestSecretSpec {
  key: string
  value: string
}

/** A valid POSIX shell variable name (letters, digits, underscore; not starting with a digit). */
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Validate a `{ key, value }` env-pair list under `field`. Shared by the tester's `testSecrets`
 * and by `capabilitySecrets` (the credentials of a step's generative binary integrations), because
 * both are secret values the harness turns into environment variables of the agent's own process
 * and both owe the same guarantees: valid env-var names, no toolchain-critical
 * ({@link isReservedEnvName}) names, no duplicates. A second copy of these rules would be a second
 * place for a drifted body to clobber PATH.
 */
export function parseSecretEnvPairs(value: unknown, field: string): TestSecretSpec[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`Invalid job: '${field}' must be an array`)
  const entries: TestSecretSpec[] = []
  const seen = new Set<string>()
  for (const [i, raw] of value.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`Invalid job: '${field}[${i}]' must be an object`)
    }
    const entry = raw as Record<string, unknown>
    const key = str(entry.key, `${field}[${i}].key`).trim()
    if (!ENV_VAR_NAME_PATTERN.test(key)) {
      throw new Error(`Invalid job: '${field}[${i}].key' must be a valid environment variable name`)
    }
    if (isReservedEnvName(key) || seen.has(key)) continue
    seen.add(key)
    entries.push({ key, value: str(entry.value, `${field}[${i}].value`) })
  }
  return entries
}
