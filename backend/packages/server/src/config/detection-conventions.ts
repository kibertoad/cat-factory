import type { EnvironmentsConfig } from './types.js'

// Parse the optional deployment-level provisioning-DETECTION convention extensions from a single
// env var, so both facades read the same house-convention overrides the same way. The value is a
// JSON object with any of the string-array fields `composeFiles` / `composeDirs` / `seedDirs` /
// `envTemplateDirs` / `manifestDirs` / `serviceManifestPaths`; anything else (unset / blank /
// malformed / non-object / empty) yields undefined, i.e. the built-in detection behaviour. A
// convention EXTENSION is never critical, so malformed JSON degrades to "built-in" rather than
// failing config load. See `EnvironmentsConfig.detectionConventions`.

export type DetectionConventionsConfig = NonNullable<EnvironmentsConfig['detectionConventions']>

/** Coerce an unknown into a non-empty, trimmed string[] (dropping blanks), or undefined. */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
  return out.length > 0 ? out : undefined
}

/**
 * Parse `ENVIRONMENTS_DETECTION_CONVENTIONS` (a JSON object) into the config shape, or undefined
 * when unset/blank/malformed/empty. Only the known array fields are read; unknown keys and
 * non-string entries are ignored.
 */
export function parseDetectionConventions(
  raw: string | undefined,
): DetectionConventionsConfig | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const src = parsed as Record<string, unknown>
  const result: DetectionConventionsConfig = {}
  const composeFiles = stringList(src.composeFiles)
  if (composeFiles) result.composeFiles = composeFiles
  const composeDirs = stringList(src.composeDirs)
  if (composeDirs) result.composeDirs = composeDirs
  const seedDirs = stringList(src.seedDirs)
  if (seedDirs) result.seedDirs = seedDirs
  const envTemplateDirs = stringList(src.envTemplateDirs)
  if (envTemplateDirs) result.envTemplateDirs = envTemplateDirs
  const manifestDirs = stringList(src.manifestDirs)
  if (manifestDirs) result.manifestDirs = manifestDirs
  const serviceManifestPaths = stringList(src.serviceManifestPaths)
  if (serviceManifestPaths) result.serviceManifestPaths = serviceManifestPaths
  return Object.keys(result).length > 0 ? result : undefined
}
