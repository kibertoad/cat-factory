// The detection half of the Cloudflare runtime-pin guard. `check-cloudflare-runtime-pins.mjs` is
// the CLI ci.yml runs; the rules live here so they can be exercised against fixtures
// (`cloudflare-runtime-pins.test.mjs`) instead of against whatever the real tree happens to hold.
//
// The invariant: ONE wrangler in the tree, and through it one workerd and one miniflare.
//
// Why it is worth a guard rather than a convention. `@cloudflare/vitest-pool-workers` pins
// `wrangler` EXACTLY, and wrangler in turn pins `workerd` and `miniflare` exactly. The Worker
// suite runs inside the POOL's workerd while `wrangler deploy` ships WRANGLER's, so the moment
// those two resolve differently the runtime the tests prove stops being the runtime that ships,
// and nothing about that failure looks like a failure: both halves are green, ~100MB of duplicate
// platform binary per arch is invisible, and the first symptom is a behaviour difference in
// production.
//
// The previous attempt at holding it was a top-level `wrangler` override, which is the wrong
// shape: an override OVERRIDES the pool's pin instead of TRACKING it. A pool bump would then be
// forced silently back to our number, leaving the pool running against a wrangler it never pinned
// (and, since the pool pins `miniflare` separately, potentially a wrangler/miniflare pair nobody
// shipped together). Asserting the RESULT catches both that and every other way a second copy can
// arrive, and it needs no network: the lockfile already knows.
//
// The second rule is `@cloudflare/workers-types`. Its version encodes a workerd date
// (`5.20260815.1` ↔ `workerd@1.20260815.1`), so a caret range floats the TYPES ahead of the
// runtime they describe: an API added in the gap typechecks green and throws at runtime. Types are
// pinned exact and to the resolved workerd's date. A `peerDependencies` range is exempt: a
// published library must accept the consumer's copy, so widening there is correct.

/** Packages whose resolved version must be unique across the whole tree. */
const SINGLETON_PACKAGES = ['wrangler', 'workerd', 'miniflare', '@cloudflare/workers-types']

/**
 * Collect every resolved version per package name from a pnpm lockfile's `packages:` section.
 *
 * Parsed by line rather than through a YAML dependency: the guard job installs nothing (that is
 * what keeps it a two-second step ahead of the build), and the shape read here is one key per
 * package, which regexes handle honestly.
 *
 * @param {string} lockfileText
 * @returns {Map<string, string[]>} name -> sorted unique versions
 */
export function collectResolvedVersions(lockfileText) {
  const versions = new Map()
  let inPackages = false
  for (const rawLine of lockfileText.split('\n')) {
    if (/^[a-zA-Z]/.test(rawLine)) {
      // A top-level key ends the section. `packages:` holds one entry per resolved package;
      // `snapshots:` repeats them with peer suffixes, so reading both would double every count.
      inPackages = rawLine.startsWith('packages:')
      continue
    }
    if (!inPackages) continue
    const match = /^ {2}'?((?:@[^/]+\/)?[^@'\s]+)@([^'\s:(]+)'?(?:\([^)]*\))*'?:\s*$/.exec(rawLine)
    if (!match) continue
    const [, name, version] = match
    const seen = versions.get(name) ?? []
    if (!seen.includes(version)) seen.push(version)
    versions.set(name, seen)
  }
  for (const list of versions.values()) list.sort()
  return versions
}

/** The workerd date a Cloudflare version string encodes (`1.20260815.1` -> `20260815`). */
export function releaseDateOf(version) {
  const match = /^\d+\.(\d{8})\./.exec(version)
  return match ? match[1] : null
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/**
 * Apply both rules and return every violation, most structural first.
 *
 * @param {object} input
 * @param {Map<string, string[]>} input.resolved  from `collectResolvedVersions`
 * @param {Array<{path: string, manifest: object}>} input.manifests  workspace package.json files
 * @returns {Array<{kind: string, where: string, message: string}>}
 */
export function findPinViolations({ resolved, manifests }) {
  const violations = []

  for (const name of SINGLETON_PACKAGES) {
    const found = resolved.get(name) ?? []
    if (found.length === 0) {
      // Absent is a violation too, and a louder one than a duplicate: it means the lockfile no
      // longer contains the package this guard is about, so every rule below would pass by
      // vacuum. A guard that reports green on an empty input is not a guard.
      violations.push({
        kind: 'missing',
        where: 'pnpm-lock.yaml',
        message: `no resolved "${name}" in the lockfile; this guard's subject is gone, so its checks would pass vacuously.`,
      })
      continue
    }
    if (found.length > 1) {
      violations.push({
        kind: 'duplicate',
        where: 'pnpm-lock.yaml',
        message:
          `${found.length} copies of "${name}" resolve (${found.join(', ')}). ` +
          `The Worker suite runs inside @cloudflare/vitest-pool-workers' workerd and wrangler deploy ships wrangler's, ` +
          `so two copies mean the tested runtime is not the shipped one. Move every declared "wrangler" to the exact ` +
          `version @cloudflare/vitest-pool-workers pins.`,
      })
    }
  }

  const wrangler = (resolved.get('wrangler') ?? [])[0]
  const workerdDate = releaseDateOf((resolved.get('workerd') ?? [])[0] ?? '')

  for (const { path, manifest } of manifests) {
    for (const field of ['dependencies', 'devDependencies']) {
      const declared = manifest[field] ?? {}

      const wranglerRange = declared.wrangler
      if (wranglerRange !== undefined) {
        if (!EXACT_VERSION.test(wranglerRange)) {
          violations.push({
            kind: 'wrangler-range',
            where: `${path} (${field})`,
            message:
              `"wrangler": "${wranglerRange}" is a range. It must be the exact version ` +
              `@cloudflare/vitest-pool-workers pins${wrangler ? ` (currently ${wrangler})` : ''}, ` +
              `or an in-range refresh floats it ahead of the pool and splits the runtime.`,
          })
        } else if (wrangler && wranglerRange !== wrangler) {
          violations.push({
            kind: 'wrangler-version',
            where: `${path} (${field})`,
            message: `"wrangler": "${wranglerRange}" disagrees with the resolved ${wrangler}.`,
          })
        }
      }

      const typesRange = declared['@cloudflare/workers-types']
      if (typesRange === undefined) continue
      if (!EXACT_VERSION.test(typesRange)) {
        violations.push({
          kind: 'types-range',
          where: `${path} (${field})`,
          message:
            `"@cloudflare/workers-types": "${typesRange}" is a range, so the types float ahead of ` +
            `the workerd wrangler pins. Pin it exactly${workerdDate ? ` at 5.${workerdDate}.1` : ''}.`,
        })
        continue
      }
      const typesDate = releaseDateOf(typesRange)
      if (workerdDate && typesDate !== workerdDate) {
        violations.push({
          kind: 'types-date',
          where: `${path} (${field})`,
          message:
            `"@cloudflare/workers-types": "${typesRange}" describes ${typesDate}, but the resolved ` +
            `workerd is ${workerdDate}. An API added in the gap typechecks green and throws in production.`,
        })
      }
    }
  }

  return violations
}
