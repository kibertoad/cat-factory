// Executor-harness image resolution + boot-time freshness for local mode.
//
// A per-run agent container is built from the harness image, which is versioned as its OWN
// Docker image (published by CI as `ghcr.io/<owner>/cat-factory-executor:<harness-version>`
// and `:latest`), separately from the @cat-factory/* npm packages. Two failure modes follow:
//   - STALE: a container runtime never re-pulls a tag it already has, so a plain rerun keeps
//     launching agents from a days-old image — reproducing a bug that already shipped fixed.
//   - TOO NEW: chasing `:latest` can pull an image newer than the installed backend supports
//     (this project has no cross-version compatibility guarantee).
//
// Both are avoided by pinning: `RECOMMENDED_HARNESS_IMAGE` is the exact image this build of
// `@cat-factory/local-server` was released against. `LOCAL_HARNESS_IMAGE` is OPTIONAL and
// defaults to it, so a fresh install runs the matched image out of the box; `startLocal()`
// pulls that pinned tag at boot (see server.ts `preflightHarnessImage`) so it can't go stale.
//
// RELEASE RULE: bump `RECOMMENDED_HARNESS_IMAGE` in lockstep with the harness image — see
// CLAUDE.md "Any change that affects the runner image MUST bump the image tag". The image and
// the backend are a matched set and must be released together.

import { isImageVariantName, isPlatformImageVariant } from '@cat-factory/kernel'
import { isOffValue } from './envFlags.js'

/**
 * The harness image this backend release is matched to. Keep the tag in sync with
 * `@cat-factory/executor-harness`'s version (the value CI tags the published image with, and
 * the same tag `deploy/backend` pins). Bump it whenever the harness image bumps.
 */
export const RECOMMENDED_HARNESS_IMAGE = 'ghcr.io/kibertoad/cat-factory-executor:1.144.0'

/**
 * The UI-TESTER image this backend release is matched to: the same harness plus Playwright +
 * Chromium, pnpm/yarn, `serve` and a headless JRE + WireMock. It carries the executor harness's
 * version, because it IS that harness with more tooling, so the two tags bump together.
 *
 * A step declaring `image: 'ui'` (the browser-driven `tester-ui` kind) dispatches to its own
 * container on this image, alongside the run's ordinary one.
 */
export const RECOMMENDED_UI_HARNESS_IMAGE = 'ghcr.io/kibertoad/cat-factory-executor-ui:1.144.0'

/**
 * The effective harness image ref: an explicit `LOCAL_HARNESS_IMAGE` wins (a custom build, a
 * different pin, or a mutable tag), else the backend-matched {@link RECOMMENDED_HARNESS_IMAGE}.
 */
export function resolveHarnessImage(env: NodeJS.ProcessEnv): string {
  return env.LOCAL_HARNESS_IMAGE?.trim() || RECOMMENDED_HARNESS_IMAGE
}

/**
 * The effective UI-tester image ref, the `image: 'ui'` sibling of {@link resolveHarnessImage}:
 * an explicit `LOCAL_HARNESS_IMAGE_UI` wins, else {@link RECOMMENDED_UI_HARNESS_IMAGE}.
 *
 * It has its OWN override rather than deriving a `-ui` suffix from `LOCAL_HARNESS_IMAGE`,
 * because a developer pointing the base at a locally built tag has not thereby built a UI image
 * too, and a derived ref would send them to a tag that does not exist with nothing saying why.
 */
export function resolveUiHarnessImage(env: NodeJS.ProcessEnv): string {
  return env.LOCAL_HARNESS_IMAGE_UI?.trim() || RECOMMENDED_UI_HARNESS_IMAGE
}

/**
 * The DEPLOYMENT's own image variants, parsed from `LOCAL_HARNESS_IMAGE_VARIANTS`:
 * `name=image-ref` pairs, comma-separated (`pixel-tools=ghcr.io/acme/pixel:1,fonts=…`).
 *
 * A comma-separated list rather than one variable per variant, because the set is open: the
 * platform cannot enumerate a deployment's own names, so it cannot pre-declare their variables
 * either, and a `LOCAL_HARNESS_IMAGE_<NAME>` convention would put a slug through an
 * env-var-name transformation that has to round-trip exactly (a `pixel-tools` variant and a
 * `pixel_tools` one collide the moment it does not).
 *
 * A malformed entry is DROPPED rather than defaulted: an entry with no `=`, an empty name, an
 * empty ref or a name that is not a variant SLUG says nothing about which image was meant, and
 * inventing one would put the job on an image nobody chose. The platform's own `ui` / `default`
 * names are ignored here too, since they have their own variables and a second place to set them
 * would be a second answer.
 *
 * The name is held to `isImageVariantName`, the SAME rule the two DECLARING boundaries enforce (an
 * agent kind's registration at boot, a Kubernetes pool's `imageVariants` schema). Left unchecked,
 * `Pixel-Tools=…` or `pixel_tools=…` parsed into the map, matched no declaration a kind could have
 * made, and the dispatch was then refused pointing at the variable the operator had already set.
 * Case is NOT folded onto a lower-kebab name for the same reason: a declaration is refused in that
 * spelling, so accepting it here would make this variable the one place a name the platform rejects
 * appears to work.
 *
 * Rejections are RETURNED rather than swallowed, so boot can say which entries it ignored. Left to
 * the dispatch, the only signal is a refusal naming this variable for a variant the operator can
 * see in it, which reads as the platform losing an entry rather than refusing one.
 */
export function resolveHarnessImageVariants(env: NodeJS.ProcessEnv): {
  variants: Record<string, string>
  rejected: Array<{ entry: string; reason: string }>
} {
  const raw = env.LOCAL_HARNESS_IMAGE_VARIANTS?.trim()
  if (!raw) return { variants: {}, rejected: [] }
  const variants: Record<string, string> = {}
  const rejected: Array<{ entry: string; reason: string }> = []
  const reject = (entry: string, reason: string): void => {
    rejected.push({ entry: entry.trim(), reason })
  }
  for (const entry of raw.split(',')) {
    if (!entry.trim()) continue
    const separator = entry.indexOf('=')
    if (separator <= 0) {
      reject(entry, 'it is not a `name=image-ref` pair')
      continue
    }
    const name = entry.slice(0, separator).trim()
    const image = entry.slice(separator + 1).trim()
    if (!name) {
      reject(entry, 'it names no variant')
      continue
    }
    if (!image) {
      reject(entry, `it maps "${name}" to no image ref`)
      continue
    }
    // Not a rejection: the platform's own variants have their own variables, and an operator
    // setting one here has said the same thing twice rather than said something wrong.
    if (isPlatformImageVariant(name)) continue
    if (!isImageVariantName(name)) {
      reject(
        entry,
        `"${name}" is not a variant name: an agent kind can only declare a lower-kebab slug ` +
          `(letters, digits and hyphens), so no registration could ask for this one`,
      )
      continue
    }
    variants[name] = image
  }
  return { variants, rejected }
}

/**
 * Resolve the boot-refresh mode from `LOCAL_HARNESS_IMAGE_REFRESH`. Any off-style value
 * (`false`/`0`/`off`/`no`/`none`/`disabled`, matching the repo's other flags via
 * {@link isOffValue}) disables the pull; unset or anything else refreshes.
 */
export function resolveRefreshMode(env: NodeJS.ProcessEnv): 'pull' | 'off' {
  return isOffValue(env.LOCAL_HARNESS_IMAGE_REFRESH) ? 'off' : 'pull'
}

/** One container-CLI invocation, normalised to an exit status + captured stdout. */
export type ImageExec = (args: string[]) => Promise<{ status: number; stdout: string }>

interface HarnessImageLog {
  info: (message: string) => void
  warn: (message: string) => void
}

export interface RefreshHarnessImageOptions {
  /** The effective image ref to refresh (from {@link resolveHarnessImage}). */
  image: string
  /** The backend-matched pin, to advise against when the effective image differs. */
  recommended: string
  /** The runtime CLI binary (docker / podman / container). */
  binary: string
  /** The resolved runtime id — auto-refresh is skipped on `apple` (its CLI verbs differ). */
  runtimeId: string
  /** `off` disables the refresh entirely; anything else pulls a registry ref. */
  mode: 'pull' | 'off'
  exec: ImageExec
  log: HarnessImageLog
}

/**
 * Refresh (or presence-check) the harness image at boot. Never throws — every failure degrades
 * to a log line so the service still boots.
 */
export async function refreshHarnessImage(opts: RefreshHarnessImageOptions): Promise<void> {
  const { image, recommended, runtimeId, mode, exec, log } = opts

  // A custom image (not the backend-matched pin) is allowed, but flag the compatibility risk —
  // this is how a "too new" (or too old) override surfaces, since versions aren't guaranteed
  // compatible across the image/backend boundary.
  if (image !== recommended) {
    log.warn(
      `local mode: using a custom harness image ${image} instead of the version matched to this ` +
        `build (${recommended}) — ensure they are compatible, or unset LOCAL_HARNESS_IMAGE to use the pin.`,
    )
  }

  if (mode === 'off') {
    log.info(
      `local mode: harness image auto-refresh disabled (LOCAL_HARNESS_IMAGE_REFRESH=off) — ${image}`,
    )
    return
  }

  // Apple `container` exposes run/list/inspect/delete only (no verified `pull` / `image
  // inspect`), so we don't issue Docker-shaped image commands at it — refresh it out of band.
  if (runtimeId === 'apple') {
    log.info(
      `local mode: harness image auto-refresh is not supported on the 'apple' runtime — ` +
        `ensure ${image} is current out of band.`,
    )
    return
  }

  if (!looksRemoteImageRef(image)) {
    // A bare, locally-built tag (e.g. `cat-factory-executor:local`): nothing to pull. Verify
    // presence and remind that it must be rebuilt when the harness changes.
    if (await imageExists(exec, image)) {
      log.info(
        `local mode: using local harness image ${image} — rebuild it after updating the harness ` +
          `(docker build -t ${image} backend/internal/executor-harness).`,
      )
    } else {
      log.warn(
        `local mode: harness image ${image} not found locally — repo-operating agent steps will ` +
          `fail until you build it: docker build -t ${image} backend/internal/executor-harness`,
      )
    }
    return
  }

  // Registry ref: pull it so a stale local copy is refreshed to the pinned digest.
  const before = await repoDigest(exec, image)
  log.info(`local mode: refreshing harness image ${image}…`)
  const pull = await exec(['pull', image])

  if (pull.status !== 0) {
    if (await imageExists(exec, image)) {
      log.warn(
        `local mode: could not refresh ${image} (runtime down / registry unreachable?) — ` +
          `using the local copy already present.`,
      )
    } else {
      log.warn(
        `local mode: harness image ${image} is unavailable locally and could not be pulled — ` +
          `repo-operating agent steps will fail. Check connectivity, or set LOCAL_HARNESS_IMAGE.`,
      )
    }
    return
  }

  const after = await repoDigest(exec, image)
  if (before && after && before !== after) {
    log.info(`local mode: updated harness image ${image} (${before} -> ${after}).`)
  } else if (!before && after) {
    // The image wasn't present before the pull, so this was a first-time download, not a no-op.
    log.info(`local mode: pulled harness image ${image} (${after}).`)
  } else {
    log.info(`local mode: harness image ${image} is up to date.`)
  }

  if (isMutableImageTag(image)) {
    log.info(
      `local mode: ${image} is a mutable tag — pin an explicit version (or an @sha256 digest, ` +
        `e.g. ${recommended}) for reproducible runs.`,
    )
  }
}

/**
 * Whether a ref carries a registry namespace (a `/` before any tag) and is therefore worth
 * pulling. A bare `name:tag` (no slash) is a local-only build we never try to pull.
 */
export function looksRemoteImageRef(ref: string): boolean {
  const path = ref.split('@')[0] ?? ref
  const hasTag = path.includes(':') && path.lastIndexOf(':') > path.lastIndexOf('/')
  const repo = hasTag ? path.slice(0, path.lastIndexOf(':')) : path
  return repo.includes('/')
}

/** Whether a ref points at a mutable tag (so a pinned digest/version is worth suggesting). */
export function isMutableImageTag(ref: string): boolean {
  if (ref.includes('@sha256:')) return false
  const hasTag = ref.lastIndexOf(':') > ref.lastIndexOf('/')
  if (!hasTag) return true // implicit :latest
  const tag = ref.slice(ref.lastIndexOf(':') + 1)
  return tag === 'latest' || tag === 'main' || tag === 'edge'
}

async function imageExists(exec: ImageExec, image: string): Promise<boolean> {
  return (await exec(['image', 'inspect', '--format', '{{.Id}}', image])).status === 0
}

async function repoDigest(exec: ImageExec, image: string): Promise<string | undefined> {
  const res = await exec(['image', 'inspect', '--format', '{{index .RepoDigests 0}}', image])
  if (res.status !== 0) return undefined
  const digest = res.stdout.trim()
  return digest && digest !== '<no value>' ? digest : undefined
}
