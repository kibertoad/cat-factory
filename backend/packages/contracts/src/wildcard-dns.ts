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
// Both halves of that pairing were things the platform itself produced. The per-PR namespace
// default ended in `-<pullNumber>`, which has that shape for every pull request ever opened, and
// `backend/docs/local-k3s-environments.md` recommends exactly this host shape. Composed, they
// yielded an environment that rolled out, reported `ready`, published an address pointing
// somewhere else entirely, and died at the `tester` step forty minutes later with a connection
// error naming nothing that would lead anyone back to here. The defaults now render `pr<n>`, and
// this rule is what stops an operator's own templates re-composing the same name.
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
  return parseWildcardHost(host).suffix
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

/** The separator a four-octet run is written with. A run may not mix the two. */
type WildcardDnsSeparator = '.' | '-'

/** One four-octet run as the resolver finds it, kept with where and how it is written. */
interface WildcardDnsWindow {
  /** The address in dotted form, whatever it is spelled with in the name. */
  address: string
  /** The separator its four octets are joined by IN THE NAME. */
  separator: WildcardDnsSeparator
  /** Index of its first label in {@link ParsedWildcardHost.parts}. */
  start: number
}

/**
 * A host read once: normalised, split, and scanned for the addresses it carries.
 *
 * ONE parse per public call, because the three things every caller needs (the suffix, the
 * normalised host, the windows) are all products of the same scan. They used to be recomputed
 * independently, which is not just wasted work: it left two copies of the normalisation rule that
 * could disagree the moment either was changed on its own.
 */
interface ParsedWildcardHost {
  /** Trimmed, lowercased, with a root dot removed: the form every answer is phrased in. */
  host: string
  suffix: WildcardDnsSuffix | null
  /** Even indices are labels, odd indices the separator that preceded each one. */
  parts: string[]
  windows: readonly WildcardDnsWindow[]
}

/**
 * Read a host once, finding every four-octet address it embeds, left to right, as the resolver
 * would.
 *
 * Splitting on the separators is what enforces the label boundary: `pr5` and `5x` are single
 * tokens and neither is an octet, which is why `cf-acc-pr5.127.0.0.1.nip.io` resolves correctly
 * where `cf-acc-5.127.0.0.1.nip.io` does not. Windows OVERLAP by design (`1.2.3.4.5` holds both
 * `1.2.3.4` and `2.3.4.5`), because the resolver's own scan does.
 */
function parseWildcardHost(host: string): ParsedWildcardHost {
  const normalised = host.trim().toLowerCase().replace(/\.$/, '')
  const suffix = WILDCARD_DNS_SUFFIXES.find((entry) => normalised.endsWith(`.${entry}`)) ?? null
  const scanned = suffix ? normalised.slice(0, -(suffix.length + 1)) : normalised
  const parts = scanned.split(/([.-])/)
  const windows: WildcardDnsWindow[] = []
  for (let i = 0; i + 6 < parts.length; i += 2) {
    const labels = [parts[i], parts[i + 2], parts[i + 4], parts[i + 6]]
    if (labels.some((label) => label === undefined || !isOctet(label))) continue
    // A window's three separators must be the SAME character. `cf-acc-5.127-0-0-1.nip.io`
    // resolves to 127.0.0.1 precisely because the run starting at `5` mixes `.` and `-`, so the
    // resolver does not read it as an address at all.
    const separators = [parts[i + 1], parts[i + 3], parts[i + 5]]
    const separator = separators[0]
    if (new Set(separators).size !== 1) continue
    if (separator !== '.' && separator !== '-') continue
    windows.push({ address: labels.join('.'), separator, start: i })
  }
  return { host: normalised, suffix, parts, windows }
}

/**
 * Every four-octet address embedded in a host, left to right, in dotted form.
 *
 * The addresses alone, for a caller that only wants to know what a name carries;
 * {@link parseWildcardHost} owns what makes one.
 */
export function wildcardDnsWindows(host: string): string[] {
  return parseWildcardHost(host).windows.map((window) => window.address)
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
  const parsed = parseWildcardHost(host)
  if (!parsed.suffix) return null
  const resolved = parsed.windows[0]
  const trailing = parsed.windows[parsed.windows.length - 1]
  if (!resolved || !trailing || resolved.address === trailing.address) return null
  return {
    host: parsed.host,
    suffix: parsed.suffix,
    resolved: resolved.address,
    trailing: trailing.address,
  }
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

/** The trailing address as it is WRITTEN in `host` (dotted or dashed), for quoting back. */
function trailingAddressAsWritten(host: string): string | null {
  const { windows } = parseWildcardHost(host)
  const trailing = windows[windows.length - 1]
  return trailing ? trailing.address.replace(/\./g, trailing.separator) : null
}

/**
 * The same host with the trailing address spelled using the OTHER separator, or `null` when the
 * host carries no address to respell.
 *
 * What makes a respelling a fix is the uniform-separator rule: a prefix can only extend a run it
 * shares a separator with, so flipping the address's own separator breaks the earlier window
 * without touching the prefix. WHICH direction that is depends on what the operator already
 * wrote, which is the part the remedy used to assume rather than read.
 */
function respellTrailingAddress(host: string): string | null {
  const parsed = parseWildcardHost(host)
  const trailing = parsed.windows[parsed.windows.length - 1]
  if (!trailing) return null
  const flipped: WildcardDnsSeparator = trailing.separator === '.' ? '-' : '.'
  const parts = [...parsed.parts]
  parts[trailing.start + 1] = flipped
  parts[trailing.start + 3] = flipped
  parts[trailing.start + 5] = flipped
  const scanned = parts.join('')
  return parsed.suffix ? `${scanned}.${parsed.suffix}` : scanned
}

/**
 * Whether the answering window runs INTO the trailing address rather than sitting entirely ahead
 * of it.
 *
 * Overlapping is the ordinary case, and the one "end the prefix with a letter" addresses: the
 * prefix's last label became the address's first octet. Disjoint means the prefix carries a
 * complete address of its own, which no separator change removes, so telling someone to re-spell
 * anything would be advice that cannot work.
 */
function shiftedWindowsOverlap(host: string): boolean {
  const { windows } = parseWildcardHost(host)
  const first = windows[0]
  const last = windows[windows.length - 1]
  return first !== undefined && last !== undefined && first.start + 6 >= last.start
}

/**
 * How to make a mis-resolving host resolve, given that the address is not the part that is wrong.
 *
 * **Every remedy is VERIFIED against the rule above before it is offered**, rather than derived
 * from the mere fact that a shift exists. The respelling used to print "write the address with
 * dashes" unconditionally, which for a host already written `…-5-127-0-0-1.nip.io` described the
 * broken configuration back to the person who wrote it: a prefix extends a dashed run exactly as
 * it extends a dotted one, and only MIXING the two breaks it. So the candidate fix is now
 * computed, re-graded, and dropped when it would not have helped.
 *
 * Ordered by how little each one disturbs: the digits are almost always a pull-request number
 * doing necessary work (a namespace has to be unique per environment), so the first two fixes
 * keep them and break the SEPARATOR that lets them be read as an octet.
 */
export function wildcardDnsShiftRemedies(shift: WildcardDnsShift): readonly string[] {
  const remedies: string[] = [
    shiftedWindowsOverlap(shift.host)
      ? `End the prefix with a letter rather than a separator and digits: a namespace template ` +
        `of '…-pr{{pullNumber}}' renders 'pr5', which is not an octet, where '…-{{pullNumber}}' ` +
        `renders '5', which is.`
      : `Take the address out of the prefix: '${shift.resolved}' is a complete four-octet run ` +
        `standing on its own ahead of '${shift.trailing}', so no change to what separates them ` +
        `can stop it answering first.`,
  ]
  const respelled = respellTrailingAddress(shift.host)
  const written = trailingAddressAsWritten(shift.host)
  if (respelled !== null && written !== null && describeWildcardDnsShift(respelled) === null) {
    remedies.push(
      `Or spell the address with the other separator ` +
        `('${trailingAddressAsWritten(respelled)}.${shift.suffix}' rather than ` +
        `'${written}.${shift.suffix}'): a four-octet run has to use ONE separator throughout, so ` +
        `a prefix joined on with the other one can no longer extend it.`,
    )
  }
  remedies.push(
    `Or serve the environments from a host you control, where the address is in a DNS record ` +
      `rather than in the name.`,
  )
  return remedies
}
