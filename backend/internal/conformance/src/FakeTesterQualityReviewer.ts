import type { Block, TestReport } from '@cat-factory/kernel'
import type { TesterQualityOutcome, TesterQualityReviewer } from '@cat-factory/orchestration'

/**
 * A deterministic test quality-control reviewer for the conformance suite. It returns a
 * scripted SEQUENCE of verdicts (one per successive Tester report), so a test can drive the
 * full QC loop — e.g. an "inadequate coverage" verdict that loops the Tester, then an
 * "adequate" one that lets the run advance — without a real model. The last entry repeats once
 * the sequence is exhausted, and `evaluate` records every call so a test can assert how many
 * reports were audited.
 *
 * A `null` entry in the sequence models a pass-through (no model resolved) — the gate proceeds
 * exactly as if the reviewer were unwired for that report.
 */
export class FakeTesterQualityReviewer implements TesterQualityReviewer {
  /** One entry per `evaluate` call so a test can inspect what each report was audited as. */
  readonly calls: { blockId: string; adequate: boolean | null }[] = []

  constructor(
    private readonly verdicts: (TesterQualityOutcome | null)[],
    private readonly model: string | null = 'fake-qc-model',
  ) {}

  async evaluate(
    _workspaceId: string,
    block: Block,
    _report: TestReport,
  ): Promise<{ outcome: TesterQualityOutcome; model: string | null } | null> {
    const i = Math.min(this.calls.length, this.verdicts.length - 1)
    const verdict = this.verdicts[i] ?? null
    this.calls.push({ blockId: block.id, adequate: verdict ? verdict.adequate : null })
    if (!verdict) return null
    return { outcome: verdict, model: this.model }
  }
}
