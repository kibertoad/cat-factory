import { createHash } from 'node:crypto'
import { scrubbedExcerpt } from './redact.js'

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

// ---------------------------------------------------------------------------
// The second thing the same image is asked, and the one the marker run above structurally cannot
// answer: whether a container started on this daemon can reach the NETWORK.
//
// Loading and running a local image needs no network at all, so a daemon whose nested containers
// are cut off passes the marker run exactly as a working one does. That is not hypothetical: the
// published executor image ran its rootless daemon with `--iptables=false`, which drops the
// MASQUERADE rule for the bridge, and every nested container on it had no egress whatsoever
// (issue #2173). The harness reported `dockerDaemon: "usable"` throughout, and each agent
// discovered otherwise about seven minutes into an `npm ci` inside a `docker build` (issue
// #2174). An agent TOLD it has no egress can plan around it; an agent told docker works cannot.
//
// It runs as its own container rather than as one more command in the marker run, because the
// marker run is deliberately `--network none`. The two need opposite networking, so they cannot
// be the same `docker run`, and keeping them apart has a second payoff: a failure of anything
// below can only ever produce an EGRESS verdict, never a verdict about the daemon.
// ---------------------------------------------------------------------------

/**
 * What the egress container prints for each observation: the marker, then the exit STATUS of the
 * command that made it.
 *
 * The status rather than a pass/fail marker, because the two failures need different answers.
 * A refused connection is evidence about the network; a 127 is busybox saying it has no such
 * applet, which is evidence about the platform's own probe image and may never be reported as a
 * network that is not there.
 */
export const EGRESS_TCP_MARKER = 'cat-factory-egress-tcp='
export const EGRESS_DNS_MARKER = 'cat-factory-egress-dns='

/** How long the in-container connect may take. Short: a blocked route is silent, not slow. */
const EGRESS_CONNECT_TIMEOUT_SECONDS = 3

/**
 * How long busybox is given to print its own `nc` usage, for the capability check below. Bounded
 * like everything else in that container: an applet that somehow blocks may not take the budget
 * of the measurement it is only a preamble to.
 */
const EGRESS_USAGE_TIMEOUT_SECONDS = 2

/**
 * How long the in-container lookup may take. Its own ceiling because busybox's `nslookup` retries
 * on its own schedule, and an unbounded one would spend the whole check's budget on the half that
 * is the diagnostic rather than the verdict.
 */
const EGRESS_LOOKUP_TIMEOUT_SECONDS = 6

/** Where the egress check aims: a raw address, plus a name to resolve. */
export interface EgressTarget {
  host: string
  port: number
  dnsName: string
}

/**
 * How much of a rejected setting is quoted back. Enough to recognise which value was refused,
 * short of letting a pasted blob be most of an agent's system prompt.
 */
const SETTING_CHARS = 60

/** An IPv4 literal. Names are refused on purpose: a target that needs DNS cannot TEST DNS. */
const IPV4 =
  /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/

/** A hostname, in the narrow shape a DNS lookup can be aimed at. */
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i

/**
 * Read the configured target, or say why it cannot be used.
 *
 * Validated rather than trusted, and strictly, for two reasons that both matter. The host and the
 * name are interpolated into a `sh -c` script INSIDE the probe container, so anything else there
 * would be running whatever a deployment's environment happened to hold; and a target that is
 * quietly wrong produces a confident `blocked` about a daemon that is fine, which is the exact
 * class of lie this whole module exists to remove. A rejected setting is REPORTED as a check that
 * could not be carried out, never silently swapped for the default: an operator who pointed this
 * at an address their network permits is entitled to find out that it was ignored.
 */
export function parseEgressTarget(
  target: string,
  dnsName: string,
): { target: EgressTarget } | { invalid: string } {
  const [host = '', port = '', ...rest] = target.split(':')
  if (rest.length > 0 || !IPV4.test(host)) {
    return {
      invalid: `the platform's egress check is configured with \`${scrubbedExcerpt(target, SETTING_CHARS)}\`, which is not an \`IPv4:port\` address`,
    }
  }
  const parsed = Number(port)
  if (!/^[0-9]{1,5}$/.test(port) || parsed < 1 || parsed > 65535) {
    return {
      invalid: `the platform's egress check is configured with \`${scrubbedExcerpt(target, SETTING_CHARS)}\`, whose port is not a number between 1 and 65535`,
    }
  }
  if (!HOSTNAME.test(dnsName)) {
    return {
      invalid: `the platform's egress check is configured to resolve \`${scrubbedExcerpt(dnsName, SETTING_CHARS)}\`, which is not a hostname`,
    }
  }
  return { target: { host, port: parsed, dnsName } }
}

/**
 * The argv the egress container runs: connect, say what that returned, resolve, say the same.
 *
 * Both observations are made and BOTH are reported, because they fail for different reasons and
 * have different fixes. A connect to a raw address needs only a route; a lookup needs the
 * daemon's embedded resolver to be reachable and to forward. Reporting only the first would call
 * a container with a working route and broken DNS "reachable", and nothing an agent fetches by
 * name would work there.
 *
 * Every applet is called by its full path (`/busybox nc`) rather than by name. The image holds
 * one file and no PATH, and busybox's standalone-shell dispatch is a build-time option nothing
 * here may assume.
 *
 * The connect is the half that is easy to get silently wrong, and `nc -w SEC` alone gets it
 * wrong. busybox documents that flag as the timeout for connects AND FINAL NET READS: once stdin
 * hits EOF `nc` half-closes and then waits to be spoken to, so a connect that SUCCEEDED to a peer
 * which expects the client to speak first (every TLS port, the default `1.1.1.1:443` included)
 * hits the alarm and exits non-zero. Read off the exit status alone that is indistinguishable
 * from a refusal, so a working network reports a route that is not there. `-z` means "connect,
 * then stop", which is the question being asked, so it is used wherever the payload's busybox was
 * built with it; where it was not, the connect runs with no `-w`, which is the build whose `nc`
 * exits on its own when stdin closes.
 *
 * Both halves are wrapped in `${busybox} timeout` either way, since a blackholed route is silent
 * rather than refused and the applet's own ceiling is the thing this comment exists because we
 * cannot assume.
 */
export function buildEgressCommand(target: EgressTarget): readonly string[] {
  const busybox = `/${PROBE_BINARY_PATH}`
  const bounded = (seconds: number, command: string): string =>
    `${busybox} timeout ${seconds} ${command}`
  const where = `${target.host} ${target.port}`
  const connectSeconds = EGRESS_CONNECT_TIMEOUT_SECONDS + 1
  const connect = [
    'nc_z=no',
    `case "$(${bounded(EGRESS_USAGE_TIMEOUT_SECONDS, `${busybox} nc`)} 2>&1)" in *-z*) nc_z=yes ;; esac`,
    'if [ "$nc_z" = yes ]; then',
    `  ${bounded(connectSeconds, `${busybox} nc -w ${EGRESS_CONNECT_TIMEOUT_SECONDS} -z ${where}`)} >/dev/null 2>&1`,
    'else',
    `  ${bounded(connectSeconds, `${busybox} nc ${where}`)} </dev/null >/dev/null 2>&1`,
    'fi',
  ].join('\n')
  const resolve = bounded(EGRESS_LOOKUP_TIMEOUT_SECONDS, `${busybox} nslookup ${target.dnsName}`)
  return [
    busybox,
    'sh',
    '-c',
    [
      `${connect}\necho "${EGRESS_TCP_MARKER}$?"`,
      `${resolve} >/dev/null 2>&1; echo "${EGRESS_DNS_MARKER}$?"`,
    ].join('\n'),
  ]
}

/**
 * Node's architecture names mapped onto the docker name for the same machine.
 *
 * This names THE PAYLOAD, never the daemon. `process.arch` is the architecture of the harness
 * process, and the binary it hands over is built for that; the daemon it is measured against
 * answers for itself (`docker version --format {{.Server.Arch}}`), and the caller compares the
 * two rather than assuming they agree. An external `DOCKER_HOST` is a first-class path here, and
 * an arm64 harness talking to an amd64 sidecar shares nothing with it but the socket.
 *
 * That comparison is also what makes two of these entries safe. `process.arch` reports `ppc64` on
 * both endiannesses and `arm` with no variant, so those rows are a HYPOTHESIS about the payload,
 * not a claim: a machine the guess is wrong about answers with a different name and the check
 * reports that it could not be carried out. Nothing here may produce a verdict about the daemon.
 * An architecture nothing maps does the same, which is why `386` was worth adding rather than
 * leaving to a fallback: the mapping is unambiguous and its absence cost a real check.
 */
const PAYLOAD_ARCHITECTURES: Readonly<Record<string, string>> = {
  x64: 'amd64',
  ia32: '386',
  arm64: 'arm64',
  arm: 'arm',
  s390x: 's390x',
  ppc64: 'ppc64le',
  riscv64: 'riscv64',
}

/** The docker name for the architecture THIS process's payload is built for, when there is one. */
export function payloadArchitecture(arch: string = process.arch): string | undefined {
  return PAYLOAD_ARCHITECTURES[arch]
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
 * `architecture` is the DAEMON's own word for its architecture, in docker's vocabulary, so
 * nothing here decides it (see {@link PAYLOAD_ARCHITECTURES}). The result is byte-stable for one
 * `(payload, architecture)` pair, which is what lets the caller build it once per container.
 */
export function buildProbeArchive(payload: Buffer, architecture: string): Buffer {
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
