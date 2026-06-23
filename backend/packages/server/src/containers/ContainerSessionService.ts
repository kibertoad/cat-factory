import { HmacSigner, TOKEN_AUDIENCE } from '../auth/signing.js'

// Short-lived, signed session token handed to an implementation container so it
// can call the LLM proxy on behalf of one run — without ever holding a provider
// API key. The proxy verifies the token and forwards to the token-locked
// provider/model, so a container cannot pick an arbitrary (more expensive) model
// or call the proxy for a different workspace. Built on the same HMAC primitive as
// the auth session token (the deployment's session secret).

/** Claims carried by a container session token. */
export interface ContainerSession {
  /** Audience pin — always `llm-proxy`; rejected by the user-session verifier. */
  aud: typeof TOKEN_AUDIENCE.container
  /** Workspace the run belongs to (spend is metered against it). */
  workspaceId: string
  /**
   * The workspace's owning account id, so the proxy can lease an account-scoped API
   * key from the merged pool. Absent for a legacy/unscoped workspace.
   */
  accountId?: string
  /**
   * The run initiator's `usr_*` id, so the proxy can also lease the initiator's own
   * user-scoped API keys. Absent for system-initiated runs.
   */
  userId?: string
  /** Execution instance id (links proxied usage to the run). */
  executionId: string
  /** Agent kind performing the work, for the spend ledger. */
  agentKind: string
  /** Locked upstream provider id (e.g. `qwen`, `deepseek`, `moonshot`). */
  provider: string
  /** Locked upstream model id (e.g. `qwen3-max`). */
  model: string
  /** Absolute expiry, epoch ms. */
  exp: number
}

/**
 * Default session lifetime. Must clear the harness job watchdog ceiling
 * (`JOB_MAX_DURATION_MS`, default 60 min) PLUS the dispatch→container-boot lead
 * (the token is minted at dispatch, before Pi starts), or a long but healthy step
 * 401s mid-run once the token expires while the watchdog still considers it alive.
 * 90 min = 60 min job + ~10 min boot lead + margin. The token is tightly scoped
 * (audience `llm-proxy`, one workspace, one execution, locked provider+model), so a
 * longer life is a small risk increase: a leak can only spend that run's metered
 * budget on that one model. If you raise `JOB_MAX_DURATION_MS`, raise this too.
 */
export const DEFAULT_SESSION_TTL_MS = 90 * 60 * 1000

export interface MintInput {
  workspaceId: string
  accountId?: string | null
  userId?: string | null
  executionId: string
  agentKind: string
  provider: string
  model: string
  /** Override the default TTL (ms). */
  ttlMs?: number
}

export class ContainerSessionService {
  private readonly signer: HmacSigner
  private readonly now: () => number

  constructor({ secret, now }: { secret: string; now?: () => number }) {
    this.signer = new HmacSigner(secret)
    this.now = now ?? (() => Date.now())
  }

  /** Mint a signed token for one run. */
  mint(input: MintInput): Promise<string> {
    const session: ContainerSession = {
      aud: TOKEN_AUDIENCE.container,
      workspaceId: input.workspaceId,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
      executionId: input.executionId,
      agentKind: input.agentKind,
      provider: input.provider,
      model: input.model,
      exp: this.now() + (input.ttlMs ?? DEFAULT_SESSION_TTL_MS),
    }
    return this.signer.sign(session)
  }

  /**
   * Verify a bearer token, returning its claims or null when invalid/expired.
   * Pins the `llm-proxy` audience so a user session token (same secret) cannot
   * be used to drive the proxy, and vice-versa.
   */
  verify(token: string | null | undefined): Promise<ContainerSession | null> {
    return this.signer.verify<ContainerSession>(token, { aud: TOKEN_AUDIENCE.container })
  }
}
