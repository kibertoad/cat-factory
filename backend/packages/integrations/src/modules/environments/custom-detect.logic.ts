import type {
  DetectedManifestTypeCandidate,
  ProvisioningCustomConfigSeed,
  ProvisioningDetectionNote,
  ProvisioningRecommendation,
} from '@cat-factory/contracts'
import type { CustomManifestDetection, CustomManifestDetectionContext } from '@cat-factory/kernel'
import { BudgetedRepoScanner, joinRepoPath } from '@cat-factory/kernel'
import type { RegisteredCustomManifestType } from './custom-manifest-types.js'
import { READ_BUDGET, type ProvisioningRepoReader } from './provision-detect.logic.js'
import { RepoReadError } from './repo-read-error.js'

// ---------------------------------------------------------------------------
// CUSTOM-provider autodetection: the `detect()`-hook-aware manifest-path resolution + the
// cross-provider ARBITRATION sweep. Split out of `provision-detect.logic.ts` (which owns the
// kubernetes/compose heuristics) so each file stays within its size budget and the custom
// concern reads as one cohesive unit. Reuses the checkout-free `ProvisioningRepoReader` +
// `READ_BUDGET` from the sibling detector.
// ---------------------------------------------------------------------------

export interface DetectCustomManifestOptions {
  /** Service subdirectory within the repo (monorepo); absent/'' ⇒ the repo root. */
  directory?: string
  /** Git ref to read at; absent ⇒ the reader's default branch. */
  gitRef?: string
  /** The custom-manifest-type id the service pins (echoed back on the recommendation). */
  manifestId?: string
  /** The selected custom type's default manifest path (complete path, or a bare filename). */
  defaultPath?: string
  /** The service's CURRENT `manifestPath`, if any — kept as-is when it already resolves. */
  currentPath?: string
  /**
   * The selected type's `detect()` hook, when it has one. Run BEFORE the `defaultPath`-only
   * search: a matched hook result wins (its manifest path + config seed); a non-match falls
   * through to the path-only resolution, so a type with a hook is a strict superset.
   */
  detect?: (ctx: CustomManifestDetectionContext) => Promise<CustomManifestDetection | null>
}

/** A registered custom type reduced to what {@link detectCustomProviderAcrossTypes} needs. */
export interface CustomTypeForDetection {
  manifestId: string
  label: string
  defaultManifestPath?: string
  detect?: (ctx: CustomManifestDetectionContext) => Promise<CustomManifestDetection | null>
}

/**
 * Reduce the registered custom manifest types to the {@link CustomTypeForDetection} shape the
 * arbitration sweep needs (binding each `detect()` hook to its type so `this` inside a
 * method-style hook stays correct). Workspace-defined rows are never included — they carry no
 * `detect()` hook, so they can't be arbitrated.
 */
export function detectableCustomTypes(
  registered: RegisteredCustomManifestType[],
): CustomTypeForDetection[] {
  return registered.map((t) => ({
    manifestId: t.manifestId,
    label: t.label,
    ...(t.defaultManifestPath ? { defaultManifestPath: t.defaultManifestPath } : {}),
    ...(t.detect ? { detect: t.detect.bind(t) } : {}),
  }))
}

/**
 * Detect for a SELECTED custom type: run its `detect()` hook (multi-file signature + config seed),
 * falling back to the `defaultPath` path-only search. Always returns a recommendation (the caller
 * pinned this type, so we surface its result even when nothing is found).
 */
export async function detectSelectedCustomType(
  reader: ProvisioningRepoReader,
  registered: RegisteredCustomManifestType[],
  input: {
    manifestId: string
    gitRef?: string
    directory?: string
    currentManifestPath?: string
    defaultPath?: string
  },
): Promise<ProvisioningRecommendation> {
  const type = registered.find((t) => t.manifestId === input.manifestId)
  return detectCustomManifest(reader, {
    manifestId: input.manifestId,
    ...(input.gitRef ? { gitRef: input.gitRef } : {}),
    ...(input.directory ? { directory: input.directory } : {}),
    ...(input.defaultPath ? { defaultPath: input.defaultPath } : {}),
    ...(input.currentManifestPath ? { currentPath: input.currentManifestPath } : {}),
    ...(type?.detect ? { detect: type.detect.bind(type) } : {}),
  })
}

/** Arbitrate across every registered custom type's `detect()` hook (best match wins, else null). */
export async function arbitrateCustomProviders(
  reader: ProvisioningRepoReader,
  registered: RegisteredCustomManifestType[],
  input: { gitRef?: string; directory?: string; currentManifestPath?: string } = {},
): Promise<ProvisioningRecommendation | null> {
  return detectCustomProviderAcrossTypes(reader, detectableCustomTypes(registered), {
    ...(input.gitRef ? { gitRef: input.gitRef } : {}),
    ...(input.directory ? { directory: input.directory } : {}),
    ...(input.currentManifestPath ? { currentPath: input.currentManifestPath } : {}),
  })
}

/**
 * Resolve the `custom`-tab detection: with a SELECTED `manifestId` ⇒ that type's `detect()` hook
 * (or the `defaultPath` path-only search) — always a recommendation; WITHOUT one ⇒ arbitrate
 * across every registered type and return the best match, or `null` when none recognizes the repo
 * (the caller then falls through to the kubernetes/compose sweep).
 */
export async function resolveCustomProvisioning(
  reader: ProvisioningRepoReader,
  registered: RegisteredCustomManifestType[],
  input: {
    manifestId?: string
    gitRef?: string
    directory?: string
    currentManifestPath?: string
    defaultPath?: string
  },
): Promise<ProvisioningRecommendation | null> {
  if (input.manifestId) {
    return detectSelectedCustomType(reader, registered, { ...input, manifestId: input.manifestId })
  }
  return arbitrateCustomProviders(reader, registered, input)
}

/** Build the {@link CustomManifestDetectionContext} and run a type's `detect()` hook. */
async function runCustomDetect(
  detect: (ctx: CustomManifestDetectionContext) => Promise<CustomManifestDetection | null>,
  scanner: BudgetedRepoScanner,
  ctx: { directory?: string; gitRef?: string; currentPath?: string; defaultManifestPath?: string },
): Promise<CustomManifestDetection | null> {
  return detect({
    scanner,
    ...(ctx.directory ? { directory: ctx.directory } : {}),
    ...(ctx.gitRef ? { gitRef: ctx.gitRef } : {}),
    ...(ctx.currentPath ? { currentPath: ctx.currentPath } : {}),
    ...(ctx.defaultManifestPath ? { defaultManifestPath: ctx.defaultManifestPath } : {}),
  })
}

/** Map a matched {@link CustomManifestDetection} onto the wire {@link ProvisioningRecommendation}. */
function customDetectionToRecommendation(
  manifestId: string | undefined,
  detection: CustomManifestDetection,
  extra?: { detectedManifestTypeCandidates?: DetectedManifestTypeCandidate[] },
): ProvisioningRecommendation {
  const notes: ProvisioningDetectionNote[] =
    detection.notes && detection.notes.length > 0
      ? detection.notes
      : [
          {
            field: 'manifestPath',
            confidence: detection.confidence,
            message: detection.manifestPath
              ? `Detected a custom manifest at ${detection.manifestPath}.`
              : 'Detected a custom provider signature.',
          },
        ]
  const configSeed: ProvisioningCustomConfigSeed[] | undefined = detection.configSeed
  return {
    detected: detection.matched,
    provisioning: {
      type: 'custom',
      ...(manifestId ? { manifestId } : {}),
      ...(detection.manifestPath ? { manifestPath: detection.manifestPath } : {}),
    },
    ...(configSeed && configSeed.length > 0 ? { customConfigSeed: configSeed } : {}),
    ...(detection.secondaryPaths && detection.secondaryPaths.length > 0
      ? { secondaryManifestPaths: detection.secondaryPaths }
      : {}),
    ...(extra?.detectedManifestTypeCandidates
      ? { detectedManifestTypeCandidates: extra.detectedManifestTypeCandidates }
      : {}),
    notes,
  }
}

/**
 * ARBITRATION sweep: run every registered custom type's `detect()` hook over ONE shared,
 * budget-bounded scanner (memoized, so overlapping probes across providers cost one read), rank
 * the matches (high confidence before low, registration order within a tier), and return the
 * winner as a `custom` recommendation with the full candidate list. `null` ⇒ no custom provider
 * recognized the repo (the caller falls through). Types without a `detect()` hook can't be
 * arbitrated (they have no signature) and are skipped.
 */
export async function detectCustomProviderAcrossTypes(
  reader: ProvisioningRepoReader,
  types: CustomTypeForDetection[],
  options: { directory?: string; gitRef?: string; currentPath?: string } = {},
): Promise<ProvisioningRecommendation | null> {
  const detectable = types.filter(
    (t): t is CustomTypeForDetection & { detect: NonNullable<CustomTypeForDetection['detect']> } =>
      typeof t.detect === 'function',
  )
  if (detectable.length === 0) return null
  const scanner = new BudgetedRepoScanner(reader, READ_BUDGET, options.gitRef)
  const matches: { type: CustomTypeForDetection; detection: CustomManifestDetection }[] = []
  for (const type of detectable) {
    const detection = await runCustomDetect(type.detect, scanner, {
      directory: options.directory,
      gitRef: options.gitRef,
      currentPath: options.currentPath,
      defaultManifestPath: type.defaultManifestPath,
    })
    if (detection?.matched) matches.push({ type, detection })
  }
  if (matches.length === 0) {
    if (scanner.readFault) throw new RepoReadError(scanner.readFault)
    return null
  }
  const rankOf = (c: 'high' | 'low'): number => (c === 'high' ? 0 : 1)
  matches.sort((a, b) => rankOf(a.detection.confidence) - rankOf(b.detection.confidence))
  const candidates: DetectedManifestTypeCandidate[] = matches.map((m, i) => ({
    manifestId: m.type.manifestId,
    label: m.type.label,
    confidence: m.detection.confidence,
    recommended: i === 0,
  }))
  const winner = matches[0]!
  return customDetectionToRecommendation(winner.type.manifestId, winner.detection, {
    detectedManifestTypeCandidates: candidates,
  })
}

/**
 * Detect the in-repo path of a `custom` service's manifest, read CHECKOUT-FREE. Monorepo-aware:
 * the search is rooted at the service subtree (`options.directory`) or the repo root. Rules:
 *
 * 0. If the type has a `detect()` hook and it MATCHES, its result wins (multi-file signature +
 *    config seed); a non-match falls through to the path-only rules below.
 * 1. If `currentPath` already points at an existing file, KEEP it (nothing changes).
 * 2. Otherwise, resolve from `defaultPath`:
 *    - exact `<root>/<defaultPath>` (the complete relative path with filename); else
 *    - when `defaultPath` is a bare filename (no `/`), also check ONE level deep — the same file
 *      inside each immediate child directory of the root; else
 *    - fall back to the default location (`<root>/<defaultPath>`), noting it wasn't found (it
 *      will be created when the manifest is generated).
 *
 * Never throws / never persists; the SPA confirms the prefilled `manifestPath`.
 */
export async function detectCustomManifest(
  reader: ProvisioningRepoReader,
  options: DetectCustomManifestOptions = {},
): Promise<ProvisioningRecommendation> {
  const root = joinRepoPath(options.directory ?? '')
  const scanner = new BudgetedRepoScanner(reader, READ_BUDGET, options.gitRef)
  const manifestIdPart = options.manifestId ? { manifestId: options.manifestId } : {}

  // 0. The type's own `detect()` hook wins when it recognizes the repo (multi-file signature +
  //    config seed). A non-match falls through to the `defaultPath` search below, so a type WITH
  //    a hook is a strict superset of the path-only behaviour.
  if (options.detect) {
    const detection = await runCustomDetect(options.detect, scanner, {
      directory: options.directory,
      gitRef: options.gitRef,
      currentPath: options.currentPath,
      defaultManifestPath: options.defaultPath,
    })
    if (detection?.matched) {
      return customDetectionToRecommendation(options.manifestId, detection)
    }
  }

  const rec = (
    detected: boolean,
    manifestPath: string | undefined,
    note: ProvisioningDetectionNote,
  ): ProvisioningRecommendation => ({
    detected,
    provisioning: {
      type: 'custom',
      ...manifestIdPart,
      ...(manifestPath ? { manifestPath } : {}),
    },
    notes: [note],
  })

  // 1. An existing, accurate current value wins — don't churn a working path.
  const currentPath = options.currentPath?.trim()
  if (currentPath && (await scanner.getFile(currentPath)) !== null) {
    return rec(true, currentPath, {
      field: 'manifestPath',
      confidence: 'high',
      message: `The current manifest path (${currentPath}) already points to a file in the repo — kept unchanged.`,
    })
  }

  const defaultPath = options.defaultPath?.trim()
  if (!defaultPath) {
    return rec(false, currentPath || undefined, {
      field: 'manifestPath',
      confidence: 'low',
      message:
        'This custom manifest type declares no default path, so there is nothing to auto-detect. Enter the manifest path manually.',
    })
  }

  // 2a. Exact: the complete relative path (with filename) under the service subtree / repo root.
  const exact = joinRepoPath(root, defaultPath)
  if ((await scanner.getFile(exact)) !== null) {
    return rec(true, exact, {
      field: 'manifestPath',
      confidence: 'high',
      message: `Found the custom manifest at ${exact} (the default path).`,
    })
  }

  // 2b. Bare filename ⇒ also look one level deep, inside each immediate child directory.
  if (!defaultPath.includes('/')) {
    for (const entry of await scanner.listDir(root)) {
      if (entry.type !== 'dir') continue
      const nested = joinRepoPath(entry.path, defaultPath)
      if ((await scanner.getFile(nested)) !== null) {
        return rec(true, nested, {
          field: 'manifestPath',
          confidence: 'high',
          message: `Found ${defaultPath} one level deep at ${nested}.`,
        })
      }
    }
  }

  // 2c. Not found anywhere. If the lookups couldn't actually READ the repo (a genuine fault, not a
  // clean miss), surface that instead of a misleading "not found — will be created".
  if (scanner.readFault) throw new RepoReadError(scanner.readFault)
  // Keep a path the user deliberately entered (they may be pointing at a file to be generated);
  // only fall back to the default location when there's no current value — never silently
  // overwrite an explicit entry. Either way "generate" writes to the kept path.
  const target = currentPath || exact
  return rec(false, target, {
    field: 'manifestPath',
    confidence: 'low',
    message: currentPath
      ? `No custom manifest found; kept the entered path ${target}. It will be created when you generate the manifest.`
      : `No custom manifest found; pre-filled the default location ${target}. It will be created when you generate the manifest.`,
  })
}
