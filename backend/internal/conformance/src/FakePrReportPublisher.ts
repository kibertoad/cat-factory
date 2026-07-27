import type {
  PrReportPublishResult,
  PrReportTarget,
  PrVerificationReportPublisher,
} from '@cat-factory/kernel'
import { readManagedSection, spliceManagedSection } from '@cat-factory/kernel'

/**
 * Deterministic {@link PrVerificationReportPublisher} for the cross-runtime conformance
 * suite: an in-memory stand-in for a PR description per block.
 *
 * It runs the REAL {@link spliceManagedSection} the `@cat-factory/server`
 * `GitHubPrReportPublisher` uses, so a suite assertion covers the whole contract — the
 * composed report AND its in-place idempotency (a retry rewrites the marked region instead
 * of appending a second report) — without a VCS connection on either facade.
 */
export class FakePrReportPublisher implements PrVerificationReportPublisher {
  /** The current "PR body" per block id. Seed one to simulate the coder's own description. */
  readonly bodies = new Map<string, string>()
  /** Every publish call, in order, for asserting how many remote writes were attempted. */
  readonly calls: { workspaceId: string; blockId: string; published: boolean }[] = []
  /**
   * Blocks with no resolvable PR. A block absent from this set resolves, so the common case
   * needs no seeding; add one to exercise the engine's "nowhere to publish" short-circuit.
   */
  readonly unresolvable = new Set<string>()

  async resolveTarget(_workspaceId: string, blockId: string): Promise<PrReportTarget | null> {
    if (this.unresolvable.has(blockId)) return null
    return { prNumber: 1, repo: 'acme/api', provider: 'github' }
  }

  async publish(
    workspaceId: string,
    blockId: string,
    section: string,
  ): Promise<PrReportPublishResult> {
    const current = this.bodies.get(blockId) ?? ''
    const next = spliceManagedSection(current, section)
    const published = next !== current
    if (published) this.bodies.set(blockId, next)
    this.calls.push({ workspaceId, blockId, published })
    return published ? { published: true, prNumber: 1 } : { published: false, skipped: 'unchanged' }
  }

  /** The engine-managed region of a block's PR body, or null when none was published. */
  section(blockId: string): string | null {
    return readManagedSection(this.bodies.get(blockId))
  }

  /**
   * The machine-readable payload out of a block's published report — the fenced JSON block
   * the section carries — parsed as `unknown` so the suite can run it through the contracts
   * schema itself. Null when no report (or no JSON fence) is present.
   */
  reportJson(blockId: string): unknown {
    const section = this.section(blockId)
    const match = section?.match(/```json\n([\s\S]*?)\n```/)
    return match ? JSON.parse(match[1]!) : null
  }
}
