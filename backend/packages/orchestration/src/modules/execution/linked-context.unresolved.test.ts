import type { DocumentRecord, DocumentRepository, TaskRecord } from '@cat-factory/kernel'
import {
  CONTEXT_DOCUMENT_UNREADABLE,
  createRecordingLogger,
  ValidationError,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { linkedContextSourcesFrom, resolveLinkedContext } from './linked-context.js'

// The "break loudly, never skip" half of linked-context resolution: a referenced context document
// the platform cannot put in front of the agent fails the run naming it, while an ambiguous prose
// URL (which a host-blind `parseRef` will happily claim) stays best-effort and is only logged.

function record(over: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    workspaceId: 'ws1',
    source: 'notion',
    externalId: '4242',
    title: 'Rate Limiter RFC',
    url: 'https://notion.so/Rate-Limiter-RFC-4242',
    excerpt: 'Token bucket.',
    body: '# Rate limiter\n\nToken bucket, 100 rps.',
    contentHash: 'h',
    sourceVersion: null,
    linkedBlockId: 'task_1',
    role: null,
    docKind: null,
    syncedAt: 0,
    deletedAt: null,
    ...over,
  }
}

/** A documents repo serving a fixed corpus through the three reads the resolver uses. */
function documentsRepo(corpus: DocumentRecord[]): DocumentRepository {
  const repo = {
    async listByBlock(_ws: string, blockId: string) {
      return corpus.filter((d) => d.linkedBlockId === blockId)
    },
    async get(_ws: string, source: string, externalId: string) {
      return corpus.find((d) => d.source === source && d.externalId === externalId) ?? null
    },
    async getByUrl(_ws: string, url: string) {
      return corpus.find((d) => d.url === url) ?? null
    },
  }
  return repo as unknown as DocumentRepository
}

/** The notion-shaped canonicaliser the real deployment builds from its registered providers. */
const notionProvider = {
  kind: 'notion' as const,
  parseRef: (url: string) => (/4242/.test(url) ? '4242' : null),
}

describe('resolveLinkedContext: unresolvable references', () => {
  it('refuses the run when an attached document has no readable content, naming it', async () => {
    const sources = linkedContextSourcesFrom({
      documentRepository: documentsRepo([record({ body: '   ', excerpt: '' })]),
    })
    await expect(
      resolveLinkedContext(sources, 'ws1', 'task_1', 'Implement the limiter.', {
        includeLinked: true,
      }),
    ).rejects.toThrow(/"Rate Limiter RFC"/)
  })

  it('carries a machine-readable reason so the run records the cause, not just the prose', async () => {
    const sources = linkedContextSourcesFrom({
      documentRepository: documentsRepo([record({ body: '', excerpt: '' })]),
    })
    const error = await resolveLinkedContext(sources, 'ws1', 'task_1', '', {
      includeLinked: true,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as ValidationError).details?.reason).toBe(CONTEXT_DOCUMENT_UNREADABLE)
  })

  it('accepts a document whose body is empty but whose excerpt still reads', async () => {
    const sources = linkedContextSourcesFrom({
      documentRepository: documentsRepo([record({ body: '', excerpt: 'Token bucket.' })]),
    })
    const { docs } = await resolveLinkedContext(sources, 'ws1', 'task_1', '', {
      includeLinked: true,
    })
    expect(docs.map((d) => d.title)).toEqual(['Rate Limiter RFC'])
  })

  it('applies the same rule to a document the DESCRIPTION names, not only an attachment', async () => {
    const sources = linkedContextSourcesFrom({
      documentRepository: documentsRepo([record({ linkedBlockId: null, body: '', excerpt: '' })]),
      documentSourceProviders: [notionProvider],
    })
    await expect(
      resolveLinkedContext(
        sources,
        'ws1',
        'task_1',
        'Per https://notion.so/Rate-Limiter-RFC-4242 the limit is per tenant.',
        { includeLinked: true },
      ),
    ).rejects.toThrow(/no readable content/)
  })

  it('logs — never fails — a claimed URL that matches nothing imported', async () => {
    // `parseNotionRef`-style claims are host-blind, so a dashboard link carrying a UUID would
    // otherwise block the run. The drop stays; the log is what keeps it from being silent.
    // At INFO, not `warn`: this is a normal, permanent state of a healthy task and it re-resolves
    // on every dispatch, so a warning would repeat forever with no remedy anyone means to apply.
    const logger = createRecordingLogger()
    const sources = linkedContextSourcesFrom({
      documentRepository: documentsRepo([]),
      documentSourceProviders: [notionProvider],
      logger,
    })
    const { docs } = await resolveLinkedContext(
      sources,
      'ws1',
      'task_1',
      'See https://grafana.example/d/4242 for the current numbers.',
      { includeLinked: true },
    )
    expect(docs).toEqual([])
    expect(
      logger.lines.some(
        (l) => l.level === 'info' && l.fields?.url === 'https://grafana.example/d/4242',
      ),
    ).toBe(true)
    expect(logger.lines.some((l) => l.level === 'warn')).toBe(false)
  })

  it('is a no-op for an unwired documents integration', async () => {
    const { docs, tasks } = await resolveLinkedContext(
      linkedContextSourcesFrom({}),
      'ws1',
      'task_1',
      'Per https://notion.so/Rate-Limiter-RFC-4242 and PROJ-12.',
      { includeLinked: true },
    )
    expect(docs).toEqual([])
    expect(tasks).toEqual([] as TaskRecord[])
  })
})
