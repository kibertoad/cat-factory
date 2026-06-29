import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Per-user state for local mode. Local mode is a single developer running the product on
// their own machine, so machine-local secrets that have no env value live in a dotfile under
// the user's home dir — the same convention `gh` (~/.config/gh), `docker` (~/.docker/config.json)
// and `npm` (~/.npmrc) use. The point is STABILITY across restarts: a secret generated fresh
// each process start would invalidate everything signed/encrypted with the previous one (the
// persisted session JWT, credentials sealed at rest), forcing a re-login (or worse) on every
// restart. Persisting it once removes that sharp edge with no user setup.

/** The local-mode state directory: `CAT_FACTORY_STATE_DIR` (tests) else `~/.cat-factory`. */
function stateDir(): string {
  return process.env.CAT_FACTORY_STATE_DIR?.trim() || join(homedir(), '.cat-factory')
}

/**
 * Return a stable secret for {@link name}, persisted under the state dir so it survives
 * restarts. On first call it generates `randomBytes(bytes)` (in `encoding`), writes it
 * owner-only (mode 0600), and returns it; later calls (and later process starts) read it
 * back. If the filesystem can't be used (read-only home, permissions), it falls back to a
 * fresh per-process value — exactly today's behaviour — so a quirky environment never blocks
 * boot; it just won't be stable there. Callers should still let an explicit env var win
 * over this (it does in {@link applyLocalDefaults}).
 */
export function loadOrCreatePersistentSecret(
  name: string,
  { bytes = 32, encoding }: { bytes?: number; encoding: BufferEncoding },
): string {
  const dir = stateDir()
  const file = join(dir, name)
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing) return existing
  } catch {
    // Missing (first run) or unreadable — fall through to generate + persist.
  }
  const secret = randomBytes(bytes).toString(encoding)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, secret, { mode: 0o600 })
  } catch {
    // Couldn't persist (read-only FS, permissions) — use the value for this process only.
    // Behaviourally identical to the previous per-process random default.
  }
  return secret
}
