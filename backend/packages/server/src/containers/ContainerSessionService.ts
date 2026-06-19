import { HmacSigner, TOKEN_AUDIENCE } from '../auth/signing'

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

/** Default session lifetime: long enough for a coding run, short enough to bound risk. */
export const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000

export interface MintInput {
  workspaceId: string
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
