import type { CustomManifestTypeRegistry } from '@cat-factory/integrations'
import type { CustomManifestDetection, CustomManifestDetectionContext } from '@cat-factory/kernel'
import { joinRepoPath, matchManifestSignature, readYamlDoc } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// A WORKED EXAMPLE of a CUSTOM test-infrastructure provider's AUTODETECTION hook.
//
// This is the companion to the custom-agent example: a company runs its ephemeral environments
// on its own convention, and teaches the platform to RECOGNIZE such a repo from its shape — a
// genuine MULTI-FILE signature (a root `deploy/stack.yml` manifest PLUS a `deploy/up.sh` bring-up
// script PLUS a `deploy/compose.yml` stack) — locate its manifest, and extract a config seed (the
// health port/path + deploy command from the manifest) for the confirm form to prefill.
//
// It is authored with `@cat-factory/kernel` + `@cat-factory/integrations` ONLY (the registry
// type) — no engine, no harness change — using the shared checkout-free probe primitives
// (`matchManifestSignature` / `readYamlDoc` / `joinRepoPath`) against the budget-bounded scanner
// the platform hands the hook. A deployment registers it BY REFERENCE on the app-owned
// `CustomManifestTypeRegistry`
// (`registerExampleStackDeployProvider(registries.customManifestTypeRegistry)`), after which
// `detectServiceProvisioning` arbitrates it against every other registered provider.
//
// See `backend/docs/per-service-provisioning.md` (the "custom-provider autodetection" section)
// for the full model.
// ---------------------------------------------------------------------------

/** The custom-manifest-type id a stack-deploy-provisioned service pins. */
export const STACK_DEPLOY_MANIFEST_ID = 'stack-deploy'

/** The three files whose co-existence identifies a stack-deploy repo. */
const STACK_MANIFEST = 'deploy/stack.yml'
const STACK_UP_SCRIPT = 'deploy/up.sh'
const STACK_COMPOSE = 'deploy/compose.yml'

/** The (very small) slice of the `deploy/stack.yml` manifest this example reads for the seed. */
interface StackManifest {
  deploy?: {
    command?: string
    health?: { port?: number | string; path?: string }
  }
}

/**
 * Recognize a stack-deploy ephemeral-environment repo from its multi-file signature and, when
 * matched, seed the health port/path + deploy command parsed from the root manifest. Returns
 * `null` when the repo is not stack-deploy-shaped (the arbitration sweep then skips this
 * provider). A manifest that doesn't parse as YAML (a templated file, say) degrades to `null`
 * via `readYamlDoc`, so the config seed is best-effort while the SIGNATURE match still stands.
 */
export async function detectStackDeployProvider(
  ctx: CustomManifestDetectionContext,
): Promise<CustomManifestDetection | null> {
  const root = ctx.directory
  const signature = await matchManifestSignature(
    ctx.scanner,
    {
      required: [STACK_MANIFEST, STACK_UP_SCRIPT, STACK_COMPOSE],
      // Corroborating (not required): a repo that also ships an ingress config is even more
      // clearly stack-deploy-shaped. Absent ones simply don't raise confidence.
      optional: ['deploy/ingress.conf'],
    },
    root ? { root } : {},
  )
  if (!signature.matched) return null

  const manifestPath = joinRepoPath(root, STACK_MANIFEST)
  const configSeed: { key: string; value: string }[] = []
  const manifest = await readYamlDoc<StackManifest>(ctx.scanner, manifestPath)
  const health = manifest?.deploy?.health
  if (health?.port !== undefined) configSeed.push({ key: 'healthPort', value: String(health.port) })
  if (health?.path) configSeed.push({ key: 'healthPath', value: health.path })
  const command = manifest?.deploy?.command
  if (command) configSeed.push({ key: 'deployCommand', value: command })

  return {
    matched: true,
    confidence: signature.confidence,
    manifestPath,
    secondaryPaths: [joinRepoPath(root, STACK_UP_SCRIPT), joinRepoPath(root, STACK_COMPOSE)],
    ...(configSeed.length > 0 ? { configSeed } : {}),
    notes: [
      {
        field: 'provisionType',
        confidence: signature.confidence,
        message: `Detected a stack-deploy ephemeral-environment provider (${signature.matchedPaths.length} signature file(s): ${signature.matchedPaths.join(', ')}).`,
      },
    ],
  }
}

/**
 * Register the example stack-deploy custom manifest type — including its
 * {@link detectStackDeployProvider} autodetection hook — by reference on the app-owned registry.
 * Idempotent (the registry replaces by `manifestId`).
 */
export function registerExampleStackDeployProvider(registry: CustomManifestTypeRegistry): void {
  registry.register({
    manifestId: STACK_DEPLOY_MANIFEST_ID,
    label: 'Stack-deploy ephemeral environment',
    description: 'A stack-deploy per-PR environment (deploy/stack.yml + deploy/ compose stack).',
    defaultManifestPath: STACK_MANIFEST,
    detect: detectStackDeployProvider,
  })
}
