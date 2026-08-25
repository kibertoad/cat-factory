// ---------------------------------------------------------------------------
// Wildcard-DNS hostnames, and the way they mis-resolve when a name is prefixed onto them.
//
// `nip.io` and `sslip.io` answer any name that CONTAINS an IPv4 address, which is what makes
// `<namespace>.127.0.0.1.nip.io` a working ephemeral-environment URL on a machine with no DNS to
// administer. The trap is in HOW they find that address: the resolver scans the name for a run of
// four octets and answers the LEFTMOST one it finds, treating `.` and `-` as equally valid
// separators. A prefix ending in a separator plus digits therefore contributes a window of its
// own, and being further left, it wins:
//
//     cf-acc-5.127.0.0.1.nip.io   ->  5.127.0.0     (a stranger's network)
//     app.127.0.0.1.nip.io        ->  127.0.0.1     (the control, one label different)
//
// Both halves of that pairing are things the platform itself produces. The default per-PR
// namespace is `cf-env-<repoName>-<pullNumber>`, which ends in a separator plus digits for every
// pull request ever opened, and `backend/docs/local-k3s-environments.md` recommends exactly this
// host shape. Composed, they yield an environment that rolls out, reports `ready`, publishes an
// address pointing somewhere else entirely, and dies at the `tester` step forty minutes later
// with a connection error naming nothing that would lead anyone back to here.
//
// **The rule is exact, not a heuristic**, which is what lets a caller REFUSE on it: every clause
// below was read off live resolutions rather than off nip.io's source (the fixtures in the test
// beside this file are those lookups). An octet rejects a leading zero and anything above 255, a
// window's three separators must be the same character, and a window has to start and end on a
// label boundary. Each of those is a case where the name still resolves correctly, so a looser
// rule here would refuse a working deployment.
//
// It lives in contracts because it grades a value contracts already owns (`hostTemplate` on the
// Kubernetes URL source, `environments-kubernetes.ts`) and more than one side has to agree about
// it: the environment provider refuses a provision whose URL would mis-resolve, and the
// acceptance suite's preflight grades its configured namespace/host pair before a pass spends
// anything. The SPA's two engine forms are the natural third caller and do not use it yet; the
// point of putting it here is that when they do, they call it rather than restate it.
// ---------------------------------------------------------------------------

/**
 * The wildcard-DNS services this rule knows, as they appear at the END of a hostname.
 *
 * An allow-list rather than a pattern: the mis-parse is a property of how THESE resolvers read a
 * name, so a host that merely looks similar is none of this rule's business and must not be
 * refused on its behalf.
 */
export const WILDCARD_DNS_SUFFIXES = ['nip.io', 'sslip.io'] as const

export type WildcardDnsSuffix = (typeof WILDCARD_DNS_SUFFIXES)[number]

/** The wildcard-DNS service a host is served by, or `null` for an ordinary hostname. */
export function wildcardDnsSuffix(host: string): WildcardDnsSuffix | null {
  const lower = host.trim().toLowerCase().replace(/\.$/, '')
  return WILDCARD_DNS_SUFFIXES.find((suffix) => lower.endsWith(`.${suffix}`)) ?? null
}

/**
 * Whether a label is an octet AS THESE RESOLVERS READ ONE.
 *
 * The two rejections are load-bearing and both were confirmed by lookup: `cf-acc-05.127.0.0.1`
 * and `foo-999.127.0.0.1` each resolve to 127.0.0.1, because a leading zero and a value above 255
 * are not octets, so neither prefix opens a window. Accepting them here would refuse two host
 * shapes that work.
 */
function isOctet(text: string): boolean {
  return /^(?:0|[1-9][0-9]{0,2})$/.test(text) && Number(text) <= 255
}

/**
 * Every four-octet address embedded in a host, left to right, as the resolver would find them.
 *
 * Splitting on the separators is what enforces the label boundary: `pr5` and `5x` are single
 * tokens and neither is an octet, which is why `cf-acc-pr5.127.0.0.1.nip.io` resolves correctly
 * where `cf-acc-5.127.0.0.1.nip.io` does not. Windows OVERLAP by design (`1.2.3.4.5` holds both
 * `1.2.3.4` and `2.3.4.5`), because the resolver's own scan does.
 */
export function wildcardDnsWindows(host: string): string[] {
  const suffix = wildcardDnsSuffix(host)
  const lower = host.trim().toLowerCase().replace(/\.$/, '')
  const scanned = suffix ? lower.slice(0, -(suffix.length + 1)) : lower
  // Even indices are labels, odd indices the separator that preceded each one.
  const parts = scanned.split(/([.-])/)
  const windows: string[] = []
  for (let i = 0; i + 6 < parts.length; i += 2) {
    const labels = [parts[i], parts[i + 2], parts[i + 4], parts[i + 6]]
    if (labels.some((label) => label === undefined || !isOctet(label))) continue
    // A window's three separators must be the SAME character. `cf-acc-5.127-0-0-1.nip.io`
    // resolves to 127.0.0.1 precisely because the run starting at `5` mixes `.` and `-`, so the
    // resolver does not read it as an address at all.
    const separators = [parts[i + 1], parts[i + 3], parts[i + 5]]
    if (new Set(separators).size !== 1) continue
    windows.push(labels.join('.'))
  }
  return windows
}

/**
 * A host whose wildcard-DNS answer is not the address its trailing labels name.
 *
 * `resolved` is what a lookup returns and `trailing` is what whoever configured the template
 * meant, which is the pair a remedy needs: neither alone explains why a correct-looking URL
 * reaches the wrong machine.
 */
export type WildcardDnsShift = {
  host: string
  suffix: WildcardDnsSuffix
  /** What the resolver answers: the leftmost window. */
  resolved: string
  /** The address the fixed tail of the name carries: the rightmost window. */
  trailing: string
}

/**
 * Grade a RENDERED host, answering `null` when there is nothing to report.
 *
 * `null` covers three different innocent cases on purpose, because none of them is actionable:
 * an ordinary hostname, a wildcard host holding exactly one address (whatever it is, that is the
 * one that answers), and a host whose leftmost window IS the trailing one. Only a name carrying
 * two DIFFERENT addresses can send a caller somewhere it did not ask for.
 */
export function describeWildcardDnsShift(host: string): WildcardDnsShift | null {
  const suffix = wildcardDnsSuffix(host)
  if (!suffix) return null
  const windows = wildcardDnsWindows(host)
  const resolved = windows[0]
  const trailing = windows[windows.length - 1]
  if (!resolved || !trailing || resolved === trailing) return null
  return { host: host.trim().toLowerCase().replace(/\.$/, ''), suffix, resolved, trailing }
}

/**
 * The one wording of this failure, so the provider's refusal and the preflight's remedy do not
 * drift into two accounts of the same thing.
 *
 * It names the rendered host FIRST: the reader is holding a template and a namespace, and the
 * composition of the two is the thing they have never seen written down.
 */
export function describeWildcardDnsShiftProblem(shift: WildcardDnsShift): string {
  return (
    `'${shift.host}' resolves to ${shift.resolved}, not ${shift.trailing}: ${shift.suffix} reads ` +
    `the LEFTMOST four-octet run in a name and treats '.' and '-' alike, so the label before ` +
    `${shift.trailing} ends in a separator plus digits and opens an earlier address. Anything ` +
    `reaching this URL reaches ${shift.resolved}, which is not this cluster`
  )
}

/**
 * How to make a mis-resolving host resolve, given that the address is not the part that is wrong.
 *
 * Ordered by how little each one disturbs: the digits are almost always a pull-request number
 * doing necessary work (a namespace has to be unique per environment), so the first two fixes
 * keep them and break the SEPARATOR that lets them be read as an octet.
 */
export function wildcardDnsShiftRemedies(shift: WildcardDnsShift): readonly string[] {
  return [
    `End the prefix with a letter rather than a separator and digits: a namespace template of ` +
      `'…-pr{{pullNumber}}' renders 'pr5', which is not an octet, where '…-{{pullNumber}}' ` +
      `renders '5', which is.`,
    `Or write the address with dashes instead of dots ('${shift.trailing.replace(/\./g, '-')}` +
      `.${shift.suffix}'): a run mixing the two separators is not read as an address, so the ` +
      `prefix can no longer open one.`,
    `Or serve the environments from a host you control, where the address is in a DNS record ` +
      `rather than in the name.`,
  ]
}
