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
import { isLocalMachineHost, isLoopbackHost } from './ip-host.logic.js'

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
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (!host) return false
  if (isLocalMachineHost(host)) return true
  // Only a wildcard-DNS name may be read for an embedded address. Any other name that happens to
  // contain four dotted octets is a name whose real answer comes from a real zone, and reading it
  // as an address would bridge a host that resolves somewhere else entirely.
  if (!wildcardDnsSuffix(host)) return false
  const [resolved] = wildcardDnsWindows(host)
  return resolved !== undefined && isLoopbackHost(resolved)
}

// The URL half of this (pull the hostname out, decide whether to bridge it) is deliberately NOT
// here: kernel compiles against `lib: ["ES2022"]` with no DOM and no Node types, so `URL` is
// unavailable by design, and hand-rolling an authority parser to dodge that would trade a correct
// two-line call for userinfo, port and IPv6-bracket bugs. The caller that has a URL and a container
// to configure owns it (`runtimes/local/src/environmentBridge.ts`); what belongs here is the RULE,
// which is the part more than one layer has to agree about.
