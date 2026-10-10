// Whether a containerized agent can reach an environment URL, and what it takes to make it able to.
//
// **The problem, and why it is not the same one PR #2075 fixed.** An ephemeral-environment URL on a
// local deployment names a host that resolves to loopback: `127.0.0.1`, `app.localhost`, or a
// wildcard-DNS name with the address written into it (`cf-acc-pr8.127.0.0.1.nip.io`). That is
// exactly right for the operator's browser and for a natively-run agent, because loopback IS the
// machine the cluster's ingress port is published on. It is a dead end for an agent running in a
// container, whose `127.0.0.1` is its own network namespace with nothing listening on it. The
// symptom is total and unhelpful: the tester that motivated this module reported `curl` code 000 on
// every one of ~39 attempts over fourteen minutes and concluded the ENVIRONMENT was down, when the
// environment was serving perfectly to anything on the host.
//
// PR #2075 fixed the case where such a name resolves to the WRONG NETWORK (a leftmost four-octet
// window donating a label to an earlier address). This is the case where it resolves to exactly the
// right address and that address means something different to the reader. Both are ways an
// environment URL is a claim nobody verified; neither is visible in the other's evidence.
//
// **Why a `--add-host` bridge and not a different URL.** The alternative is to publish a URL naming
// the container runtime's host gateway, and it was measured rather than reasoned about:
// `cf-acc-pr8.192.168.65.254.nip.io` does reach the ingress from inside a container (HTTP 404 from
// the controller, so the request arrived) and does NOT reach it from the host, which is where the
// operator's browser and the human-test gate read the same URL. There is no single address that
// works for both audiences, so the ONE name has to mean the right thing in each place. Mapping the
// name to the gateway inside the container does that, and it keeps the `Host` header the ingress
// routes on correct for free, which a rewritten authority would not.

import { wildcardDnsSuffix, wildcardDnsWindows } from '@cat-factory/contracts'
import {
  decimalV4,
  decodeIpv4,
  decodeIpv6,
  isCloudMetadataHost,
  isLocalMachineHost,
  isLoopbackHost,
  mappedV4,
} from './ip-host.logic.js'

/**
 * The one spelling every rule here compares against: lower-cased, trimmed, IPv6 brackets and the
 * fully-qualified trailing dot removed. Shared rather than repeated so a hostname cannot be judged
 * local by one function and unbridgeable-by-a-different-normalisation in the next.
 */
function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
}

/**
 * Whether a hostname's answer is the machine the process reading it runs on.
 *
 * Wider than {@link isLocalMachineHost} by exactly one case, and that case is the entire reason
 * this exists: a wildcard-DNS name carries its address in its LABELS, so `cf-acc-pr8.127.0.0.1.
 * nip.io` is a loopback name that no literal-host test recognises. Which address such a name
 * answers is `@cat-factory/contracts`' rule and is read from there rather than re-derived, because
 * getting it wrong in a second place is how the two would disagree about the same string: the
 * resolver answers the LEFTMOST four-octet window, which is why the suffix and the window order
 * both matter and why `wildcardDnsWindows` is the only thing here that knows it.
 *
 * Deliberately SYNTACTIC, with no lookup. A DNS call would be a truer answer and the wrong
 * mechanism: it puts network I/O and a new failure mode on the container-dispatch path, where the
 * question is asked, and it would make the bridge depend on what a resolver happened to say at
 * dispatch time rather than on something a test can pin.
 */
export function resolvesToLocalMachine(hostname: string): boolean {
  const host = normalizeHostname(hostname)
  if (!host) return false
  if (isLocalMachineHost(host)) return true
  // Only a wildcard-DNS name may be read for an embedded address. Any other name that happens to
  // contain four dotted octets is a name whose real answer comes from a real zone, and reading it
  // as an address would bridge a host that resolves somewhere else entirely.
  if (!wildcardDnsSuffix(host)) return false
  const [resolved] = wildcardDnsWindows(host)
  return resolved !== undefined && isLoopbackHost(resolved)
}

/**
 * What a host bridge can do for a hostname: nothing, re-point it, or nothing DESPITE it naming
 * this machine.
 *
 * Three members rather than a boolean because the third is a distinct fact needing a distinct
 * reaction, and collapsing it into either neighbour is wrong in a way that costs a run. Read as
 * `none`, a genuinely unreachable environment goes unremarked. Read as `bridge`, the transport
 * pays real costs for an entry that cannot work: the job leaves the warm pool and its container is
 * replaced, for a `--add-host` the container will not honour.
 */
export type LocalMachineHostBridge =
  /** Not this machine, and nowhere else to point it. The container reaches it as written. */
  | { kind: 'none' }
  /** A NAME an added hosts-file entry re-points, and what to point it AT. */
  | { kind: 'bridge'; host: string; target: HostBridgeTarget }
  /** No hosts-file entry can make this reachable, and {@link UnbridgeableCause} says why. */
  | { kind: 'unbridgeable'; host: string; cause: UnbridgeableCause }

/**
 * Why a name cannot be bridged, because the two causes have different remedies and a transport
 * that reported them with one sentence would send an operator to the wrong fix.
 *
 *   - `local_machine`    the URL names THIS machine by a spelling no hosts entry re-points
 *                        (`localhost`, a bare IP literal). Remedy: publish the environment on a
 *                        name that resolves to the host, or run the step natively.
 *   - `unusable_address` the platform PROVED the name does not carry and that an address does, and
 *                        that address cannot be installed: it is one no bridge may name, or the
 *                        URL's own host is a literal nothing looks up. Remedy: publish a name and
 *                        an address a bridge may name. This one is a run heading for failure with
 *                        a proof on the record saying the environment is reachable, which is
 *                        evidence pointing further from the cause than no bridge at all.
 */
export type UnbridgeableCause = 'local_machine' | 'unusable_address'

/**
 * What a bridged name is mapped TO.
 *
 * A member on `bridge` rather than a fourth sibling `kind`, so `none` / `bridge` / `unbridgeable`
 * keep meaning exactly what they mean: the three of them answer "what can this transport do about
 * this name", and both targets are the same answer (re-point it) with different data.
 *
 *   - `host-gateway` is the container runtime's own alias for the machine it runs on, and it is
 *     the ONLY target a local-machine name can take. It is a Docker-family token, resolved by the
 *     runtime rather than by us, which is why it is a literal here and never an address.
 *   - `{ ip }` is an address the ENVIRONMENT'S PROVIDER stated carries traffic for this name. It
 *     is the remote case, and it is the case that makes a bridge target DATA for the first time.
 *     Two rules bind it, both in {@link isBridgeableAddress} and at the caller: the address must
 *     be one a bridge may name, and the HOST side must be a host the job was actually handed,
 *     never a free-form string a provider chose. A provider that could re-point any name inside
 *     the container could re-point the harness's own alias for reaching back to its host.
 */
export type HostBridgeTarget = 'host-gateway' | { ip: string }

/**
 * Whether an address a provider stated may be used as a bridge target.
 *
 * Until this existed the target was the fixed literal `host-gateway`, so the destination of every
 * bridge was CODE. An address makes it DATA, on a path whose container is itself the trust
 * boundary, so the rule is stated here beside the classifier rather than left to whichever
 * adapter interpolates the string.
 *
 * Deliberately NOT {@link isBlockedPrivateHost}, which is the strict policy for a URL an org
 * supplies and blocks the whole RFC1918 space. An internal load balancer on `10.x` is precisely
 * the population this feature exists for, and refusing it would leave the feature with nothing to
 * name. What is refused instead is the set an address bridge could only ever be ABUSED to reach:
 *
 *   - Anything that is not a CANONICAL literal. `decodeIpv4` accepts a bare 32-bit integer and
 *     hex/octal octets because a URL guard must see through those encodings; a bridge target has
 *     no reason to be spelled that way, and accepting the obfuscated forms is how `2130706433`
 *     becomes loopback in a reader that only pattern-matched `127.`.
 *   - LOOPBACK, which inside a container is the container's own namespace, where the harness
 *     itself is listening. A name re-pointed there does not reach the host; it reaches us.
 *   - LINK-LOCAL and the vendor metadata addresses, the endpoint an SSRF aims at for instance
 *     credentials, reached here by a name the agent has every reason to fetch.
 *   - The unspecified, multicast and broadcast addresses, which name no host at all.
 *
 * Every one of those classes is judged on the DECODED address rather than on how it is written.
 * IPv6 has many spellings of one value, so a `host === '::1'` comparison admits `0::1` and
 * `0:0:0:0:0:0:0:1`, and a `startsWith('fe80:')` test covers an eighth of `fe80::/10`; the
 * metadata targets are read out of `isCloudMetadataHost`, the swept definition every other guard
 * in the tree shares, rather than restated here where a vendor added there would not reach.
 */
export function isBridgeableAddress(address: string): boolean {
  const host = normalizeHostname(address)
  if (!host) return false
  // Link-local (169.254/16, incl. IMDS), every vendor metadata address and the metadata NAMES,
  // across every obfuscated encoding. One definition, shared with the SSRF guards.
  if (isCloudMetadataHost(host)) return false
  if (host.includes(':')) {
    // IPv6. An IPv4-mapped literal is judged on the address it carries, never on its spelling.
    const mapped = mappedV4(host)
    if (mapped) return isBridgeableV4(mapped)
    const groups = decodeIpv6(host)
    return groups !== null && isBridgeableV6(groups)
  }
  const v4 = decimalV4(host)
  return v4 !== null && isBridgeableV4(v4)
}

/** The IPv4 half of {@link isBridgeableAddress}, once the literal has been decoded. */
function isBridgeableV4(parts: [number, number, number, number]): boolean {
  const [a] = parts
  if (a === 0 || a === 127) return false // unspecified / loopback
  if (a >= 224) return false // multicast, reserved, and 255.255.255.255
  return true
}

/** The IPv6 half, judged on the decoded groups so no spelling of a refused class gets through. */
function isBridgeableV6(groups: readonly number[]): boolean {
  if (groups.every((group) => group === 0)) return false // unspecified, `::`
  // Loopback, `::1` in any spelling.
  if (groups.every((group, index) => group === (index === 7 ? 1 : 0))) return false
  const first = groups[0] ?? 0
  if ((first & 0xffc0) === 0xfe80) return false // link-local, fe80::/10
  if ((first & 0xff00) === 0xff00) return false // multicast, ff00::/8
  return true
}

/**
 * Whether mapping `host` to the container's host gateway would achieve anything.
 *
 * The bridge is a hosts-file entry, so it only reaches a name that is LOOKED UP and not already
 * answered. Two local-machine spellings fail that test, and both arrive here routinely:
 *
 *   - An IP LITERAL (`127.0.0.1`, `::1`, `0.0.0.0`) is never resolved through a hosts file at all.
 *     A `--add-host=127.0.0.1:host-gateway` entry names an address as if it were a hostname; the
 *     container simply dials the literal, into its own namespace.
 *   - `localhost` is pinned by the image's own `/etc/hosts`, whose `127.0.0.1 localhost` line
 *     comes FIRST, and a file resolver answers with the first match. An appended entry is inert.
 *     Were it not inert it would be worse than useless: the harness serves the frontend flow's
 *     WireMock and its built app on `localhost` INSIDE the container, so re-pointing that name
 *     would break the very services the job is there to drive.
 *
 * A local-machine URL spelled either way is a real problem (a containerized agent cannot reach a
 * compose environment published on `http://localhost:<port>`), and it is not this mechanism's to
 * solve: the caller is told `unbridgeable` so it can say so, rather than being handed a bridge
 * that quietly does nothing.
 *
 * `*.localhost` and a wildcard-DNS name are NOT in that set and are the cases this exists for:
 * neither appears in a base image's hosts file, so an added entry is the first and only match.
 */
function isHostsFileAddressable(host: string): boolean {
  if (host === 'localhost') return false
  // Every IPv6 literal, including `::1` and the `::` wildcard bind (a hostname never holds a colon).
  if (host.includes(':')) return false
  return decodeIpv4(host) === null
}

/**
 * Grade a hostname for a host bridge: leave it alone, map it (to the host gateway or to a stated
 * address), or report that it names this machine and cannot be mapped.
 *
 * The whole rule lives here rather than beside the container runtime because more than one layer
 * has to agree about it, and because both wrong answers are silent in production: bridging a
 * remote host breaks an environment that worked, and not bridging a wildcard-DNS loopback name
 * leaves the tester on connection failures it reports as a dead environment.
 *
 * `address` is the address the environment's provider stated for THIS hostname, already PROVED to
 * carry (see `EnvironmentRouteProof`); absent means the name is all anyone has. The two cases are
 * ordered rather than combined, and the order is not arbitrary: a name that answers with this
 * machine's own address is a dead end inside a container whatever a provider says about it, so it
 * takes the gateway branch first and a stated address never overrides it.
 *
 * Note the asymmetry this leaves, which is correct. A REMOTE name with NO address is reported
 * `none`: it reaches whatever it reaches from inside the container exactly as it does outside, and
 * there is nothing to report. A remote name WITH one is a different fact, because an address is
 * only ever present when the proof established that the name did not carry and the address did
 * (`EnvironmentRouteProof.via`). Failing to install THAT is a run heading for the connection
 * failures this mechanism exists to stop, with a proof on the record vouching for a route the
 * container never got, so it is reported `unbridgeable` rather than passed over as `none`.
 */
export function classifyLocalMachineHostBridge(
  hostname: string,
  address?: string | null,
): LocalMachineHostBridge {
  const host = normalizeHostname(hostname)
  if (!host) return { kind: 'none' }
  if (resolvesToLocalMachine(host)) {
    return isHostsFileAddressable(host)
      ? { kind: 'bridge', host, target: 'host-gateway' }
      : { kind: 'unbridgeable', host, cause: 'local_machine' }
  }
  if (!address) return { kind: 'none' }
  const ip = normalizeHostname(address)
  if (!isBridgeableAddress(ip) || !isHostsFileAddressable(host)) {
    return { kind: 'unbridgeable', host, cause: 'unusable_address' }
  }
  return { kind: 'bridge', host, target: { ip } }
}

/**
 * The one spelling of a bridge, for comparing a needed bridge against what a running container
 * was CREATED with and for recording it on that container's handle.
 *
 * Derived rather than hand-formatted at each site because the comparison is an IDENTITY: a
 * mismatch destroys and rebuilds a warm container, so two spellings of the same bridge would
 * replace one for nothing, and one spelling covering two different targets would leave a run
 * wedged against a stale address in a container nothing will replace.
 */
export function hostBridgeKey(bridge: { host: string; target: HostBridgeTarget }): string {
  const target = bridge.target === 'host-gateway' ? 'host-gateway' : bridge.target.ip
  return bridge.host + '=' + target
}

// The URL half of this (pull the hostname out, decide whether to bridge it) is deliberately NOT
// here: kernel compiles against `lib: ["ES2022"]` with no DOM and no Node types, so `URL` is
// unavailable by design, and hand-rolling an authority parser to dodge that would trade a correct
// two-line call for userinfo, port and IPv6-bracket bugs. The caller that has a URL and a container
// to configure owns it (`runtimes/local/src/environmentBridge.ts`); what belongs here is the RULE,
// which is the part more than one layer has to agree about.
