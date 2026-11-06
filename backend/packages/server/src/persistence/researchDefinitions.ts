import { type ResearchDefinition, parseResearchDefinition } from '@cat-factory/contracts'
import type { RegisteredResearchDefinitionSource } from '@cat-factory/kernel'
import { UnavailableError, describeError } from '@cat-factory/kernel'

/**
 * A {@link RegisteredResearchDefinitionSource} backed by the mothership's
 * `GET /internal/research-definitions`, presenting the node's machine token. A failed or
 * unreadable read THROWS rather than answering with none: "the mothership is unreachable" and
 * "this deployment registers no definitions" are the same value and opposite facts. No cache, for
 * the reason its project-kind sibling gives.
 */
export class HttpRegisteredResearchDefinitionSource implements RegisteredResearchDefinitionSource {
  constructor(
    private readonly opts: {
      baseUrl: string
      token: string | (() => string | null)
      fetchImpl?: typeof fetch
    },
  ) {}

  async all(): Promise<ResearchDefinition[]> {
    const fetchImpl = this.opts.fetchImpl ?? fetch
    const token = typeof this.opts.token === 'function' ? this.opts.token() : this.opts.token
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/internal/research-definitions`
    let res: Response
    try {
      res = await fetchImpl(url, { headers: { authorization: `Bearer ${token ?? ''}` } })
    } catch (error) {
      throw new UnavailableError(
        'The research definitions could not be read from the mothership',
        'research_definitions_unreachable',
        describeError(error),
      )
    }
    if (!res.ok) {
      throw new UnavailableError(
        'The mothership refused the research definitions read',
        'research_definitions_unreachable',
        { status: res.status },
      )
    }
    const body = (await res.json().catch(() => null)) as { definitions?: unknown } | null
    if (!body || !Array.isArray(body.definitions)) throw unreadable()
    const definitions: ResearchDefinition[] = []
    for (const raw of body.definitions) {
      const parsed = parseResearchDefinition(raw)
      if (!parsed.ok) throw unreadable()
      definitions.push(parsed.definition)
    }
    return definitions
  }
}

function unreadable(): UnavailableError {
  return new UnavailableError(
    'The mothership returned unreadable research definitions',
    'research_definitions_unreachable',
  )
}
