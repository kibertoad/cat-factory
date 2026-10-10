import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The harness's OWN version, resolved once at module load and reported on `/health`. A
// backend reads it back over the health handshake to detect a STALE or MISMATCHED executor
// (an old image left behind by a mutable tag, an outdated native install) and fail loudly
// and early — instead of the cryptic downstream symptom a version skew otherwise produces
// (e.g. a since-removed git flag reappearing and breaking every authenticated clone/push).
//
// Resolution order, most authoritative first:
//   1. `HARNESS_VERSION` env — the Docker image can bake it; an operator can override.
//   2. the version file the image writes next to `dist/` (the image deliberately ships NO
//      package.json, so it captures the version into `harness-version.txt` at build time).
//   3. `package.json` — the native/npm install and a source checkout both keep it beside
//      `dist/`, so `dist/version.js` finds it one level up.
// Undefined only for an oddly-assembled runtime carrying none of the three; the backend then
// treats "no reported version" as a strong stale signal in its own right.

function readVersionFile(dir: string, rel: string): string | undefined {
  try {
    const raw = readFileSync(join(dir, rel), 'utf8')
    const value = rel.endsWith('.json') ? (JSON.parse(raw) as { version?: string }).version : raw
    const trimmed = value?.trim()
    return trimmed || undefined
  } catch {
    return undefined
  }
}

function resolveHarnessVersion(): string | undefined {
  const fromEnv = process.env.HARNESS_VERSION?.trim()
  if (fromEnv) return fromEnv
  let dir: string
  try {
    // Compiled to `dist/version.js`; the baked file / package.json sit one level up from dist.
    dir = dirname(fileURLToPath(import.meta.url))
  } catch {
    return undefined
  }
  return readVersionFile(dir, '../harness-version.txt') ?? readVersionFile(dir, '../package.json')
}

/** The running harness version, or undefined when it cannot be determined. */
export const HARNESS_VERSION: string | undefined = resolveHarnessVersion()
