import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import process from 'node:process'

// Keep the executor-harness image current before the local service boots.
//
// Why this exists: LOCAL_HARNESS_IMAGE is a mutable reference. A container runtime never
// re-pulls a tag it already has locally, so a plain rerun keeps launching per-run agent
// containers from whatever image was fetched once — possibly days old. That is how a fix
// which already shipped in a newer harness image (it is versioned as its own Docker image,
// separately from the @cat-factory/* npm packages) keeps reproducing locally even though the
// orchestrator is current. This preflight refreshes the image so `pnpm dev`/`pnpm start`
// self-heal, and is best-effort: an unreachable registry falls back to the local copy rather
// than blocking startup.

const out = (msg) => process.stdout.write(`${msg}\n`)
const err = (msg) => process.stderr.write(`${msg}\n`)

const ENV_FILE = '.env'
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE)

const image = process.env.LOCAL_HARNESS_IMAGE?.trim()
if (!image) {
  // Native-only setups (LOCAL_NATIVE_AGENTS covering every step) need no image.
  out('[harness] LOCAL_HARNESS_IMAGE unset — skipping image refresh.')
  process.exit(0)
}

const binary = resolveBinary()

if (!looksRemote(image)) {
  // A bare, locally-built tag (the example default `cat-factory-executor:local`): there is
  // nothing to pull. Verify it exists and remind that it must be rebuilt when the harness
  // source changes — a stale local build is the same trap as a stale registry pull.
  if (imageExists(binary, image)) {
    out(
      `[harness] using local image ${image} — rebuild it after updating the harness ` +
        '(docker build -t ' +
        image +
        ' backend/internal/executor-harness).',
    )
    process.exit(0)
  }
  err(
    `[harness] ${image} not found locally — agent steps will fail until you build it: ` +
      `docker build -t ${image} backend/internal/executor-harness`,
  )
  process.exit(0)
}

// Registry reference: refresh it so a mutable tag can't go stale.
const before = repoDigest(binary, image)
const pull = spawnSync(binary, ['pull', image], { stdio: 'inherit' })

if (pull.status !== 0) {
  if (imageExists(binary, image)) {
    err(
      `[harness] could not refresh ${image} (runtime down / registry unreachable?) — ` +
        'using the local copy already present.',
    )
    process.exit(0)
  }
  err(
    `[harness] ${image} is not available locally and could not be pulled. ` +
      'Start your container runtime and check connectivity, or set LOCAL_HARNESS_IMAGE.',
  )
  process.exit(1)
}

const after = repoDigest(binary, image)
if (before && after && before !== after) {
  out(`[harness] updated ${image}\n  from ${before}\n  to   ${after}`)
} else {
  out(`[harness] ${image} is up to date.`)
}

if (isMutableTag(image)) {
  out(
    `[harness] note: ${image} is a mutable tag. For reproducible runs, pin an explicit ` +
      'version (or an @sha256 digest) and bump it deliberately.',
  )
}

function resolveBinary() {
  const explicit = process.env.LOCAL_DOCKER_BINARY?.trim()
  if (explicit) return explicit
  const runtime = process.env.LOCAL_CONTAINER_RUNTIME?.trim()
  if (runtime === 'podman') return 'podman'
  if (runtime === 'apple') return 'container'
  return 'docker' // docker | orbstack | colima all drive the docker CLI
}

// A reference is "remote" (worth pulling) when it carries a registry namespace — a `/`
// before any tag. A bare `name:tag` (no slash) is a local-only build we never pull.
function looksRemote(ref) {
  const path = ref.split('@')[0]
  const beforeTag =
    path.includes(':') && path.lastIndexOf(':') > path.lastIndexOf('/')
      ? path.slice(0, path.lastIndexOf(':'))
      : path
  return beforeTag.includes('/')
}

function imageExists(bin, ref) {
  return spawnSync(bin, ['image', 'inspect', '--format', '{{.Id}}', ref]).status === 0
}

function repoDigest(bin, ref) {
  const res = spawnSync(bin, ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', ref], {
    encoding: 'utf8',
  })
  if (res.status !== 0) return undefined
  return res.stdout.trim() || undefined
}

function isMutableTag(ref) {
  if (ref.includes('@sha256:')) return false
  const hasTag = ref.lastIndexOf(':') > ref.lastIndexOf('/')
  if (!hasTag) return true // implicit :latest
  const tag = ref.slice(ref.lastIndexOf(':') + 1)
  return tag === 'latest' || tag === 'main' || tag === 'edge'
}
