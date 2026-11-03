import type {
  WritebackPostKey,
  WritebackPostRecord,
  WritebackPostRepository,
} from '@cat-factory/kernel'

/**
 * An in-memory {@link WritebackPostRepository} with the claim contract both facades' repos hold
 * (`writeback-post-suite.ts` in `@cat-factory/conformance` pins those): `failed` re-claims, a
 * `pending` row is re-taken only past a non-null cutoff, and `posted` is terminal.
 */
export function memoryWritebackPosts(): WritebackPostRepository & {
  rows: Map<string, WritebackPostRecord>
} {
  const rows = new Map<string, WritebackPostRecord>()
  const id = (key: WritebackPostKey) =>
    [key.workspaceId, key.kind, key.subjectId, key.issueRef, key.discriminator].join('|')
  return {
    rows,
    async claim(key, window) {
      const existing = rows.get(id(key))
      const abandoned =
        existing?.status === 'pending' &&
        window.reclaimPendingBefore !== null &&
        existing.updatedAt <= window.reclaimPendingBefore
      if (existing && existing.status !== 'failed' && !abandoned) {
        return existing.status === 'posted' ? 'posted' : 'held'
      }
      rows.set(id(key), {
        ...key,
        status: 'pending',
        attempts: (existing?.attempts ?? 0) + 1,
        error: null,
        updatedAt: window.now,
      })
      return 'claimed'
    },
    async settle(key, outcome, now) {
      const existing = rows.get(id(key))
      if (!existing) return
      rows.set(id(key), {
        ...existing,
        status: outcome.status,
        error: outcome.status === 'failed' ? outcome.error : null,
        updatedAt: now,
      })
    },
    async get(key) {
      return rows.get(id(key)) ?? null
    },
  }
}
