import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// The one-container image the platform runs to find out whether this machine's Docker daemon
// can actually run a container, built here in memory rather than pulled.
//
// It exists because `docker info` answers a different question from the one every caller
// actually asks. A daemon that ANSWERS is not a daemon that WORKS: this container's rootless
// daemon runs inside whatever sandbox the deployment gave it, and a nested user namespace
// routinely refuses the overlay mount every image materialisation needs. The daemon serves
// happily, `docker version` reports a server, and `docker pull` of a multi-layer image,
// `docker run` of a single-layer one and `docker build` all fail with the same EINVAL. Issue
// #2120 is three agents in one run each discovering that for themselves, against a system
// prompt that told them, as stated fact, that Docker worked here.
//
// Why the payload is BUILT and not pulled: a probe that needs the network answers a question
// about the registry as much as about the daemon, cannot run in a sandbox with no egress, and
// costs the job its first turn. This one is a single layer holding one statically linked
// binary already in the image, assembled into a docker-archive tar and handed to `docker load`
// on stdin, so the whole check is local and takes about as long as starting one container.
//
// ONE layer, deliberately. The reported failure kills `docker run` of a single-layer image too
// (the container's own writable layer is already a second overlay lower dir), so one layer is
// enough to detect it, and it keeps `docker load` (the step this file could plausibly get WRONG)
// as small as it can be. That matters because the caller reads a load failure as "could
// not determine" and a RUN failure as "this daemon cannot run containers": a bug in the archive
// below must never be able to tell an agent that a working daemon is broken.
// ---------------------------------------------------------------------------

/** The tag the probe image is loaded under. Removed again once the check has answered. */
export const PROBE_IMAGE_TAG = 'cat-factory-docker-probe:1'

/** Where the payload binary lands inside the probe image, and what the container is asked to run. */
const PROBE_BINARY_PATH = 'busybox'

/**
 * What the container must print for the check to pass.
 *
 * A marker on stdout rather than a zero exit status: the point of the check is that a process
 * inside the container actually ran, and only output it produced proves that. An exit status is
 * the daemon's word for it.
 */
export const PROBE_SENTINEL = 'cat-factory-docker-probe-ok'

/** The argv the probe container runs. `busybox` dispatches on its own name, so this is an echo. */
export const PROBE_COMMAND: readonly string[] = [`/${PROBE_BINARY_PATH}`, 'echo', PROBE_SENTINEL]

/**
 * Node's architecture names mapped onto the ones an image config may declare.
 *
 * Total by REFUSAL rather than by fallback: an image whose `architecture` does not match the
 * daemon's is refused at run time, so guessing here would report a perfectly good daemon as one
 * that cannot run containers, the exact lie this whole mechanism exists to remove. An unmapped
 * architecture yields no archive, and the caller then says it could not determine anything.
 */
const DOCKER_ARCHITECTURES: Readonly<Record<string, string>> = {
  x64: 'amd64',
  arm64: 'arm64',
  arm: 'arm',
  s390x: 's390x',
  ppc64: 'ppc64le',
  riscv64: 'riscv64',
}

/** The image config's `architecture` for this process, or `undefined` when nothing maps. */
export function dockerArchitecture(arch: string = process.arch): string | undefined {
  return DOCKER_ARCHITECTURES[arch]
}

const TAR_BLOCK = 512

/** A fixed timestamp everywhere a tar or an image config wants one, so the archive is byte-stable. */
const EPOCH = '1970-01-01T00:00:00Z'

interface TarEntry {
  name: string
  content: Buffer
  mode: number
}

/**
 * One ustar header block.
 *
 * The checksum is summed with its own field read as eight SPACES and only then written back
 * over it, which is the format's own rule and the one detail a hand-rolled writer gets wrong. A
 * header whose checksum covers its own checksum bytes is rejected by every reader, and
 * `docker load` reports that as an unreadable archive, which this module's caller would then
 * have to decide was not the daemon's fault.
 */
function tarHeader(name: string, size: number, mode: number): Buffer {
  const header = Buffer.alloc(TAR_BLOCK)
  header.write(name, 0, 100, 'utf8')
  header.write(octalField(mode, 8), 100, 8, 'latin1')
  header.write(octalField(0, 8), 108, 8, 'latin1') // uid
  header.write(octalField(0, 8), 116, 8, 'latin1') // gid
  header.write(octalField(size, 12), 124, 12, 'latin1')
  header.write(octalField(0, 12), 136, 12, 'latin1') // mtime
  header.write('        ', 148, 8, 'latin1')
  header.write('0', 156, 1, 'latin1') // typeflag: a regular file
  header.write('ustar\0', 257, 6, 'latin1')
  header.write('00', 263, 2, 'latin1')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1')
  return header
}

/** A numeric tar field: zero-padded octal in `width - 1` characters, then a NUL. */
function octalField(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`
}

/** One tar member: its header, its content, and the padding up to the next 512-byte block. */
function tarMember(entry: TarEntry): Buffer {
  const padding = (TAR_BLOCK - (entry.content.length % TAR_BLOCK)) % TAR_BLOCK
  return Buffer.concat([
    tarHeader(entry.name, entry.content.length, entry.mode),
    entry.content,
    Buffer.alloc(padding),
  ])
}

/** A whole tar stream: the members, then the two zero blocks that terminate one. */
export function tarArchive(entries: readonly TarEntry[]): Buffer {
  return Buffer.concat([...entries.map(tarMember), Buffer.alloc(TAR_BLOCK * 2)])
}

/**
 * Assemble the docker-archive `docker load` reads, from one statically linked binary.
 *
 * Classic (v1) docker-archive rather than OCI layout: `docker load` accepts both on every engine
 * this image can run against, and the v1 shape is three files with no blob directory to get
 * wrong. The layer digest is the sha256 of the UNCOMPRESSED layer tar, which is what
 * `rootfs.diff_ids` means; an engine that disagrees with it refuses the load, which the caller
 * reads as could-not-determine rather than as a broken daemon.
 *
 * Returns `undefined` for an architecture nothing maps (see {@link DOCKER_ARCHITECTURES}).
 */
export function buildProbeArchive(
  payload: Buffer,
  arch: string = process.arch,
): Buffer | undefined {
  const architecture = dockerArchitecture(arch)
  if (!architecture) return undefined
  const layer = tarArchive([{ name: PROBE_BINARY_PATH, content: payload, mode: 0o755 }])
  const diffId = `sha256:${createHash('sha256').update(layer).digest('hex')}`
  const config = Buffer.from(
    JSON.stringify({
      architecture,
      os: 'linux',
      created: EPOCH,
      config: {},
      rootfs: { type: 'layers', diff_ids: [diffId] },
      history: [{ created: EPOCH, created_by: 'cat-factory docker capability probe' }],
    }),
  )
  const manifest = Buffer.from(
    JSON.stringify([{ Config: 'config.json', RepoTags: [PROBE_IMAGE_TAG], Layers: ['layer.tar'] }]),
  )
  return tarArchive([
    { name: 'config.json', content: config, mode: 0o644 },
    { name: 'layer.tar', content: layer, mode: 0o644 },
    { name: 'manifest.json', content: manifest, mode: 0o644 },
  ])
}
