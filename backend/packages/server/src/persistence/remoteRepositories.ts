import type {
  AccountRepository,
  BlockRepository,
  ExecutionRepository,
  MembershipRepository,
  PipelineRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import {
  type PersistenceRpcRequest,
  type PersistenceRpcResponse,
  persistenceErrorToThrowable,
} from './rpc.js'

// The client side of the mothership-mode persistence RPC: a mothership-mode local node
// builds these `Proxy`-backed repositories instead of Drizzle ones, so every repository
// call the engine makes is forwarded to the hosted mothership over `POST /internal/persistence`.
// Each entry mirrors a kernel repository port exactly; the Proxy turns any `repo.method(...args)`
// into one RPC and applies the wire contract: re-throw `DomainError`s, restore a top-level
// `undefined`, and write a mutated `rev` back onto the caller's object (the optimistic-
// concurrency contract `ExecutionRepository.compareAndSwap`/`upsert` depend on).

/** Transport that performs one persistence call and returns the decoded envelope. */
export interface PersistenceRpcClient {
  call(request: PersistenceRpcRequest): Promise<PersistenceRpcResponse>
}

/** The repository subset a mothership-mode node resolves remotely in the pilot. */
export interface RemoteRepositories {
  workspaceRepository: WorkspaceRepository
  blockRepository: BlockRepository
  pipelineRepository: PipelineRepository
  executionRepository: ExecutionRepository
  accountRepository: AccountRepository
  membershipRepository: MembershipRepository
}

function makeRepoProxy<T extends object>(client: PersistenceRpcClient, repo: string): T {
  return new Proxy(
    {},
    {
      get(_target, method: string) {
        return async (...args: unknown[]) => {
          const res = await client.call({ repo, method, args })
          if (!res.ok) throw persistenceErrorToThrowable(res.error)
          // Restore an in-place `rev` bump (e.g. execution upsert/compareAndSwap), so the
          // caller's instance reflects the stored row exactly as a direct repo would.
          if (res.mutated) {
            const target = args[res.mutated.arg] as { rev?: number } | undefined
            if (target) target.rev = res.mutated.rev
          }
          return res.undef ? undefined : res.value
        }
      },
    },
  ) as T
}

/**
 * Build the remote-backed repository set for a mothership-mode node. Each repo is a thin
 * Proxy over the one persistence transport; no per-method code, so it can never drift from
 * the kernel port signatures it implements.
 */
export function createRemoteRepositories(client: PersistenceRpcClient): RemoteRepositories {
  return {
    workspaceRepository: makeRepoProxy<WorkspaceRepository>(client, 'workspaceRepository'),
    blockRepository: makeRepoProxy<BlockRepository>(client, 'blockRepository'),
    pipelineRepository: makeRepoProxy<PipelineRepository>(client, 'pipelineRepository'),
    executionRepository: makeRepoProxy<ExecutionRepository>(client, 'executionRepository'),
    accountRepository: makeRepoProxy<AccountRepository>(client, 'accountRepository'),
    membershipRepository: makeRepoProxy<MembershipRepository>(client, 'membershipRepository'),
  }
}

/**
 * A fetch-based {@link PersistenceRpcClient} that posts to the mothership's
 * `POST /internal/persistence`, presenting the node's machine token. The endpoint always
 * returns the wire envelope (even on a 4xx/5xx), so the body is read regardless of status.
 */
export class HttpPersistenceRpcClient implements PersistenceRpcClient {
  constructor(
    private readonly opts: {
      baseUrl: string
      token: string
      fetchImpl?: typeof fetch
    },
  ) {}

  async call(request: PersistenceRpcRequest): Promise<PersistenceRpcResponse> {
    const fetchImpl = this.opts.fetchImpl ?? fetch
    const res = await fetchImpl(`${this.opts.baseUrl.replace(/\/$/, '')}/internal/persistence`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.token}`,
      },
      body: JSON.stringify(request),
    })
    const body = (await res.json().catch(() => null)) as PersistenceRpcResponse | null
    if (body && typeof body === 'object' && 'ok' in body) return body
    // A transport-level failure with no envelope (network / proxy error): surface as internal.
    return {
      ok: false,
      error: { code: 'internal', message: `persistence RPC failed (HTTP ${res.status})` },
    }
  }
}
