// Where each SDK declares its version, and which of the two declarations is authoritative.
//
// Shared source of truth for the pair that would otherwise drift: `scripts/check-sdks.mjs`
// VERIFIES this invariant and `scripts/sync-sdk-versions.mjs` WRITES it, exactly as
// `scripts/runner-images.mjs` is shared between the image-tag guard and its sync.
//
// Every SDK declares its version twice — once for its package manager, once as the constant its
// transport stamps into `User-Agent` — in separate files in separate languages. The MANIFEST is
// always the source and the CONSTANT is always derived, because the manifest is what a release
// actually bumps: changesets owns the TypeScript one, and a human edits the other two (which is
// the whole publish trigger, see `.github/workflows/sdk-release.yml`).

/**
 * @typedef {object} VersionSource
 * @property {string} sdk
 * @property {{ path: string, pattern: RegExp }} manifest  The authority.
 * @property {{ path: string, pattern: RegExp }} constant  Derived from it.
 */

/** @type {VersionSource[]} */
export const VERSION_SOURCES = [
  {
    sdk: 'typescript',
    manifest: { path: 'sdk/typescript/package.json', pattern: /"version":\s*"([^"]+)"/ },
    constant: { path: 'sdk/typescript/src/http.ts', pattern: /SDK_VERSION\s*=\s*'([^']+)'/ },
  },
  {
    sdk: 'python',
    manifest: { path: 'sdk/python/pyproject.toml', pattern: /^version\s*=\s*"([^"]+)"/m },
    constant: { path: 'sdk/python/cat_factory/_http.py', pattern: /SDK_VERSION\s*=\s*"([^"]+)"/ },
  },
  {
    sdk: 'go',
    // Go modules carry no version in the source — the tag IS the version — so the constant is
    // compared against the TypeScript SDK's manifest instead, which is what keeps the family
    // moving together rather than letting Go drift on its own.
    manifest: { path: 'sdk/typescript/package.json', pattern: /"version":\s*"([^"]+)"/ },
    constant: { path: 'sdk/go/client.go', pattern: /Version\s*=\s*"([^"]+)"/ },
  },
  {
    sdk: 'java',
    manifest: {
      path: 'sdk/java/pom.xml',
      // The FIRST <version> under the project itself, not a dependency's.
      pattern: /<artifactId>cat-factory-sdk<\/artifactId>\s*<version>([^<]+)<\/version>/,
    },
    constant: {
      path: 'sdk/java/src/main/java/ai/catfactory/sdk/Transport.java',
      pattern: /SDK_VERSION\s*=\s*"([^"]+)"/,
    },
  },
]

/**
 * Read the version a file declares, or throw naming the file.
 *
 * @param {string} text
 * @param {{ path: string, pattern: RegExp }} source
 */
export function readDeclaredVersion(text, source) {
  const match = text.match(source.pattern)
  if (!match?.[1]) {
    throw new Error(`sdk versions: could not find a version in ${source.path}`)
  }
  return match[1]
}

/**
 * Rewrite the version a file declares, replacing ONLY the captured group so the surrounding
 * declaration is preserved byte for byte.
 *
 * @param {string} text
 * @param {{ path: string, pattern: RegExp }} source
 * @param {string} version
 */
export function replaceDeclaredVersion(text, source, version) {
  const match = source.pattern.exec(text)
  if (!match?.[1]) {
    throw new Error(`sdk versions: could not find a version in ${source.path}`)
  }
  const start = match.index + match[0].indexOf(match[1])
  return text.slice(0, start) + version + text.slice(start + match[1].length)
}
