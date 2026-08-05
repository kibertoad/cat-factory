import type {
  PrReportPublishResult,
  PrReportTarget,
  PrVerificationReportPublisher,
} from '@cat-factory/kernel'
import { readManagedSection, spliceManagedSection } from '@cat-factory/kernel'

/** The own-service PR every resolvable block has, unless a suite seeds peers beside it. */
const OWN_TARGET: PrReportTarget = {
  prNumber: 1,
  repo: 'acme/api',
  provider: 'github',
  role: 'own',
  frameId: null,
  url: 'https://github.test/acme/api/pull/1',
}

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
 * peers carried the own-service report.
 */
export class FakePrReportPublisher implements PrVerificationReportPublisher {
  /**
   * The current "PR body" per `<blockId> <repo>#<number>`. PRIVATE, and keyed rather than seeded
   * directly, because the key is not something a caller should have to know: it used to be the
   * block id alone, and a suite that kept setting it that way would silently seed a body no
   * publish ever reads (the report then lands on an empty one and the "the agent's own prose
   * survives" assertion tests nothing). Go through {@link seedBody} / {@link body}.
   */
  private readonly bodies = new Map<string, string>()
  /** Every publish call, in order, for asserting how many remote writes were attempted. */
  readonly calls: {
    workspaceId: string
    blockId: string
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
   * Seed the OWN-SERVICE pull request's body — the coder's own description, as it stands before
   * the engine ever touches it. Use this rather than writing the map directly.
   */
  seedBody(blockId: string, body: string): void {
    this.bodies.set(bodyKey(blockId, OWN_TARGET), body)
  }

  /** The full current body of a block's own-service PR (prose + any managed region). */
  body(blockId: string): string | undefined {
    return this.bodies.get(bodyKey(blockId, OWN_TARGET))
  }

  /** The full current body of one of the block's PEER pull requests. */
  peerBody(blockId: string, repo: string): string | undefined {
    const target = this.peers.get(blockId)?.find((t) => t.repo === repo)
    return target ? this.bodies.get(bodyKey(blockId, target)) : undefined
  }

  /** Seed a block's peer PR (the multi-repo case), returning the target it will resolve. */
  addPeer(blockId: string, repo: string, prNumber: number, frameId?: string): PrReportTarget {
    const target: PrReportTarget = {
      prNumber,
      repo,
      provider: 'github',
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
    return [OWN_TARGET, ...(this.peers.get(blockId) ?? [])]
  }

  async publish(
    workspaceId: string,
    blockId: string,
    target: PrReportTarget,
    section: string,
  ): Promise<PrReportPublishResult> {
    const key = bodyKey(blockId, target)
    const current = this.bodies.get(key) ?? ''
    const next = spliceManagedSection(current, section)
    const published = next !== current
    if (published) this.bodies.set(key, next)
    this.calls.push({
      workspaceId,
      blockId,
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
    return readManagedSection(this.bodies.get(bodyKey(blockId, OWN_TARGET)))
  }

  /** The same, for one of the block's PEER pull requests (addressed by its repo). */
  peerSection(blockId: string, repo: string): string | null {
    const target = this.peers.get(blockId)?.find((t) => t.repo === repo)
    return target ? readManagedSection(this.bodies.get(bodyKey(blockId, target))) : null
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

/** One body per (block, pull request) — see the class doc for why the PR is part of the key. */
function bodyKey(blockId: string, target: PrReportTarget): string {
  return `${blockId} ${target.repo}#${target.prNumber}`
}

function parseFence(section: string | null): unknown {
  const match = section?.match(/```json\n([\s\S]*?)\n```/)
  return match ? JSON.parse(match[1]!) : null
}
