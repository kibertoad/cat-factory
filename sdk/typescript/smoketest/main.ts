// The TypeScript SDK's smoketest program.
//
// One of four programs — one per SDK — that drive the SAME scenario against a live deployment and
// write the SAME observation report. The harness (`backend/internal/sdk-smoketest`) boots a real
// backend, runs all four, and then compares their reports field by field.
//
// That comparison is the point. A per-SDK test can only assert that ITS OWN client agrees with
// what its author expected; four reports compared against each other catch the class of bug this
// SDK family is most exposed to — one language decoding a field differently, mapping an error to
// the wrong class, dropping a null, or paginating one page short — because those show up as a
// DISAGREEMENT even when nobody wrote down what the right answer was.
//
// So the rule for this file: OBSERVE and RECORD, do not assert. An assertion here would fail one
// SDK in isolation; a recorded observation is comparable across four.

import { writeFileSync } from 'node:fs'
import {
  CatFactoryClient,
  CatFactoryForbiddenError,
  CatFactoryNotFoundError,
  CatFactoryUnauthorizedError,
  SDK_VERSION,
} from '../src/index.ts'

const baseUrl = requireEnv('CAT_FACTORY_BASE_URL')
const apiKey = requireEnv('CAT_FACTORY_API_KEY')
const readOnlyKey = requireEnv('CAT_FACTORY_READ_KEY')
const outPath = requireEnv('CAT_FACTORY_SMOKETEST_OUT')

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`smoketest: ${name} is required`)
  return value
}

const observations: Record<string, unknown> = {}
const failures: string[] = []

/** Run one scenario step, recording a failure rather than aborting the rest of the run. */
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const client = new CatFactoryClient({ baseUrl, apiKey, userAgent: 'cat-factory-smoketest' })
const readClient = new CatFactoryClient({ baseUrl, apiKey: readOnlyKey })

let serviceId = ''
let taskId = ''
let pipelineId = ''

await step('services.list', async () => {
  const result = await client.services.list()
  observations.serviceCount = result.services.length
  serviceId = result.services[0]?.serviceId ?? ''
  observations.firstServiceHasId = serviceId.length > 0
})

await step('pipelines.list', async () => {
  const result = await client.pipelines.list()
  observations.pipelineCount = result.pipelines.length
  const startable = result.pipelines.filter((p) => p.headlessStartable)
  observations.headlessStartableCount = startable.length
  // `public` is a keyword in Java and Kotlin; reading it here keeps the four SDKs comparable on
  // the field whose NAME differs between them (`isPublic()` on the JVM).
  observations.publicPipelineCount = result.pipelines.filter((p) => p.public).length
  pipelineId = startable[0]?.pipelineId ?? ''
})

await step('taskTypes.list', async () => {
  const result = await client.taskTypes.list()
  observations.taskTypeCount = result.taskTypes.length
  // The `bug` descriptors, which every deployment has: the count plus one field's declared type,
  // so four SDKs comparing reports catch one of them dropping the nested option list or decoding
  // an optional `type` differently.
  const bug = result.taskTypes.find((t) => t.taskType === 'bug')
  observations.bugFieldCount = bug?.fields.length ?? 0
  observations.bugSeverityFieldType = bug?.fields.find((f) => f.key === 'severity')?.type ?? ''
  observations.bugSeverityOptionCount =
    bug?.fields.find((f) => f.key === 'severity')?.options?.length ?? 0
})

await step('tasks.create', async () => {
  const task = await client.tasks.create(serviceId, {
    title: 'SDK smoketest task',
    description: 'Created by the cross-SDK smoketest.',
    taskType: 'feature',
  })
  taskId = task.taskId
  observations.createdStatus = task.status
  observations.createdTaskType = task.taskType
  // A required-but-NULLABLE field: the server always sends it, and it is null here. Recording it
  // as an explicit `null` (not `undefined`) is what proves the four SDKs agree that "the server
  // said null" and "the server said nothing" are different facts.
  observations.createdRunIdIsNull = task.runId === null
  observations.createdPullRequestUrlIsNull = task.pullRequestUrl === null
})

await step('tasks.update', async () => {
  const task = await client.tasks.update(taskId, { title: 'SDK smoketest task (edited)' })
  observations.updatedTitle = task.title
})

await step('tasks.get', async () => {
  const task = await client.tasks.get(taskId)
  observations.fetchedTitle = task.title
  observations.fetchedStatus = task.status
})

await step('tasks.listByService (one page)', async () => {
  const page = await client.tasks.listByService(serviceId, { limit: 1 })
  observations.pageSize = page.tasks.length
  observations.pageHasCursor = page.nextCursor !== null
})

await step('tasks.listByServiceAll (auto-paging)', async () => {
  const seen: string[] = []
  for await (const task of client.tasks.listByServiceAll(serviceId, { limit: 1 })) {
    seen.push(task.taskId)
  }
  observations.pagedTaskCount = seen.length
  observations.pagedContainsCreated = seen.includes(taskId)
  // A duplicate would mean the cursor was not advancing — the classic keyset paging bug, and one
  // a single-page test never sees.
  observations.pagedHasDuplicates = new Set(seen).size !== seen.length
})

await step('usage.get', async () => {
  const usage = await client.usage.get()
  observations.usageCurrency = usage.currency
  observations.usageBudgetExceeded = usage.budget.exceeded
  observations.usageRowsIsArray = Array.isArray(usage.rows)
})

await step('notifications.list', async () => {
  const result = await client.notifications.list()
  observations.notificationCount = result.notifications.length
})

// The webhook round-trip is where the four clients are most exposed to a null decoding
// differently: an unregistered endpoint is a `webhook: null` FIELD, and "the server said null"
// must not arrive as an absence, an empty object, or a zero-valued struct in any language.
await step('webhook.get / set / delete', async () => {
  const before = await client.webhook.get()
  observations.webhookInitiallyNull = before.webhook === null
  const saved = await client.webhook.set({
    url: 'https://hooks.example.com/cat-factory-smoketest',
    secret: 'smoketest-signing-secret',
    runEvents: ['run.completed'],
  })
  observations.webhookSavedUrl = saved.url
  // The secret is write-only: what comes back is the boolean, never the value.
  observations.webhookSavedHasSecret = saved.hasSecret
  observations.webhookSavedRunEvents = saved.runEvents.join(',')
  // Omitting a field must send NO field, not an empty one: a `url: ""` here would blank the
  // endpoint on a call that only meant to add an alert subscription, and still answer 200.
  const edited = await client.webhook.set({ alertEvents: ['platform_health.firing'] })
  observations.webhookUrlSurvivesOmittedUpdate = edited.url === saved.url
  const read = await client.webhook.get()
  observations.webhookReadMatchesSaved = read.webhook?.url === saved.url
  await client.webhook.delete()
  const after = await client.webhook.get()
  observations.webhookNullAfterDelete = after.webhook === null
})

await step('error: not found', async () => {
  try {
    await client.tasks.get('blk_definitely_not_a_real_task')
    failures.push('error: not found — expected a 404, got a success')
  } catch (error) {
    observations.notFoundIsTypedClass = error instanceof CatFactoryNotFoundError
    if (error instanceof CatFactoryNotFoundError) {
      observations.notFoundStatus = error.status
      observations.notFoundCode = error.code
      observations.notFoundHasRequestId = typeof error.requestId === 'string'
    }
  }
})

await step('error: unauthorized', async () => {
  const bogus = new CatFactoryClient({ baseUrl, apiKey: 'cf_live_pak_0000.deadbeef' })
  try {
    await bogus.services.list()
    failures.push('error: unauthorized — expected a 401, got a success')
  } catch (error) {
    observations.unauthorizedIsTypedClass = error instanceof CatFactoryUnauthorizedError
    if (error instanceof CatFactoryUnauthorizedError) {
      observations.unauthorizedStatus = error.status
    }
  }
})

await step('error: insufficient scope', async () => {
  try {
    // A `read` key may list, but never create. The refusal carries a SURFACE-specific code
    // (`insufficient_scope`) rather than a status-class one, which is exactly the case the SDKs
    // deliberately do not narrow to an enum — so all four must surface it verbatim.
    await readClient.tasks.create(serviceId, { title: 'should be refused' })
    failures.push('error: insufficient scope — expected a 403, got a success')
  } catch (error) {
    observations.forbiddenIsTypedClass = error instanceof CatFactoryForbiddenError
    if (error instanceof CatFactoryForbiddenError) {
      observations.forbiddenStatus = error.status
      observations.forbiddenCode = error.code
    }
  }
})

await step('tasks.start', async () => {
  const task = await client.tasks.start(taskId, pipelineId ? { pipelineId } : {})
  observations.startedStatus = task.status
  observations.startedHasRunId = task.runId !== null
})

await step('tasks.stream (SSE)', async () => {
  const stream = await client.tasks.stream(taskId)
  const events: string[] = []
  try {
    for await (const event of stream) {
      events.push(event.event)
      // The run's own terminal frames, plus the deployment's connection cap. Stopping at a fixed
      // count as well keeps the smoketest bounded when a run parks on a human decision — which
      // is a legitimate outcome, not a failure.
      if (event.event === 'done' || event.event === 'error' || event.event === 'timeout') break
      if (events.length >= 3) break
    }
  } finally {
    await stream.close()
  }
  observations.sseEventCount = events.length
  observations.sseFirstEvent = events[0] ?? null
  observations.sseFramesAreKnown = events.every((name) =>
    ['progress', 'done', 'error', 'decision', 'timeout'].includes(name),
  )
})

await step('tasks.getRun', async () => {
  const run = await client.tasks.getRun(taskId)
  observations.runHasSteps = run.steps.length > 0
  observations.runStatusIsKnown = ['running', 'blocked', 'paused', 'done', 'failed'].includes(
    run.status,
  )
})

await step('tasks.stop', async () => {
  const task = await client.tasks.stop(taskId)
  observations.stoppedStatus = task.status
})

await step('tasks.delete', async () => {
  await client.tasks.delete(taskId)
  try {
    await client.tasks.get(taskId)
    failures.push('tasks.delete — the task was still readable after deletion')
    observations.deletedThenGone = false
  } catch (error) {
    observations.deletedThenGone = error instanceof CatFactoryNotFoundError
  }
})

writeFileSync(
  outPath,
  `${JSON.stringify({ sdk: 'typescript', sdkVersion: SDK_VERSION, observations, failures }, null, 2)}\n`,
)

if (failures.length > 0) {
  console.error(`typescript smoketest recorded ${failures.length} failure(s):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('typescript smoketest completed')
