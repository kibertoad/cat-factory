import type { AgentExecutor, AgentRunContext, AgentRunResult, Block } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { documentsDeps, makeApp } from '../helpers'
import { FakeDocumentSourceProvider } from '../fakes/FakeDocumentSourceProvider'

// Spec-sized input on `/api/v1`. Before this a headless caller had `description` (2,000 chars, a
// task's own framing) and the `POST /jobs` brief (50,000 chars, inline pipelines that never touch
// a repository), so there was no way to put a PRD in front of a run that opens a pull request.
// `POST /services/:serviceId/tasks` now takes the documents too, either by naming a page in a
// connected source or by carrying the text.
//
// The assertion that matters is not the `201`: it is that the text reaches the AGENT. Everything
// else here is the ordering, which is the same one the ticket linkage established: refuse before
// the board changes, and take the task back off it if an attachment does not land.

/** Captures every context the engine hands it, so we can assert what agents actually see. */
class RecordingAgentExecutor implements AgentExecutor {
  readonly contexts: AgentRunContext[] = []
  async run(context: AgentRunContext): Promise<AgentRunResult> {
    this.contexts.push(context)
    return { output: 'ok', model: 'recording', confidence: context.isFinalStep ? 1 : undefined }
  }
}

interface PublicTask {
  taskId: string
  title: string
  description: string | null
}

interface StoredDocument {
  source: string
  externalId: string
  title: string
  url: string
  linkedBlockId: string | null
}

const PRD = [
  '# Checkout PRD',
  '',
  '## Goal',
  'Support split payments across two cards.',
  '',
  '## Out of scope',
  'Refund flows stay unchanged.',
].join('\n')

/** An org workspace with a connected fake Confluence, a public-API key, and an empty service. */
async function setup() {
  const confluence = new FakeDocumentSourceProvider('confluence', {
    'PAGE-1': { title: 'Payments RFC', body: 'Settle each card leg independently.' },
  })
  const recorder = new RecordingAgentExecutor()
  const app = makeApp(recorder, documentsDeps({ providers: [confluence] }))
  const workspaceId = (await app.createOrgWorkspace({ seed: true })).workspace.id
  const key = await app.call<{ secret: string }>(
    'POST',
    `/workspaces/${workspaceId}/public-api-keys`,
    { label: 'external system' },
  )
  expect(key.status).toBe(201)
  const auth = { authorization: `Bearer ${key.body.secret}` }
  await app.call('POST', `/workspaces/${workspaceId}/document-sources/confluence/connect`, {
    credentials: {
      baseUrl: 'https://acme.atlassian.net',
      accountEmail: 'dev@acme.io',
      apiToken: 't',
    },
  })
  const frame = await app.call<Block>('POST', `/workspaces/${workspaceId}/blocks`, {
    type: 'service',
    position: { x: 120, y: 120 },
  })
  return { app, auth, workspaceId, serviceId: frame.body.id, confluence, recorder }
}

/** The workspace's projected documents and what each is attached to, per the session surface. */
async function storedDocuments(
  app: Awaited<ReturnType<typeof setup>>['app'],
  workspaceId: string,
): Promise<StoredDocument[]> {
  const res = await app.call<StoredDocument[]>('GET', `/workspaces/${workspaceId}/documents`)
  expect(res.status).toBe(200)
  return res.body.map(({ source, externalId, title, url, linkedBlockId }) => ({
    source,
    externalId,
    title,
    url,
    linkedBlockId,
  }))
}

describe('public API: creating a task WITH requirements documents', () => {
  it('puts an uploaded spec in front of the agent that runs the task', async () => {
    const { app, auth, workspaceId, serviceId, recorder } = await setup()

    const created = await app.call<PublicTask>(
      'POST',
      `/api/v1/services/${serviceId}/tasks`,
      {
        title: 'Split payments at checkout',
        description: 'From the payments squad.',
        documents: [{ kind: 'upload', title: 'Checkout PRD', content: PRD }],
      },
      auth,
    )
    expect(created.status).toBe(201)
    // The description stays the CALLER's framing: the spec is attached, never folded into a field
    // that would truncate it.
    expect(created.body.description).toBe('From the payments squad.')

    // Stored as an `upload`-origin document, attached to the new task, and carrying no source URL
    // (there is no page behind it, and a fabricated link would send a human chasing nothing).
    const documents = await storedDocuments(app, workspaceId)
    expect(documents).toEqual([
      expect.objectContaining({
        source: 'upload',
        title: 'Checkout PRD',
        url: '',
        linkedBlockId: created.body.taskId,
      }),
    ])

    // The point of the whole feature: run the task and prove the agent received the text WHOLE,
    // not an excerpt of it.
    const pipeline = await app.call<{ id: string }>(
      'POST',
      `/workspaces/${workspaceId}/pipelines`,
      {
        name: 'Build',
        agentKinds: ['coder'],
      },
    )
    const started = await app.call(
      'POST',
      `/api/v1/tasks/${created.body.taskId}/start`,
      { pipelineId: pipeline.body.id },
      auth,
    )
    expect(started.status).toBe(202)
    await app.drive(workspaceId)

    const context = recorder.contexts.find((c) => c.block.title === 'Split payments at checkout')
    expect(context?.block.contextDocs).toEqual([
      expect.objectContaining({ title: 'Checkout PRD', url: '', body: PRD }),
    ])
  })

  it('imports a named page from a connected source and attaches it, in the order given', async () => {
    const { app, auth, workspaceId, serviceId, confluence } = await setup()

    const created = await app.call<PublicTask>(
      'POST',
      `/api/v1/services/${serviceId}/tasks`,
      {
        title: 'Split payments at checkout',
        documents: [
          { kind: 'source', source: 'confluence', ref: 'PAGE-1' },
          { kind: 'upload', title: 'Checkout PRD', content: PRD },
        ],
      },
      auth,
    )
    expect(created.status).toBe(201)

    // The page was fetched through the workspace's stored connection, exactly as the app's own
    // import does. The caller supplies a ref, never credentials.
    expect(confluence.calls.map((c) => c.externalId)).toEqual(['PAGE-1'])
    const documents = await storedDocuments(app, workspaceId)
    expect(documents.map((d) => d.source).sort()).toEqual(['confluence', 'upload'])
    expect(documents.every((d) => d.linkedBlockId === created.body.taskId)).toBe(true)
  })

  it('leaves the board AND the workspace untouched when a named page cannot be resolved', async () => {
    const { app, auth, workspaceId, serviceId } = await setup()

    // `notion` is a grammatically valid source this workspace has not connected. The refusal has
    // to land BEFORE the block is created: the other order hands back a `201` for a task the
    // caller believes carries its spec, running on its title alone with no error to react to.
    const refused = await app.call(
      'POST',
      `/api/v1/services/${serviceId}/tasks`,
      {
        title: 'Split payments at checkout',
        documents: [
          { kind: 'upload', title: 'Checkout PRD', content: PRD },
          { kind: 'source', source: 'notion', ref: 'PAGE-9' },
        ],
      },
      auth,
    )
    expect(refused.status).toBe(422)

    const list = await app.call<{ tasks: PublicTask[] }>(
      'GET',
      `/api/v1/services/${serviceId}/tasks`,
      undefined,
      auth,
    )
    expect(list.body.tasks).toEqual([])
    // And the upload LISTED FIRST left nothing behind. Uploads are written only once the whole
    // list has resolved, precisely because each one mints a fresh id: written eagerly, an
    // integration retrying this call in a loop would fill the workspace with unreachable copies
    // of the same spec (an import, keyed by its ref, would simply land on the same row).
    expect(await storedDocuments(app, workspaceId)).toEqual([])
  })

  it('refuses to steal a page a live task already holds, naming that task', async () => {
    const { app, auth, workspaceId, serviceId } = await setup()

    const first = await app.call<PublicTask>(
      'POST',
      `/api/v1/services/${serviceId}/tasks`,
      {
        title: 'First',
        documents: [{ kind: 'source', source: 'confluence', ref: 'PAGE-1' }],
      },
      auth,
    )
    expect(first.status).toBe(201)

    // A document row holds ONE `linkedBlockId`, so attaching the same page again would MOVE the
    // link: the first task would silently lose the spec it was created with, and its run would
    // report nothing. The refusal names the holder, exactly as a re-filed ticket's does.
    const second = await app.call(
      'POST',
      `/api/v1/services/${serviceId}/tasks`,
      {
        title: 'Second',
        documents: [{ kind: 'source', source: 'confluence', ref: 'PAGE-1' }],
      },
      auth,
    )
    expect(second.status).toBe(409)
    expect(second.body).toMatchObject({
      error: { details: { reason: 'document_already_linked', taskId: first.body.taskId } },
    })

    // And the first task kept it.
    const documents = await storedDocuments(app, workspaceId)
    expect(documents).toEqual([
      expect.objectContaining({ externalId: 'PAGE-1', linkedBlockId: first.body.taskId }),
    ])
  })

  it('refuses an upload with no readable text', async () => {
    const { app, auth, serviceId } = await setup()

    // An empty fenced block: bytes, but nothing at all once rendered to text. Refused at the
    // boundary, where the caller still holds the bytes, rather than left to the inline readers
    // that would find it blank mid-run (a container agent would open the file and see nothing
    // useful, without the platform ever calling it unreadable).
    const refused = await app.call(
      'POST',
      `/api/v1/services/${serviceId}/tasks`,
      {
        title: 'Split payments at checkout',
        documents: [{ kind: 'upload', title: 'Checkout PRD', content: '```\n\n```' }],
      },
      auth,
    )
    expect(refused.status).toBe(422)
  })

  it('refuses an unknown service WITHOUT fetching anything', async () => {
    const { app, auth, confluence } = await setup()

    // Resolving a source document is an outbound call to the workspace's own wiki, so the
    // deterministic half of the create's validation runs in front of it.
    const refused = await app.call(
      'POST',
      '/api/v1/services/blk_nonexistent/tasks',
      {
        title: 'Split payments at checkout',
        documents: [{ kind: 'source', source: 'confluence', ref: 'PAGE-1' }],
      },
      auth,
    )
    expect(refused.status).toBe(404)
    expect(confluence.calls).toEqual([])
  })
})
