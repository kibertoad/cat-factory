import { type ProjectKindDescriptor, parseProjectKindDescriptor } from '@cat-factory/contracts'
import type { ProjectKindSource } from '@cat-factory/kernel'
import { UnavailableError, describeError } from '@cat-factory/kernel'

/**
 * A {@link ProjectKindSource} backed by the mothership's `GET /internal/project-kinds`, presenting
 * the node's machine token. A failed or unreadable read THROWS rather than answering with no
 * kinds: "the mothership is unreachable" and "this deployment registers no project kinds" are the
 * same value and opposite facts. No cache, for the reason its prompt-fragment sibling gives: a
 * process-lifetime copy would have no invalidation path.
 */
export class HttpProjectKindSource implements ProjectKindSource {
  constructor(
    private readonly opts: {
      baseUrl: string
      token: string | (() => string | null)
      fetchImpl?: typeof fetch
    },
  ) {}

  async all(): Promise<ProjectKindDescriptor[]> {
    return this.read()
  }

  async get(id: string): Promise<ProjectKindDescriptor | undefined> {
    return (await this.read()).find((kind) => kind.id === id)
  }

  private async read(): Promise<ProjectKindDescriptor[]> {
    const fetchImpl = this.opts.fetchImpl ?? fetch
    const token = typeof this.opts.token === 'function' ? this.opts.token() : this.opts.token
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/internal/project-kinds`
    let res: Response
    try {
      res = await fetchImpl(url, { headers: { authorization: `Bearer ${token ?? ''}` } })
    } catch (error) {
      throw new UnavailableError(
        'The project kinds could not be read from the mothership',
        'project_kinds_unreachable',
        describeError(error),
      )
    }
    if (!res.ok) {
      throw new UnavailableError(
        'The mothership refused the project kinds read',
        'project_kinds_unreachable',
        { status: res.status },
      )
    }
    const body = (await res.json().catch(() => null)) as { kinds?: unknown } | null
    if (!body || !Array.isArray(body.kinds)) throw unreadable()
    const kinds: ProjectKindDescriptor[] = []
    for (const raw of body.kinds) {
      const parsed = parseProjectKindDescriptor(raw)
      if (!parsed.ok) throw unreadable()
      kinds.push(parsed.kind)
    }
    return kinds
  }
}

function unreadable(): UnavailableError {
  return new UnavailableError(
    'The mothership returned unreadable project kinds',
    'project_kinds_unreachable',
  )
}
