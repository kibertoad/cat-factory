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
import { decodeIpv4, isLocalMachineHost, isLoopbackHost } from './ip-host.logic.js'

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
  /** Not this machine. The container reaches it as written, and re-pointing it would break it. */
  | { kind: 'none' }
  /** A NAME an added hosts-file entry re-points. `host` is what to map to the host gateway. */
  | { kind: 'bridge'; host: string }
  /** This machine, and no hosts-file entry can reach it. See {@link isHostsFileAddressable}. */
  | { kind: 'unbridgeable'; host: string }

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
 * Grade a hostname for the host-gateway bridge: leave it alone, map it, or report that it names
 * this machine and cannot be mapped.
 *
 * The whole rule lives here rather than beside the container runtime because more than one layer
 * has to agree about it, and because both wrong answers are silent in production: bridging a
 * remote host breaks an environment that worked, and not bridging a wildcard-DNS loopback name
 * leaves the tester on connection failures it reports as a dead environment.
 */
export function classifyLocalMachineHostBridge(hostname: string): LocalMachineHostBridge {
  const host = normalizeHostname(hostname)
  if (!host) return { kind: 'none' }
  if (!resolvesToLocalMachine(host)) return { kind: 'none' }
  return isHostsFileAddressable(host) ? { kind: 'bridge', host } : { kind: 'unbridgeable', host }
}

// The URL half of this (pull the hostname out, decide whether to bridge it) is deliberately NOT
// here: kernel compiles against `lib: ["ES2022"]` with no DOM and no Node types, so `URL` is
// unavailable by design, and hand-rolling an authority parser to dodge that would trade a correct
// two-line call for userinfo, port and IPv6-bracket bugs. The caller that has a URL and a container
// to configure owns it (`runtimes/local/src/environmentBridge.ts`); what belongs here is the RULE,
// which is the part more than one layer has to agree about.
