import type {
  PrReportPublishResult,
  PrReportTarget,
  PrVerificationReportPublisher,
} from '@cat-factory/kernel'
import { readManagedSection, spliceManagedSection } from '@cat-factory/kernel'

/** The repo every block's own-service PR lives in, for the suite's purposes. */
const OWN_REPO = 'acme/api'

/** The connection a target names; the GitHub adapter would put a stringified installation id here. */
const CONNECTION = { provider: 'github', connectionId: '1' } as const

/**
 * Deterministic {@link PrVerificationReportPublisher} for the cross-runtime conformance
 * suite: an in-memory stand-in for a PR description per pull request.
 *
 * It runs the REAL {@link spliceManagedSection} the `@cat-factory/server`
 * `GitHubPrReportPublisher` uses, so a suite assertion covers the whole contract — the
 * composed report AND its in-place idempotency (a retry rewrites the marked region instead
 * of appending a second report) — without a VCS connection on either facade.
 *
 * Bodies are keyed per PULL REQUEST, not per block, because a multi-repo run publishes a
 * DIFFERENT report to each of its PRs (a peer's copy withholds the own-service-only sections).
 * One body per block would let the two overwrite each other and the suite would pass while the
 * peers carried the own-service report. It is the port's own unit too: `publish` addresses a
 * pull request and is handed nothing else.
 *
 * Each block therefore gets its OWN pull-request number (see `ownTarget`), so two blocks never
 * share a body by accident. Two blocks deliberately seeded with the SAME peer PR do share one,
 * which is the truth being modelled: that is one pull request, and a real adapter would write
 * both reports into it.
 */
export class FakePrReportPublisher implements PrVerificationReportPublisher {
  /**
   * The current "PR body" per PULL REQUEST (`<repo>#<number>`). PRIVATE, and seeded through an
   * accessor rather than written directly, because the key is not something a caller should have
   * to know: it was the block id alone, then the block plus its PR, and each time a suite that
   * kept using the old form silently seeded a body no publish ever reads (the report then lands
   * on an empty one and the "the agent's own prose survives" assertion tests nothing). Go through
   * {@link seedBody} / {@link body}.
   */
  private readonly bodies = new Map<string, string>()
  /** Every publish call, in order, for asserting how many remote writes were attempted. */
  readonly calls: {
    workspaceId: string
    repo: string
    prNumber: number
    role: 'own' | 'peer'
    published: boolean
  }[] = []
  /**
   * Blocks with no resolvable PR. A block absent from this set resolves, so the common case
   * needs no seeding; add one to exercise the engine's "nowhere to publish" short-circuit.
   */
  readonly unresolvable = new Set<string>()
  /**
   * PEER pull requests per block — a cross-service run's connected-service PRs. Empty for every
   * block unless a suite seeds one, so a single-repo assertion is untouched by this existing.
   */
  readonly peers = new Map<string, PrReportTarget[]>()
  /**
   * Each block's own-service target, minted on first resolve with its OWN pull-request number.
   * Distinct per block on purpose: `publish` addresses a pull request and nothing else (that is
   * the port's contract), so two blocks sharing a PR identity would share a body, and a suite
   * driving two runs would assert one's report while reading the other's.
   */
  private readonly ownByBlock = new Map<string, PrReportTarget>()

  /**
   * Seed the OWN-SERVICE pull request's body — the coder's own description, as it stands before
   * the engine ever touches it. Use this rather than writing the map directly.
   */
  seedBody(blockId: string, body: string): void {
    this.bodies.set(bodyKey(this.ownTarget(blockId)), body)
  }

  /** The full current body of a block's own-service PR (prose + any managed region). */
  body(blockId: string): string | undefined {
    return this.bodies.get(bodyKey(this.ownTarget(blockId)))
  }

  /** The full current body of one of the block's PEER pull requests. */
  peerBody(blockId: string, repo: string): string | undefined {
    const target = this.peers.get(blockId)?.find((t) => t.repo === repo)
    return target ? this.bodies.get(bodyKey(target)) : undefined
  }

  /** Seed a block's peer PR (the multi-repo case), returning the target it will resolve. */
  addPeer(blockId: string, repo: string, prNumber: number, frameId?: string): PrReportTarget {
    const target: PrReportTarget = {
      prNumber,
      repo,
      provider: 'github',
      connection: CONNECTION,
      role: 'peer',
      frameId: frameId ?? null,
      url: `https://github.test/${repo}/pull/${prNumber}`,
    }
    this.peers.set(blockId, [...(this.peers.get(blockId) ?? []), target])
    return target
  }

  async resolveTargets(_workspaceId: string, blockId: string): Promise<PrReportTarget[]> {
    if (this.unresolvable.has(blockId)) return []
    // Own FIRST, exactly like the real adapter: the engine reads the peer reports' back-pointer
    // off the head of this list.
    return [this.ownTarget(blockId), ...(this.peers.get(blockId) ?? [])]
  }

  async publish(
    workspaceId: string,
    target: PrReportTarget,
    section: string,
  ): Promise<PrReportPublishResult> {
    const key = bodyKey(target)
    const current = this.bodies.get(key) ?? ''
    const next = spliceManagedSection(current, section)
    const published = next !== current
    if (published) this.bodies.set(key, next)
    this.calls.push({
      workspaceId,
      repo: target.repo,
      prNumber: target.prNumber,
      role: target.role,
      published,
    })
    return published
      ? { published: true, prNumber: target.prNumber }
      : { published: false, skipped: 'unchanged', prNumber: target.prNumber }
  }

  /**
   * The engine-managed region of a block's OWN-SERVICE PR body, or null when none was
   * published. This is the report a single-repo run produces, and the complete one.
   */
  section(blockId: string): string | null {
    return readManagedSection(this.body(blockId))
  }

  /** The same, for one of the block's PEER pull requests (addressed by its repo). */
  peerSection(blockId: string, repo: string): string | null {
    return readManagedSection(this.peerBody(blockId, repo))
  }

  /** The block's own-service target, minted once and stable for the fake's lifetime. */
  private ownTarget(blockId: string): PrReportTarget {
    const existing = this.ownByBlock.get(blockId)
    if (existing) return existing
    const prNumber = this.ownByBlock.size + 1
    const target: PrReportTarget = {
      prNumber,
      repo: OWN_REPO,
      provider: 'github',
      connection: CONNECTION,
      role: 'own',
      frameId: null,
      url: `https://github.test/${OWN_REPO}/pull/${prNumber}`,
    }
    this.ownByBlock.set(blockId, target)
    return target
  }

  /**
   * The machine-readable payload out of a block's published report — the fenced JSON block
   * the section carries — parsed as `unknown` so the suite can run it through the contracts
   * schema itself. Null when no report (or no JSON fence) is present.
   */
  reportJson(blockId: string): unknown {
    return parseFence(this.section(blockId))
  }

  /** The same, for one of the block's PEER pull requests. */
  peerReportJson(blockId: string, repo: string): unknown {
    return parseFence(this.peerSection(blockId, repo))
  }
}

/** One body per PULL REQUEST — see the class doc for why the block is not part of the key. */
function bodyKey(target: PrReportTarget): string {
  return `${target.repo}#${target.prNumber}`
}

function parseFence(section: string | null): unknown {
  const match = section?.match(/```json\n([\s\S]*?)\n```/)
  return match ? JSON.parse(match[1]!) : null
}
