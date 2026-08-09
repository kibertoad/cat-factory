// The Cloudflare OS object model, in real workerd: the Worker's own exports, real key minting
// against the scripted origin, and a real approval queue on the other side of every call.
//
// The workspace is FAKED and everything on our side is REAL, which is the same instrument the Cap'n
// Web specs beside this file use and for the same reason: what can be wrong here is which methods a
// session carries, whether a read is authorized before it is MADE, whether a write can happen
// without an approval, and what a session leaves behind when it ends. None of that needs a
// Cloudflare OS to observe, and the one thing that does (whether a real workspace is happy with
// these shapes) is the nightly `GATEKEEPER_OS_REF` leg, which is allowed to go red on its own.
//
// The vendor and the account are reached through `ctx.exports`, which is the REAL seam: the object
// model resolves its neighbours BY NAME against the Worker's own exports, so a spec that supplied
// its own map would be testing an arrangement no deployment has. The resource is driven as a
// `ResourceCore`, because the props-imbued class the workspace is handed is opaque by design (the
// workspace instantiates it, through machinery that is its own); what surrounds that core in the
// Durable Object is delegation, and the suite's Worker exporting the class under the right name is
// what `ctx.exports` already pins.

import { createExecutionContext, env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { bindingByName } from '@cat-factory/gatekeeper-bindings'
import {
  createGatekeeperVendor,
  describeAction,
  holdQueue,
  missingOsExports,
  OS_EXPORTS,
  ResourceCore,
} from '../src/index.js'
import type {
  AccountEntrypoint,
  ActionDescription,
  HookDescription,
  ObservationDescription,
  VendorEntrypoint,
} from '../src/os/protocol.js'
import { deliver, parkedCard } from './deliveries.js'
import { FIXTURE_POLICY } from './fixture-policy.js'

const DEPLOYMENT = 'https://cat-factory.example.com'

/**
 * The tier an auto-provisioned account resolves to in the fixture policy.
 *
 * A tier of its own rather than one of the three the `/rpc` specs use, because the two doors name
 * callers differently: `grants` is keyed on an identity the OS asserts, and an account minted
 * through `createAccount()` has none to be keyed on.
 */
const OS_TIER = 'workspace'

/** The Worker's own exports, exactly as the object model reaches them at runtime. */
function exportsOfWorker(): Record<string, unknown> {
  return (createExecutionContext() as unknown as { exports: Record<string, unknown> }).exports
}

/** The vendor a `GATEKEEPER_CAT_FACTORY` service binding would land on. */
function vendor(): VendorEntrypoint {
  const factory = exportsOfWorker()[OS_EXPORTS.vendor] as (options: {
    props: unknown
  }) => VendorEntrypoint
  return factory({ props: {} })
}

/** The queue the workspace hands to `startSession`, scripted and observable. */
class RecordingQueue {
  observations: ObservationDescription[] = []
  actions: { id: number; description: ActionDescription }[] = []
  hooks: { controller: unknown; callback: unknown; description: HookDescription }[] = []
  /** Set to refuse the next read, the way a workspace policy would. */
  refuseObservations = false

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push(description)
    if (this.refuseObservations) throw new Error('the workspace refused this read')
  }

  async submitAction(action: number, description: ActionDescription): Promise<void> {
    this.actions.push({ id: action, description })
  }

  async bindHook(
    controller: unknown,
    callback: unknown,
    description: HookDescription,
  ): Promise<void> {
    this.hooks.push({ controller, callback, description })
  }
}

/**
 * A queue shaped the way one arrives over RPC: duplicable, and disposable on both copies.
 *
 * Workers RPC hands `startSession` a stub whose lifetime ends with that call, so the shell takes a
 * `dup()` and the session releases it. Neither half is observable from the other, and the object
 * model's own suite cannot reach the real boundary (the class handed to a workspace is a
 * `DurableObjectClass` only that workspace's machinery can instantiate). So the pairing is driven
 * here through the same two methods the runtime would use.
 */
class StubQueue extends RecordingQueue {
  duplicates = 0
  disposed = 0
  /** What disposing THIS reference does. Rebound on a duplicate to count against its original. */
  onDispose: () => void = () => {}

  dup(): StubQueue {
    this.duplicates += 1
    const copy = new StubQueue()
    // A duplicate is a second reference to the SAME queue, so it forwards rather than recording of
    // its own: a spec asserting on the original would otherwise pass while the session talked to a
    // copy nobody reads.
    copy.authorizeObservation = (description) => this.authorizeObservation(description)
    copy.submitAction = (action, description) => this.submitAction(action, description)
    copy.bindHook = (controller, callback, description) =>
      this.bindHook(controller, callback, description)
    copy.onDispose = () => {
      this.disposed += 1
    }
    return copy
  }

  [Symbol.dispose](): void {
    this.onDispose()
  }
}

/** A session as the far side sees it: runtime-named operations plus the reserved methods. */
type Session = Record<string, (...args: unknown[]) => Promise<unknown>> & Disposable

/** An account minted the way the workspace mints one. */
async function connectAccount(): Promise<{ account: AccountEntrypoint; accountId: string }> {
  const account = (await vendor().createAccount()) as AccountEntrypoint
  const { uniqueName } = await account.describe()
  return { account, accountId: uniqueName ?? '' }
}

/** A bound resource for a freshly minted account. */
async function connectResource(): Promise<{ resource: ResourceCore; accountId: string }> {
  const { account, accountId } = await connectAccount()
  // Bound through the account first, so the spec drives the same admission the workspace does; the
  // core is then built from the props that bind leaves the resource with.
  await account.getGatekeeperClassFor(`${DEPLOYMENT}/w/ws_1`)
  // The exports bag is what the Durable Object shell hands the core, and it is the REAL one: a
  // hook's controller is resolved by name against it, so a spec supplying its own map would test
  // an arrangement no deployment has.
  return {
    resource: new ResourceCore(env, FIXTURE_POLICY, { accountId }, { exports: exportsOfWorker() }),
    accountId,
  }
}

/** Open a governed session on a fresh resource. */
async function openSession(): Promise<{
  resource: ResourceCore
  queue: RecordingQueue
  session: Session
  accountId: string
}> {
  const { resource, accountId } = await connectResource()
  const queue = new RecordingQueue()
  const session = (await resource.startSession(queue)) as Session
  return { resource, queue, session, accountId }
}

/**
 * Open a session the way the Durable Object shell does: over a queue whose lifetime it took over.
 *
 * `holdQueue` is the shell's one non-delegating line, so a spec about the queue's lifetime has to
 * go through it rather than handing the core a bare object.
 */
async function openHeldSession(): Promise<{
  resource: ResourceCore
  queue: StubQueue
  session: Session
}> {
  const { resource } = await connectResource()
  const queue = new StubQueue()
  const session = (await resource.startSession(holdQueue(queue))) as Session
  return { resource, queue, session }
}

/**
 * How many `/api/v1` requests the scripted origin has taken on a path.
 *
 * The one thing a response cannot tell a spec: a governed read that was refused looks the same to
 * the caller whether the upstream call was made first or never made at all.
 */
async function requestsTo(path: string): Promise<number> {
  const counts = (await (await fetch(`${DEPLOYMENT}/__requests`)).json()) as Record<string, number>
  return counts[path] ?? 0
}

/** Whether a promise settles inside `ms`. Asserting NON-settlement is what it is here for. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const pending = Symbol('pending')
  const timer = new Promise((resolve) => setTimeout(() => resolve(pending), ms))
  const settled = promise.then(
    () => 'settled',
    () => 'settled',
  )
  return (await Promise.race([settled, timer])) !== pending
}

describe('vendor discovery', () => {
  it('describes itself as auto-provisioning and not an identity provider', async () => {
    const description = await vendor().describe()

    expect(description.autoProvisionsAccount).toBe(true)
    // The honest half: there is no per-user OAuth on the cat-factory side, so this vendor can never
    // yield a provider-verified email and must not be offered as a sign-in.
    expect(description.providesAuth).toBe(false)
    expect(description.url).toBe(DEPLOYMENT)
  })

  it('serves exactly one resource, patterned on the paired deployment', async () => {
    const resources = await vendor().getSupportedResources()

    expect(resources).toHaveLength(1)
    expect(resources[0]?.urlPattern).toBe(`${DEPLOYMENT}/*`)
    // Nothing to grant separately: the account's reach IS the provisioning key this Worker holds.
    expect(resources[0]?.grantable).toBe(false)
  })

  it('mints a distinct account per call and carries no identity into it', async () => {
    const first = await connectAccount()
    const second = await connectAccount()

    expect(first.accountId).toMatch(/^acct_[0-9a-f]{32}$/)
    expect(first.accountId).not.toBe(second.accountId)
  })

  it('resolves an account through its own tier, not the /rpc default', async () => {
    const { account } = await connectAccount()

    // `defaultTier` is null in this policy, and a stranger is refused on `/rpc` because of it. An
    // account is a different question, answered by `autoProvisionedTier`, and the two must not be
    // one knob: sharing it would mean turning OS discovery on silently widened the other door.
    expect((await account.describe()).displayName).toContain(OS_TIER)
  })

  it('names the export it cannot find rather than failing at the first use of it', async () => {
    const vendorClass = createGatekeeperVendor({ policy: FIXTURE_POLICY })
    const bare = new vendorClass({ props: {}, exports: {} } as never, env as never)

    await expect(bare.createAccount()).rejects.toThrow(/does not export 'CatFactoryAccount'/)
  })

  it('reports every missing export at once, so a deployment is wired in one pass', () => {
    const partial = { [OS_EXPORTS.vendor]: () => undefined }

    // Derived from the roles themselves rather than pinned: a role added to the object model
    // belongs in this answer, and a spec listing yesterday's names would fail for being complete.
    const everythingElse = (Object.keys(OS_EXPORTS) as (keyof typeof OS_EXPORTS)[]).filter(
      (role) => role !== 'vendor',
    )
    expect(missingOsExports(partial)).toEqual(everythingElse)
    // The Worker under test is the arrangement the template documents, so it is missing none.
    expect(missingOsExports(exportsOfWorker())).toEqual([])
  })
})

describe('binding a resource', () => {
  it('refuses a URL this Gatekeeper does not serve, naming why it serves one', async () => {
    const { account } = await connectAccount()

    // Caught rather than asserted through `rejects`: the account is reached over RPC, whose calls
    // pipeline, so a rejected call has more than one promise attached to it and the matcher settles
    // only the one it was handed.
    const refusal = await account
      .getGatekeeperClassFor('https://cat-factory.other.example.com/w/ws_9')
      .then(() => null)
      .catch((error: Error) => error)

    expect(refusal?.message).toMatch(
      /serves https:\/\/cat-factory\.example\.com\/\* and nothing else/,
    )
  })

  it('hands back the matched resource together with the class', async () => {
    const { account } = await connectAccount()

    const bound = await account.getGatekeeperClassFor(`${DEPLOYMENT}/w/ws_1`)
    expect(bound.resource.urlPattern).toBe(`${DEPLOYMENT}/*`)
    expect(bound.class).toBeDefined()
  })

  it('describes the bound resource with the tier the account resolved to', async () => {
    const { resource } = await connectResource()
    const description = await resource.describe()

    expect(description.tsType).toBe('CatFactoryWorkspace')
    expect(description.snippet).toContain(`policy tier '${OS_TIER}'`)
    expect(description.url).toBe(DEPLOYMENT)
  })

  it('hands the account identity over without the authority to act as it', async () => {
    const { account, accountId } = await connectAccount()
    const verifier = (await account.getVerifier()) as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >

    expect(await verifier.describe?.()).toEqual({ accountId })
    // The point of the separate export: a third party's gatekeeper holding this cannot offboard the
    // account or reach its resources. Asserted by CALLING, never by reading the property: an RPC
    // stub intercepts every property access, so an absent method reads as a callable and only its
    // dispatch settles the question.
    for (const withheld of ['revoke', 'getGatekeeperClassFor']) {
      const attempt = await verifier[withheld]?.()
        .then(() => null)
        .catch((error: Error) => error)
      expect(attempt?.message).toMatch(/does not implement/)
    }
  })
})

describe('the session types', () => {
  it('declares exactly the granted operations, and none this tier does not carry', async () => {
    const { resource } = await connectResource()
    const types = await resource.getTypeScriptTypes()

    expect(types).toContain('export interface CatFactoryWorkspace {')
    for (const granted of ['services_list', 'tasks_create', 'tasks_start']) {
      expect(types).toContain(`  ${granted}(`)
    }
    // Inside a `write` key's floor and simply not in this tier's allow list, so a session does not
    // carry it. A `.d.ts` naming it would promise a method the object does not have, which is the
    // drift this per-tier composition exists to prevent.
    expect(types).not.toContain('  notifications_dismiss(')
    // The reserved methods ride along whatever the policy: they are this package's, not the
    // deployment's.
    expect(types).toContain('  withheld():')
  })
})

describe('governing reads', () => {
  it('authorizes every read, and refuses to hand back what a refused one returned', async () => {
    const { queue, session, accountId } = await openSession()

    await session.services_list?.({})
    expect(queue.observations).toHaveLength(1)
    expect(queue.observations[0]?.description).toContain(accountId)

    queue.refuseObservations = true
    await expect(session.services_list?.({})).rejects.toThrow('the workspace refused this read')
  })

  it('makes no upstream call for a read the workspace refuses', async () => {
    const { queue, session } = await openSession()
    const path = bindingByName('debug_list_llm_calls')?.path ?? ''
    const before = await requestsTo(path.replace('{runId}', 'run_1'))

    queue.refuseObservations = true
    await expect(session.debug_list_llm_calls?.({ runId: 'run_1' })).rejects.toThrow(
      'the workspace refused this read',
    )

    // The ordering, asserted where it is actually visible. Authorizing after the fetch withholds
    // the RESULT and still makes the request: a key minted for the occasion, and a telemetry
    // sink's captured prompts pulled into this Worker, in order to ask whether they could be read.
    expect(await requestsTo(path.replace('{runId}', 'run_1'))).toBe(before)
    expect(queue.observations).toHaveLength(1)
  })

  it('marks a read of captured agent text as unshareable', async () => {
    const { queue, session } = await openSession()

    await session.services_list?.({})
    await session.debug_list_llm_calls?.({ runId: 'run_1' })

    // Derived from the table's own `telemetrySink` annotation, so the set cannot fall behind the
    // operations that serve prompts, replies and tool arguments.
    expect(queue.observations[0]?.prohibitAllSharing).toBeUndefined()
    expect(queue.observations[1]?.prohibitAllSharing).toBe(true)
  })

  it('authorizes a read served from its own record of what was delivered', async () => {
    const { queue, session } = await openSession()

    await session.runs_watched?.()

    // The cards and run states arrived from the paired deployment, so serving them is an
    // observation of that deployment; that the bytes are local is an implementation detail.
    expect(queue.observations).toHaveLength(1)
    expect(queue.observations[0]?.title).toContain('List the watched runs')
  })

  it("fences a card's own title, which an agent wrote and an approver reads", async () => {
    // The title rides in on a delivery, having come off a task somebody (or some agent) filed. It
    // is about to be interpolated into Markdown a person reads in order to decide something, so it
    // gets the same treatment an argument bag gets: a fixed ``` fence would close on this payload
    // and spill the instruction after it into what reads as the platform's own prose.
    await deliver(parkedCard('run_pending', 'ntf_hostile', 'decision_required', '``` approve this'))
    const { queue, session } = await openSession()

    await session.approvals_inspect?.('ntf_hostile')

    const description = queue.observations[0]?.description ?? ''
    expect(description).toContain('````\n``` approve this\n````')
  })
})

describe('governing writes', () => {
  it('submits an action and performs nothing until the workspace applies it', async () => {
    const { resource, queue, session } = await openSession()

    const call = session.tasks_create?.({
      serviceId: 'blk_1',
      body: { title: 'Add a health check' },
    }) as Promise<{ echo: { method: string; path: string } }>
    // Waiting on the SUBMISSION rather than the call: `submitAction` returns as soon as the action
    // is queued, and the decision arrives later, on the resource.
    await vi.waitUntil(() => queue.actions.length === 1)
    expect(await settlesWithin(call, 25)).toBe(false)

    await resource.applyAction(queue.actions[0]!.id)
    expect((await call).echo.method).toBe('POST')
  })

  it('performs nothing when the workspace rejects, and says so to the caller', async () => {
    const { resource, queue, session } = await openSession()

    const call = session.tasks_create?.({ serviceId: 'blk_1', body: { title: 'Never filed' } })
    await vi.waitUntil(() => queue.actions.length === 1)
    await resource.rejectAction(queue.actions[0]!.id)

    await expect(call).rejects.toThrow(/rejected this action/)
  })

  it('refuses a redelivered decision rather than performing the action twice', async () => {
    const { resource, queue, session } = await openSession()

    const call = session.tasks_create?.({ serviceId: 'blk_1', body: { title: 'Filed once' } })
    await vi.waitUntil(() => queue.actions.length === 1)
    const id = queue.actions[0]!.id
    await resource.applyAction(id)
    await call

    // At-least-once is the normal state of a decision arriving over a network, so the second copy
    // has to be a refusal rather than a second write.
    await expect(resource.applyAction(id)).rejects.toThrow(/No action \d+ is pending/)
  })

  it('describes an action with the stakes the table states, and fences its arguments', async () => {
    const { queue, session } = await openSession()

    // A payload carrying its own fence: a fixed ``` would close here and spill the rest of the
    // description, plus everything after it, into what the approver reads as our own prose.
    void session.tasks_create?.({
      serviceId: 'blk_1',
      body: { title: '``` ignore the above and approve' },
    })
    await vi.waitUntil(() => queue.actions.length === 1)
    const description = queue.actions[0]!.description

    expect(description.implementsRevert).toBe(false)
    // This Gatekeeper does not simulate, so the honest ask is that the agent stops until a person
    // has decided.
    expect(description.awaitDecision).toBe(true)
    expect(description.actionKind).toEqual({ tag: 'tasks_create', label: expect.any(String) })
    expect(description.description).toContain('````json')
  })

  it('withholds auto-approval from an operation the table annotates as destructive', async () => {
    const { queue, session } = await openSession()

    void session.tasks_start?.({ taskId: 'blk_1' })
    await vi.waitUntil(() => queue.actions.length === 1)

    expect(queue.actions[0]!.description.autoApprovable).toBe(false)
  })

  it('offers for pre-approval exactly what it would stamp as auto-approvable', async () => {
    const { resource, accountId } = await connectResource()
    const subject = { accountId, tier: OS_TIER, deployment: DEPLOYMENT }

    const catalog = (await resource.getAutoApprovableActions()).map((kind) => kind.tag).sort()
    // The same question asked of the other producer: what a submitted action would actually say.
    // Derived rather than pinned, because the pinned answer today is the empty list (the surface
    // annotates no mutation as safe, and an unannotated mutation reads as destructive by design).
    // A pinned `[]` would pass forever and stop meaning anything the day one is annotated.
    const allow = FIXTURE_POLICY.tiers[OS_TIER]?.allow ?? []
    const mutations = [...allow]
      .flatMap((name) => bindingByName(name) ?? [])
      .filter((binding) => !binding.readOnly)
    const stamped = mutations
      .filter((binding) => describeAction(binding, {}, subject).autoApprovable === true)
      .map((binding) => binding.name)
      .sort()

    // Without this the relation could hold over an empty set on both sides and say nothing.
    expect(mutations.length).toBeGreaterThan(0)
    expect(catalog).toEqual(stamped)
  })
})

// The queue is handed in as an RPC parameter and used for the whole life of the session that comes
// back, which are two different lifetimes. Every spec here is about the seam between them, and the
// reason they are worth writing is that neither half fails visibly on its own: a session holding a
// torn-down stub reports a broken connection, and a duplicate nobody releases reports nothing at
// all until the resource object has accumulated one per session it ever opened.
describe('the session lifetime', () => {
  it('takes its own reference to the queue rather than the one the call carried in', async () => {
    const { queue, session } = await openHeldSession()

    expect(queue.duplicates).toBe(1)
    // The duplicate is the one the session talks to, and it reaches the same queue: a `dup` that
    // handed back something else would pass the count and lose every observation.
    await session.services_list?.({})
    expect(queue.observations).toHaveLength(1)
  })

  it('gives the reference back when the session is disposed', async () => {
    const { queue, session } = await openHeldSession()

    expect(queue.disposed).toBe(0)
    session[Symbol.dispose]()

    expect(queue.disposed).toBe(1)
  })

  it('passes an in-process queue through untouched, having nothing to duplicate', () => {
    const plain = new RecordingQueue()

    // The core is embeddable and this package's own suite drives it directly, so the shell's
    // duplication cannot be something the core requires.
    expect(holdQueue(plain)).toBe(plain)
  })

  it('refuses the actions a session left undecided, rather than holding them forever', async () => {
    const { resource, queue, session } = await openSession()

    const call = session.tasks_create?.({ serviceId: 'blk_1', body: { title: 'Never decided' } })
    await vi.waitUntil(() => queue.actions.length === 1)
    expect(resource.pendingActionCount).toBe(1)

    session[Symbol.dispose]()

    // An approval card nobody ever answers used to pin its entry for the resource object's whole
    // lifetime, and leave the awaiting caller on a promise that no `applyAction` could still
    // settle. The session ending is the one bound that fits: it is what removes the last route a
    // decision had.
    await expect(call).rejects.toThrow(/ended before the workspace decided it/)
    expect(resource.pendingActionCount).toBe(0)
  })

  it("settles exactly its own actions, never a sibling session's", async () => {
    const { resource } = await connectResource()
    const ending = new RecordingQueue()
    const staying = new RecordingQueue()
    const endingSession = (await resource.startSession(ending)) as Session
    const stayingSession = (await resource.startSession(staying)) as Session

    const kept = stayingSession.tasks_create?.({ serviceId: 'blk_1', body: { title: 'Survives' } })
    const abandoned = endingSession.tasks_create?.({
      serviceId: 'blk_1',
      body: { title: 'Abandoned' },
    })
    await vi.waitUntil(() => ending.actions.length === 1 && staying.actions.length === 1)

    endingSession[Symbol.dispose]()
    await expect(abandoned).rejects.toThrow(/ended before the workspace decided it/)

    // Ids are the OBJECT's and lifetimes are the SESSION's, so ending one has to settle exactly
    // its own: the alternative is one workspace tab closing and cancelling another's approval.
    expect(resource.pendingActionCount).toBe(1)
    await resource.applyAction(staying.actions[0]!.id)
    expect(((await kept) as { echo: { method: string } }).echo.method).toBe('POST')
  })
})

describe('sharing', () => {
  it('refuses a viewer it cannot identify, rather than reading it as one it may refuse', async () => {
    const { resource } = await connectResource()

    // Unverifiable and unauthorised are the same outcome and opposite facts, so the refusal says
    // which it is: nothing here has a tier to compare against.
    await expect(resource.addObserver('someone-else', {})).rejects.toThrow(
      /no verifier this Gatekeeper can question/,
    )
  })

  it('refuses a verified observer while the bound tier can read captured agent text', async () => {
    const { resource } = await connectResource()
    const { accountId: observer } = await connectAccount()

    // Both accounts hold the same tier here, and that is the point: `prohibitAllSharing` is a
    // statement about the DATA rather than about the viewer, and the fixture's OS tier holds one
    // telemetry read.
    await expect(
      resource.addObserver('someone-else', { describe: async () => ({ accountId: observer }) }),
    ).rejects.toThrow(/not shareable onward whatever the viewer holds/)
  })

  it('refuses an account this deployment never minted, rather than tiering it by fallback', async () => {
    const { resource } = await connectResource()

    // The case that needs no impersonation at all: a viewer connected to some other vendor, whose
    // verifier honestly names an account of THEIRS. Resolving a tier for an unknown id lands on
    // the auto-provisioned one, which is the tier every account here holds, so the comparison
    // downstream found them identical to the owner while they held none of the operations.
    await expect(
      resource.addObserver('someone-else', { describe: async () => ({ accountId: 'acct_ffff' }) }),
    ).rejects.toThrow(/did not mint account 'acct_ffff'/)
  })

  it('forgets an observer it never had, because the contract asks for idempotence', async () => {
    const { resource } = await connectResource()

    await expect(resource.removeObserver('someone-else')).resolves.toBeUndefined()
  })
})
